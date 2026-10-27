/**
 * s17: Autonomous Agents — WORK / IDLE / SHUTDOWN 自主工作者状态机
 *
 * 本章机制：
 *   - scanUnclaimedTasks：扫描 pending + 未认领 + 依赖已满足 的任务
 *   - IdlePoll：空闲轮询（默认 5s 间隔 / 60s 超时），命中 inbox 或任务板则回 WORK
 *   - claimTask：owner 检查 + canStart 依赖检查
 *   - 队友生命周期：WORK → IDLE → SHUTDOWN
 *   - 依赖 owner 的任务归属（owner 持久化在 .tasks/s17/*.json）
 *
 * 这是一个**真实的工作者状态机**，状态全部落在文件与注册表里，不靠全局变量传递：
 *   WORK  — 读信箱（真 JSONL）→ Chat（mock 只替换模型调用）→ 派发工具
 *   IDLE  — 由 worker 自己的循环调用 IdlePoll Effect：真 sleep，逐轮读信箱 + 扫任务板；
 *           任务板有可认领任务就真认领并回 WORK，超时才 SHUTDOWN
 *   SHUTDOWN — 退出子循环，把最终摘要经信箱回报给 lead
 * autoClaim 自己扫描并认领第一个合格任务，不依赖任何全局变量。
 *
 * 三个自主机制 Effect：
 *   IdlePoll      — 空闲等待：真轮询 + 真扫描 + 真认领，返回 work/shutdown
 *   ScanUnclaimed — 扫描可认领任务（pending + 无 owner + canStart）
 *   AutoClaim     — 主动认领第一个能做的任务（检查 owner 和依赖）
 *
 * 三个辅助 Effect：
 *   RequestShutdown — Lead 请求 worker 优雅退出（request_id 关联 shutdown_response）
 *   WaitForTeammates — Lead 回合结束后由宿主最多等一段固定时间，等活跃队友结束（不暴露给模型）
 *   ReleaseTask     — worker 退出前把未完成的 in_progress 任务放回任务板（不暴露给模型）
 *
 * 路径来自 runtime/workspace.ts（本章自己的 .tasks/s17/ 和 .mailboxes/s17/）。
 */

import { runAgent } from '../runtime/core.ts';
import type { Effect, EffectHandlers, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, TaskRecord, ToolResultBlock } from '../runtime/types.ts';
import { extractText, getToolUseBlocks, messageText } from '../runtime/response.ts';
import { callChat } from '../runtime/model.ts';
import type { ToolSchema } from '../runtime/model.ts';
import { schemasFor, specFor } from '../runtime/tool-schemas.ts';
import { buildSystemPrompt } from '../runtime/system-prompt.ts';
import { describeMode, loadEnvOnce, resolveMode } from '../runtime/env.ts';
import { settleActiveWithin } from '../runtime/wait.ts';
import { truncate } from '../runtime/text.ts';
import { TASKS_DIR, MAILBOXES_DIR } from '../runtime/workspace.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// Part 0: 常量（默认 5s 轮询 / 60s 超时）
// ============================================================

// 先加载 .env，下面按模式读取的超时/env 覆盖才会生效。
loadEnvOnce();

const LEAD_ID = 'main';      // lead 的 mailbox 名
const WORKER_ID = 'worker';  // 自主工作者
const OWNED_TASK_ID = 'task_owned_by_lead'; // 预置的"别人持有"任务，用于演示认领阶段的 owner 检查
const OWNED_ACTIVE_TASK_ID = 'task_owned_by_lead_active'; // 预置的"别人执行中"任务，用于演示完成阶段的 owner 检查

// 本章自己的信箱和任务板目录：不和 s15/s16/s20 共享同一层。
const S17_MAILBOX_DIR = path.join(MAILBOXES_DIR, 's17');
const S17_TASKS_DIR = path.join(TASKS_DIR, 's17');
const MAX_TOKENS = Number(process.env.S17_MAX_TOKENS) || 4096;

const MAX_WORK_ITERATIONS = 10; // WORK 阶段最多 10 个工作轮
const MAX_END_TURN_DRAINS = 3;  // Lead 回合结束后最多再注入几轮队友消息
const MAX_RESUME_NUDGES = 3;    // 模型提前结束回合时，最多提醒几次“先完成自己的任务”
const MAX_RESUME_CYCLES = 3;    // IDLE 恢复未完成任务的次数上限，避免模型一直不做导致空转

// 默认：5s 轮询间隔 / 60s 空闲超时。
const IDLE_POLL_INTERVAL_MS_DEFAULT = 5000;
const IDLE_TIMEOUT_MS_DEFAULT = 60000;
// 演示用快速值：mock 模式让轮询间隔/超时缩到秒级以下，真实运行仍用上面的默认值。
// 可用 S17_IDLE_POLL_INTERVAL_MS / S17_IDLE_TIMEOUT_MS 覆盖。
const DEMO_FAST = resolveMode() !== 'real';
const IDLE_POLL_INTERVAL_MS =
  Number(process.env.S17_IDLE_POLL_INTERVAL_MS) || (DEMO_FAST ? 20 : IDLE_POLL_INTERVAL_MS_DEFAULT);
const IDLE_TIMEOUT_MS =
  Number(process.env.S17_IDLE_TIMEOUT_MS) || (DEMO_FAST ? 200 : IDLE_TIMEOUT_MS_DEFAULT);
// Lead 回合结束后等待活跃队友的上限；real 默认要覆盖 60s 空闲超时。
const JOIN_TIMEOUT_MS =
  Number(process.env.S17_JOIN_TIMEOUT_MS) || (DEMO_FAST ? 5_000 : 90_000);
const CLEANUP_WAIT_MS =
  Number(process.env.S17_CLEANUP_WAIT_MS) || (DEMO_FAST ? 1_000 : 3_000);

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

interface ChatEffect extends Effect<'Chat', { messages: Message[]; agentId: string }, LLMResponse> {}

interface BashExecEffect extends Effect<'BashExec', { command: string }, string> {}

/** 一条信箱消息的结构：from / to / body / type / timestamp / metadata。 */
interface AgentMessage {
  from: string;
  to: string;
  body: string;
  type: string;
  timestamp: number;
  metadata: Record<string, unknown>;
}

interface SendMessageEffect extends Effect<'SendMessage', { from: string; to: string; body: string; kind?: string; metadata?: Record<string, unknown> }, { messageId: string }> {}

interface CheckInboxEffect extends Effect<'CheckInbox', { agentId: string }, AgentMessage[]> {}

interface SpawnTeammateEffect extends Effect<'SpawnTeammate', { agentId: string; role: string }, { agentId: string; status: 'spawned' }> {}

// ── 任务工具（scan / claim / complete / release）──
type ClaimOutcome = { task: TaskRecord | null; success: boolean; reason?: string };

type CompleteOutcome =
  | { task: TaskRecord; success: true; unblocked: TaskRecord[] }
  | { task: null; success: false; reason: string; unblocked: [] };

type ReleaseOutcome = { released: boolean; reason?: string };

interface ScanUnclaimedEffect extends Effect<'ScanUnclaimed', Record<string, never>, TaskRecord[]> {}

interface AutoClaimEffect extends Effect<'AutoClaim', { owner: string }, ClaimOutcome> {}

interface ClaimTaskEffect extends Effect<'ClaimTask', { taskId: string; owner: string }, ClaimOutcome> {}

interface CompleteTaskEffect extends Effect<'CompleteTask', { taskId: string; owner: string }, CompleteOutcome> {}

/** worker 退出前归还自己名下未完成的任务；不暴露给模型。 */
interface ReleaseTaskEffect extends Effect<'ReleaseTask', { taskId: string; owner: string }, ReleaseOutcome> {}

interface ListTasksEffect extends Effect<'ListTasks', Record<string, never>, TaskRecord[]> {}

// ── s17 核心：IdlePoll 的返回（真实状态机转换的依据）──
type IdleOutcome = {
  state: 'work' | 'shutdown';
  /** resume：自己名下还有未完成任务，先恢复它，不认领新任务。 */
  trigger: 'inbox' | 'claimed' | 'resume' | 'timeout';
  inbox?: AgentMessage[];
  task?: TaskRecord | null;
};

interface IdlePollEffect
  extends Effect<'IdlePoll', { agentId: string; pollIntervalMs: number; reason?: string }, IdleOutcome> {}

/** Lead 请求 worker 优雅退出；不阻塞等待响应，响应在收信时按 request_id 关联。 */
interface RequestShutdownEffect
  extends Effect<'RequestShutdown', { agentId: string; reason?: string }, { requestId: string; delivered: boolean; reason?: string }> {}

/** Lead 回合结束后等活跃队友；返回超时后仍在运行的 agentId。不暴露给模型。 */
interface WaitForTeammatesEffect
  extends Effect<'WaitForTeammates', { timeoutMs: number }, string[]> {}

type S17Effect =
  | ChatEffect
  | BashExecEffect
  | SendMessageEffect
  | CheckInboxEffect
  | SpawnTeammateEffect
  | ScanUnclaimedEffect
  | AutoClaimEffect
  | ClaimTaskEffect
  | CompleteTaskEffect
  | ReleaseTaskEffect
  | ListTasksEffect
  | IdlePollEffect
  | RequestShutdownEffect
  | WaitForTeammatesEffect;

// ============================================================
// Part 2: 真实任务存储（文件持久化 + 依赖/归属检查）
// ============================================================

function ensureTasksDir(): void {
  fs.mkdirSync(S17_TASKS_DIR, { recursive: true });
}

/** 只重置本章任务目录；共享 .tasks/ 根目录和其它章节的任务不动。 */
function resetS17TaskDir(): void {
  fs.rmSync(S17_TASKS_DIR, { recursive: true, force: true });
  fs.mkdirSync(S17_TASKS_DIR, { recursive: true });
}

function taskPath(taskId: string): string {
  return path.join(S17_TASKS_DIR, `${taskId}.json`);
}

function loadTask(taskId: string): TaskRecord | null {
  const file = taskPath(taskId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as TaskRecord;
  } catch {
    return null;
  }
}

function saveTask(task: TaskRecord): void {
  ensureTasksDir();
  fs.writeFileSync(taskPath(task.id), JSON.stringify(task, null, 2), 'utf8');
}

/** 扫描 .tasks/task_*.json，按 id 排序。 */
function listTasks(): TaskRecord[] {
  ensureTasksDir();
  return fs
    .readdirSync(S17_TASKS_DIR)
    .filter((f) => /^task_.*\.json$/.test(f))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(S17_TASKS_DIR, f), 'utf8')) as TaskRecord;
      } catch {
        return null;
      }
    })
    .filter((t): t is TaskRecord => t !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** 所有 blockedBy 依赖都存在且已完成时才能启动（缺失依赖视为阻塞）。 */
function canStart(taskId: string): boolean {
  const task = loadTask(taskId);
  if (!task) return false;
  return task.blockedBy.every((depId) => {
    const dep = loadTask(depId);
    return dep !== null && dep.status === 'completed';
  });
}

/** 未认领的可执行任务：pending + 无 owner + 依赖已满足。 */
function scanUnclaimedTasks(): TaskRecord[] {
  return listTasks().filter(
    (t) => t.status === 'pending' && !t.owner && canStart(t.id),
  );
}

/** 某个工作者自己名下、尚未完成的任务；用于防止把它永久搁置。 */
function unfinishedTaskFor(owner: string): TaskRecord | undefined {
  return listTasks().find((t) => t.owner === owner && t.status === 'in_progress');
}

/** 认领：仅 pending 可认领；已有 owner 则拒绝；依赖未满足则拒绝。 */
function claimTask(taskId: string, owner: string): ClaimOutcome {
  const task = loadTask(taskId);
  if (!task) return { task: null, success: false, reason: `Task ${taskId} not found` };
  if (task.status !== 'pending') {
    return { task: null, success: false, reason: `Task ${taskId} is ${task.status}, cannot claim` };
  }
  if (task.owner) {
    return { task: null, success: false, reason: `Task ${taskId} already owned by ${task.owner}` };
  }
  if (!canStart(taskId)) {
    const blocked = task.blockedBy.filter((d) => loadTask(d)?.status !== 'completed');
    return { task: null, success: false, reason: `Cannot start — blocked by: ${blocked.join(', ')}` };
  }
  // 一次只做一件事：自己还有 in_progress 任务时，先完成它，不要继续认领新的。
  const unfinished = unfinishedTaskFor(owner);
  if (unfinished) {
    return {
      task: null,
      success: false,
      reason: `已有未完成任务 ${unfinished.id}: ${unfinished.subject}，请先完成它再认领新任务`,
    };
  }
  task.owner = owner;
  task.status = 'in_progress';
  saveTask(task);
  return { task, success: true };
}

/** 完成：只有 in_progress 的任务能完成；且 owner 必须匹配（一个工作者只处理自己认领的任务）。 */
function completeTask(taskId: string, owner: string): CompleteOutcome {
  const task = loadTask(taskId);
  if (!task) return { task: null, success: false, reason: `Task ${taskId} not found`, unblocked: [] };
  if (task.status !== 'in_progress') {
    return { task: null, success: false, reason: `Task ${taskId} is ${task.status}, cannot complete`, unblocked: [] };
  }
  if (!task.owner || task.owner !== owner) {
    return { task: null, success: false, reason: `Task ${taskId} is owned by ${task.owner ?? '(none)'}, not ${owner}`, unblocked: [] };
  }
  task.status = 'completed';
  saveTask(task);
  const unblocked = listTasks().filter(
    (t) => t.status === 'pending' && t.blockedBy.includes(taskId) && canStart(t.id),
  );
  return { task, success: true, unblocked };
}

/** 归还：把自己认领但尚未完成的任务放回任务板，供之后的 worker 重新认领。 */
function releaseTask(taskId: string, owner: string): ReleaseOutcome {
  const task = loadTask(taskId);
  if (!task) return { released: false, reason: `Task ${taskId} not found` };
  if (task.status !== 'in_progress') {
    return { released: false, reason: `Task ${taskId} is ${task.status}, cannot release` };
  }
  if (!task.owner || task.owner !== owner) {
    return {
      released: false,
      reason: `Task ${taskId} is owned by ${task.owner ?? '(none)'}, not ${owner}`,
    };
  }
  task.status = 'pending';
  task.owner = null;
  saveTask(task);
  return { released: true };
}

/** 主动认领：先扫描，再认领第一个能做的任务（真的扫描、真的认领，不依赖全局变量）。 */
function autoClaim(owner: string): ClaimOutcome {
  const unclaimed = scanUnclaimedTasks();
  if (unclaimed.length === 0) {
    return { task: null, success: false, reason: 'No unclaimed tasks' };
  }
  return claimTask(unclaimed[0].id, owner);
}

// ============================================================
// Part 3: MessageBus —— 真实 JSONL 信箱（.mailboxes/*.jsonl）
// ============================================================

// 队友名会拼进信箱文件名，先按白名单校验字符。
const VALID_AGENT_ID = /^[A-Za-z0-9._-]{1,64}$/;

function validateAgentId(agentId: string): void {
  if (agentId === '.' || agentId === '..' || !VALID_AGENT_ID.test(agentId)) {
    throw new Error(`非法队友名: '${agentId}'（只允许字母、数字、点、下划线、短横线，1-64 字符）`);
  }
}

function resetS17MailboxDir(): void {
  fs.rmSync(S17_MAILBOX_DIR, { recursive: true, force: true });
  fs.mkdirSync(S17_MAILBOX_DIR, { recursive: true });
}

/** 解析一行信箱 JSON；字段不全或损坏时告警并跳过，避免一条坏行打断整个循环。 */
function parseInboxLine(line: string): AgentMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    console.warn(`[bus] 忽略损坏的信箱行: ${truncate(line, 80)}`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    console.warn(`[bus] 忽略非对象的信箱行: ${truncate(line, 80)}`);
    return null;
  }
  const raw = parsed as Record<string, unknown>;
  if (
    typeof raw['from'] !== 'string' ||
    typeof raw['to'] !== 'string' ||
    typeof raw['body'] !== 'string' ||
    typeof raw['type'] !== 'string'
  ) {
    console.warn(`[bus] 忽略字段不完整的信箱行: ${truncate(line, 80)}`);
    return null;
  }
  const metadata = raw['metadata'];
  return {
    from: raw['from'],
    to: raw['to'],
    body: raw['body'],
    type: raw['type'],
    timestamp: Number(raw['timestamp']) || 0,
    metadata:
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : {},
  };
}

/**
 * 文件消息总线：每个 Agent 一个 `.jsonl` 信箱，一行一条 JSON 消息。
 *   send()       —— append 一行（真实追加写）
 *   readInbox()  —— 读出全部行并清空（消费式读取）
 */
class MessageBus {
  private seq = 0;

  constructor() {
    resetS17MailboxDir();
  }

  private inboxPath(agentId: string): string {
    validateAgentId(agentId);
    return path.join(S17_MAILBOX_DIR, `${agentId}.jsonl`);
  }

  /** 预先创建空信箱文件，方便在目录里看到完整布局。 */
  ensureInbox(agentId: string): void {
    const p = this.inboxPath(agentId);
    if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf8');
  }

  async send(
    from: string,
    to: string,
    body: string,
    type = 'message',
    metadata: Record<string, unknown> = {},
  ): Promise<string> {
    fs.mkdirSync(S17_MAILBOX_DIR, { recursive: true });
    const msg: AgentMessage = { from, to, body, type, timestamp: Date.now(), metadata };
    fs.appendFileSync(this.inboxPath(to), JSON.stringify(msg) + '\n', 'utf8');
    const messageId = `msg_${Date.now()}_${++this.seq}`;
    console.log(`  \x1b[33m[bus] ${from} → ${to}: (${type}) ${truncate(body, 50)}\x1b[0m`);
    return messageId;
  }

  /** 消费式读取：读出全部消息后把文件清空为 0 字节。 */
  async readInbox(agentId: string): Promise<AgentMessage[]> {
    const p = this.inboxPath(agentId);
    if (!fs.existsSync(p)) return [];
    const msgs: AgentMessage[] = [];
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const msg = parseInboxLine(line);
      if (msg) msgs.push(msg);
    }
    fs.writeFileSync(p, '', 'utf8');
    return msgs;
  }
}

const BUS = new MessageBus();
BUS.ensureInbox(LEAD_ID);
BUS.ensureInbox(WORKER_ID);

let shutdownSeq = 0;

/** 生成带前缀和递增序号的 request_id；只由宿主生成，不接受模型传入。 */
function newShutdownRequestId(): string {
  return `req_shutdown_${Date.now()}_${++shutdownSeq}`;
}

/** Lead 发出的关机请求；响应到达时按 request_id 关联。 */
const pendingShutdowns = new Map<string, { agentId: string; status: 'pending' | 'approved' | 'rejected' }>();

/** 在 Lead 收信时把 shutdown_response 关联回对应的请求。 */
function recordShutdownResponses(msgs: AgentMessage[]): void {
  for (const m of msgs) {
    if (m.type !== 'shutdown_response') continue;
    const requestId = typeof m.metadata['request_id'] === 'string' ? m.metadata['request_id'] : '';
    const pending = pendingShutdowns.get(requestId);
    if (!pending) {
      console.log(`  \x1b[31m[protocol] unknown shutdown request_id: ${requestId || '(missing)'}\x1b[0m`);
      continue;
    }
    if (pending.agentId !== m.from) {
      console.log(
        `  \x1b[31m[protocol] shutdown responder mismatch: expected ${pending.agentId}, got ${m.from}\x1b[0m`,
      );
      continue;
    }
    const approved = m.metadata['approve'] !== false;
    pending.status = approved ? 'approved' : 'rejected';
    console.log(
      `  \x1b[35m[protocol] ${m.from} ${approved ? 'approved' : 'rejected'} shutdown (${requestId})\x1b[0m`,
    );
  }
}

/** 把信箱消息格式化成模型可读文本；request_id 也一并带上。 */
function formatInbox(messages: AgentMessage[]): string {
  return messages
    .map((m) => {
      const requestId =
        typeof m.metadata['request_id'] === 'string' ? ` (${m.metadata['request_id']})` : '';
      return `From ${m.from} [${m.type}]${requestId}: ${m.body}`;
    })
    .join('\n');
}

// ============================================================
// Part 4: Mock LLM —— 只替换模型调用；状态机/轮询/认领都是真代码
// ============================================================

const turnCounters = new Map<string, number>();

function nextTurn(agentId: string): number {
  const n = turnCounters.get(agentId) ?? 0;
  turnCounters.set(agentId, n + 1);
  return n;
}

const text = (t: string) => ({ type: 'text' as const, text: t });
const tool = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'tool_use' as const,
  id,
  name,
  input,
});

/** 已完成/已认领任务的正则（真实模型同样是从 tool_result 文本里读到 ID 再使用）。 */
const CLAIMED_RE = /Claimed (task_\w+)/g;
const COMPLETED_RE = /Completed (task_\w+)/g;
const AUTO_CLAIMED_RE = /<auto-claimed>Task (task_\w+):/g;

/** 找出所有"已认领但尚未完成"的任务，按出现顺序返回第一个。 */
function unfinishedWork(messages: Message[]): string | undefined {
  const claimed = new Set<string>();
  const completed = new Set<string>();
  for (const message of messages) {
    const s = typeof message.content === 'string' ? message.content : messageText(message.content);
    for (const match of s.matchAll(CLAIMED_RE)) claimed.add(match[1]);
    for (const match of s.matchAll(AUTO_CLAIMED_RE)) claimed.add(match[1]);
    for (const match of s.matchAll(COMPLETED_RE)) completed.add(match[1]);
  }
  return [...claimed].find((id) => !completed.has(id));
}

/** 从对话里收集已完成的任务 ID，用于 worker 退出摘要。 */
function completedTaskIds(messages: Message[]): string[] {
  const completed = new Set<string>();
  for (const message of messages) {
    const s = typeof message.content === 'string' ? message.content : messageText(message.content);
    for (const match of s.matchAll(COMPLETED_RE)) completed.add(match[1]);
  }
  return [...completed];
}

/** 汇总已完成任务、退出前归还的任务和模型最后一段文本。 */
function buildWorkerSummary(finalText: string, completed: string[], releaseNote?: string): string {
  const parts: string[] = [];
  if (completed.length > 0) parts.push(`已完成任务: ${completed.join(', ')}。`);
  if (releaseNote) parts.push(releaseNote);
  if (finalText) parts.push(finalText);
  return parts.length > 0 ? parts.join(' ') : '未完成任务，已退出。';
}

/** mockLead 从对话里找最后一条队友 result（check_inbox 工具结果或注入的 inbox）。 */
function latestResultText(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i].content;
    const s = typeof content === 'string' ? content : messageText(content);
    const idx = s.indexOf('[result]');
    if (idx >= 0) {
      const line = s
        .slice(idx)
        .replace(/^\[result\]:\s*/, '')
        .replace(/<\/?inbox>/g, '')
        .trim();
      return truncate(line, 300);
    }
  }
  return undefined;
}

/** lead 剧本：spawn 自主工作者 → 收报告 → 结束。 */
function mockLead(messages: Message[]): LLMResponse {
  switch (nextTurn(LEAD_ID)) {
    case 0:
      return {
        stop_reason: 'tool_use',
        content: [
          text('启动一个自主工作者，让它独立扫描并认领任务。'),
          tool('l1', 'spawn_teammate', { agentId: WORKER_ID, role: '自主工作者' }),
        ],
      };
    case 1:
      return {
        stop_reason: 'tool_use',
        content: [
          text('等待并收取自主工作者的完成报告。'),
          tool('l2', 'check_inbox', {}),
        ],
      };
    default: {
      const report = latestResultText(messages);
      return {
        stop_reason: 'end_turn',
        content: [
          text(report ? `收到自主工作者的报告：${report}` : '自主工作者正在工作，等待它的报告。'),
        ],
      };
    }
  }
}

/**
 * 工作者剧本（由对话状态驱动，而非固定轮次——因为"自主工作者"应该把任务板上
 * 所有可认领任务都干完，不管板上有几个任务）：
 *   1) 有已认领未完成的任务 → 执行并完成它
 *   2) 第一轮 → 扫描 + 尝试认领别人的任务（被拒）+ 尝试完成别人的任务（被拒）+ 机会主义认领
 *   3) 否则 → end_turn，进入 IDLE 轮询；IDLE 认领到新任务会被注入 <auto-claimed>，回到 (1)
 *   没有可认领任务后 IDLE 超时 → SHUTDOWN。
 */
function mockWorker(messages: Message[]): LLMResponse {
  const pendingId = unfinishedWork(messages);
  if (pendingId) {
    return {
      stop_reason: 'tool_use',
      content: [
        text(`执行并完成认领的任务 ${pendingId}。`),
        tool(`bash_${pendingId}`, 'bash', { command: 'echo "执行任务"' }),
        tool(`done_${pendingId}`, 'complete_task', { taskId: pendingId }),
      ],
    };
  }

  if (!messages.some((m) => m.role === 'assistant')) {
    return {
      stop_reason: 'tool_use',
      content: [
        text('扫描任务板，机会主义认领一个可执行任务。'),
        tool('w1', 'scan_unclaimed', {}),
        // 故意尝试认领一个已被 lead 持有的任务 → 触发认领阶段的 owner 检查
        tool('w_owned', 'claim_task', { taskId: OWNED_TASK_ID }),
        // 故意尝试完成一个由 lead 执行中的任务 → 触发完成阶段的 owner 检查
        tool('w_owned_active', 'complete_task', { taskId: OWNED_ACTIVE_TASK_ID }),
        tool('w2', 'auto_claim', {}),
      ],
    };
  }

  return {
    stop_reason: 'end_turn',
    content: [text('本轮工作结束，进入空闲轮询。')],
  };
}

// real 模式注入 system prompt；mock 模式不读取，故零配置行为不变。
const LEAD_SYSTEM_PROMPT = buildSystemPrompt(
  '你是 lead：用 spawn_teammate 拉起自主工作者，用 check_inbox 收集它的完成报告，用 send_message 下达指令，需要提前结束时用 request_shutdown。' +
    `队友的 agentId 用 '${WORKER_ID}'。check_inbox 不等待；如果暂时没有报告，先结束回合，宿主会在队友结束后把结果注入对话。默认让 worker 空闲超时退出，不要过早请求关机。` +
    '本教学演示中 bash 是模拟的：只回显命令文本、不会真正执行，请不要依赖它的输出。',
);
const WORKER_SYSTEM_PROMPT = buildSystemPrompt(
  '你是自主工作者：主动用 scan_unclaimed 扫描任务板、用 auto_claim 机会主义认领，一次只认领一个任务，用 complete_task 完成自己拥有的任务；没有工作时结束回合，宿主会进入空闲轮询，不要空转。收到 shutdown_request 时回复 shutdown_response 并退出。' +
    '本教学演示中 bash 是模拟的：只回显命令文本、不会真正执行，请不要依赖它的输出。',
);

// 只在本章收紧共享 schema，不修改 runtime/tool-schemas.ts。
const BASH_SCHEMA: ToolSchema = {
  ...specFor('bash'),
  description: '模拟执行一条 shell 命令；只回显命令文本，不会真正执行。',
  input_schema: {
    type: 'object',
    properties: { command: { type: 'string', description: '要执行的命令' } },
    required: ['command'],
  },
};

const CHECK_INBOX_SCHEMA: ToolSchema = {
  ...specFor('check_inbox'),
  description: '读取并清空 lead 自己的信箱；不等待。回合结束时宿主会等待活跃队友并把新消息注入对话。',
  input_schema: { type: 'object', properties: {}, required: [] },
};

// 认领者由宿主固定为当前工作者，不暴露给模型。
const CLAIM_TASK_SCHEMA: ToolSchema = {
  ...specFor('claim_task'),
  description: '认领一个任务；认领者固定为当前工作者。',
  input_schema: {
    type: 'object',
    properties: { taskId: { type: 'string', description: '任务 ID' } },
    required: ['taskId'],
  },
};

const AUTO_CLAIM_SCHEMA: ToolSchema = {
  ...specFor('auto_claim'),
  description: '自动扫描并认领第一个合格任务；认领者固定为当前工作者。',
  input_schema: { type: 'object', properties: {}, required: [] },
};

const LEAD_TOOLS: ToolSchema[] = [
  BASH_SCHEMA,
  ...schemasFor('spawn_teammate', 'send_message'),
  CHECK_INBOX_SCHEMA,
  specFor('request_shutdown'),
];

const WORKER_TOOLS: ToolSchema[] = [
  BASH_SCHEMA,
  ...schemasFor('scan_unclaimed', 'list_tasks', 'complete_task', 'send_message'),
  CLAIM_TASK_SCHEMA,
  AUTO_CLAIM_SCHEMA,
];

// ============================================================
// Part 5: 队友子循环 —— 真实 WORK/IDLE/SHUTDOWN 状态机
// ============================================================

/** 活跃队友：agentId → 它那一轮运行的 Promise（稍后用来等它结束，保证进程正常收尾）。 */
const activeTeammates = new Map<string, Promise<string>>();
const teammateFailures = new Set<string>();


type WorkerState = 'WORK' | 'IDLE' | 'SHUTDOWN';

/** 把 IdlePoll 的结果注入对话（只在 IDLE 阶段调用；此时没有在途 tool_use）。 */
function applyIdleOutcome(messages: Message[], idle: IdleOutcome): void {
  if (idle.trigger === 'claimed' && idle.task) {
    messages.push({
      role: 'user',
      content: `<auto-claimed>Task ${idle.task.id}: ${idle.task.subject}</auto-claimed>`,
    });
  } else if (idle.trigger === 'resume' && idle.task) {
    messages.push({
      role: 'user',
      content:
        `<resume>继续完成你已认领但尚未完成的任务 ${idle.task.id}（${idle.task.subject}）；` +
        `不要认领新任务。任务描述：${idle.task.description}</resume>`,
    });
    console.log(`  \x1b[36m[idle] resume unfinished task ${idle.task.id}\x1b[0m`);
  } else if (idle.trigger === 'inbox' && idle.inbox) {
    const nonProtocol = idle.inbox.filter((m) => m.type === 'message');
    if (nonProtocol.length > 0) {
      messages.push({ role: 'user', content: `<inbox>${JSON.stringify(nonProtocol)}</inbox>` });
      console.log(`  \x1b[36m[idle] found inbox messages\x1b[0m`);
    }
  }
}

/**
 * 自主工作者 Agent 循环（独立 messages / 独立 generator，由 runAgent 驱动）。
 * WORK → IDLE → SHUTDOWN 由真实条件驱动：任务板是否有活、信箱是否有信、是否超时。
 */
function* autonomousWorkerLoop(perform: PerformFn<S17Effect>, agentId: string, role: string) {
  const messages: Message[] = [
    {
      role: 'user',
      content: `你是自主工作者 '${agentId}'（${role}）。主动扫描任务板、一次认领并完成一个可用任务；没有工作时结束回合，宿主会进入空闲轮询，超时或收到 shutdown 请求则退出。需要主动汇报时用 send_message 发给 lead（它的信箱是 '${LEAD_ID}'）。`,
    },
  ];

  let state: WorkerState = 'WORK';
  let finalText = '';
  let resumeNudges = 0;
  let resumeCycles = 0;

  while (true) {
    if (state === 'WORK') {
      // 消息较少时（≤3）在对话开头插入一条身份说明，确保早期轮次模型明确自己的角色。
      if (messages.length <= 3) {
        messages.unshift({
          role: 'user',
          content: `<identity>你是 '${agentId}'，角色：${role}。继续你的工作。</identity>`,
        });
      }

      let shouldShutdown = false;
      let shutdownReason: 'shutdown_request' | 'idle_timeout' = 'shutdown_request';

      for (let iteration = 0; iteration < MAX_WORK_ITERATIONS; iteration++) {
        // 真实读取并清空自己的信箱
        const inbox = yield* perform({ type: 'CheckInbox', input: { agentId } });
        for (const msg of inbox) {
          if (msg.type === 'shutdown_request') {
            const requestId =
              typeof msg.metadata['request_id'] === 'string' ? msg.metadata['request_id'] : '';
            yield* perform({
              type: 'SendMessage',
              input: {
                from: agentId,
                to: LEAD_ID,
                body: 'Shutting down gracefully.',
                kind: 'shutdown_response',
                metadata: { request_id: requestId, approve: true, responder: agentId },
              },
            });
            console.log(`  \x1b[35m[protocol] ${agentId} approved shutdown in WORK\x1b[0m`);
            shouldShutdown = true;
            shutdownReason = 'shutdown_request';
            break;
          }
        }
        if (shouldShutdown) break;

        const nonProtocol = inbox.filter((m) => m.type === 'message');
        if (nonProtocol.length > 0) {
          messages.push({ role: 'user', content: `<inbox>${JSON.stringify(nonProtocol)}</inbox>` });
        }

        const response = yield* perform({ type: 'Chat', input: { messages, agentId } });
        messages.push({ role: 'assistant', content: response.content });

        if (response.stop_reason !== 'tool_use') {
          finalText = extractText(response) || finalText;
          // 模型提前结束回合时，如果自己名下还有 in_progress 任务，先提醒它做完，
          // 不要把任务留在半成品状态后进入 IDLE 去认领新任务。
          const unfinished = unfinishedTaskFor(agentId);
          if (unfinished && resumeNudges < MAX_RESUME_NUDGES) {
            resumeNudges += 1;
            messages.push({
              role: 'user',
              content:
                `[继续] 你还有未完成的任务 ${unfinished.id}（${unfinished.subject}）。` +
                `请继续执行并调用 complete_task；不要认领新任务。任务描述：${unfinished.description}`,
            });
            continue;
          }
          break;
        }

        const toolResults: ToolResultBlock[] = [];
        for (const block of getToolUseBlocks(response)) {
          try {
            let output: string;
            switch (block.name) {
              case 'bash':
                output = yield* perform({
                  type: 'BashExec',
                  input: { command: String(block.input['command'] ?? '') },
                });
                break;
              case 'scan_unclaimed': {
                const tasks = yield* perform({ type: 'ScanUnclaimed', input: {} });
                output = tasks.length
                  ? `发现 ${tasks.length} 个任务: ${tasks.map((t) => `${t.id}(${t.subject})`).join(', ')}`
                  : '暂无可用任务';
                break;
              }
              case 'auto_claim': {
                // owner 固定为当前工作者：模型即使传了别的 owner，也不能替别人认领。
                const result = yield* perform({ type: 'AutoClaim', input: { owner: agentId } });
                output =
                  result.success && result.task
                    ? `Claimed ${result.task.id} (${result.task.subject})`
                    : `认领失败: ${result.reason ?? '未知原因'}`;
                break;
              }
              case 'list_tasks': {
                const tasks = yield* perform({ type: 'ListTasks', input: {} });
                output = tasks.length
                  ? tasks
                      .map((t) => `  ${t.id}: ${t.subject} [${t.status}]${t.owner ? ` [${t.owner}]` : ''}`)
                      .join('\n')
                  : 'No tasks.';
                break;
              }
              case 'claim_task': {
                const result = yield* perform({
                  type: 'ClaimTask',
                  input: { taskId: String(block.input['taskId'] ?? ''), owner: agentId },
                });
                output =
                  result.success && result.task
                    ? `Claimed ${result.task.id} (${result.task.subject})`
                    : `认领失败: ${result.reason ?? '未知原因'}`;
                break;
              }
              case 'complete_task': {
                const result = yield* perform({
                  type: 'CompleteTask',
                  input: { taskId: String(block.input['taskId'] ?? ''), owner: agentId },
                });
                output =
                  result.success && result.task
                    ? `Completed ${result.task.id} (${result.task.subject})` +
                      (result.unblocked.length
                        ? `\nUnblocked: ${result.unblocked.map((t) => t.subject).join(', ')}`
                        : '')
                    : `完成失败: ${result.reason ?? '未知原因'}`;
                // 完成一个任务后重置恢复预算，下一个任务仍能获得提醒。
                if (result.success) {
                  resumeNudges = 0;
                  resumeCycles = 0;
                }
                break;
              }
              case 'send_message': {
                const { messageId } = yield* perform({
                  type: 'SendMessage',
                  input: {
                    from: agentId,
                    to: String(block.input['to'] ?? ''),
                    body: String(block.input['body'] ?? ''),
                  },
                });
                output = `已发送 (${messageId})`;
                break;
              }
              default:
                output = `[未知工具] ${block.name}`;
            }
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: output });
          } catch (err) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `[错误] ${err instanceof Error ? err.message : String(err)}`,
              is_error: true,
            });
          }
        }
        messages.push({ role: 'user', content: toolResults });
      }

      if (shouldShutdown) {
        state = 'SHUTDOWN';
        console.log(`\x1b[35m[Lifecycle] ${agentId}: WORK → SHUTDOWN (${shutdownReason})\x1b[0m`);
        break;
      }

      // WORK 阶段结束（模型不再请求工具）→ 进入 IDLE
      state = 'IDLE';
      console.log(`\x1b[36m[Lifecycle] ${agentId}: WORK → IDLE\x1b[0m`);
      continue;
    }

    // ── IDLE 阶段：真实 IdlePoll（逐轮读信箱 + 扫任务板 + 机会主义认领）──
    const idle = yield* perform({
      type: 'IdlePoll',
      input: { agentId, pollIntervalMs: IDLE_POLL_INTERVAL_MS, reason: '等待新任务' },
    });

    if (idle.state === 'shutdown') {
      state = 'SHUTDOWN';
      console.log(`\x1b[35m[Lifecycle] ${agentId}: IDLE → SHUTDOWN (${idle.trigger})\x1b[0m`);
      break;
    }

    if (idle.trigger === 'resume') {
      resumeCycles += 1;
      if (resumeCycles > MAX_RESUME_CYCLES) {
        // 有界退出：一直提醒仍不完成时，带着未完成任务退出，避免 IDLE↔WORK 空转。
        const unfinishedId = idle.task?.id ?? '(unknown)';
        console.log(`  \x1b[31m[Lifecycle] ${agentId}: 放弃恢复未完成任务 ${unfinishedId}\x1b[0m`);
        finalText = `未完成任务 ${unfinishedId}：多次提醒后仍未完成，退出`;
        break;
      }
    } else if (idle.trigger === 'claimed') {
      resumeCycles = 0;
    }

    applyIdleOutcome(messages, idle);
    state = 'WORK';
    console.log(`\x1b[32m[Lifecycle] ${agentId}: IDLE → WORK (${idle.trigger})\x1b[0m`);
  }

  // 子循环结束：先归还自己名下未完成的任务，再发最终摘要。
  // 无论因为放弃恢复、关机请求还是空转退出，任务都不能停在 in_progress：
  // 扫描只收 pending 且无 owner 的任务，退出的 worker 会让它永远无人可接。
  const unfinishedOnExit = unfinishedTaskFor(agentId);
  let releaseNote: string | undefined;
  if (unfinishedOnExit) {
    const released = yield* perform({
      type: 'ReleaseTask',
      input: { taskId: unfinishedOnExit.id, owner: agentId },
    });
    releaseNote = released.released
      ? `未完成任务 ${unfinishedOnExit.id} 已放回任务板。`
      : `未完成任务 ${unfinishedOnExit.id} 未能放回任务板：${released.reason ?? '未知原因'}。`;
  }
  const completed = completedTaskIds(messages);
  const summary = buildWorkerSummary(finalText, completed, releaseNote);
  yield* perform({
    type: 'SendMessage',
    input: { from: agentId, to: LEAD_ID, body: summary, kind: 'result' },
  });
  console.log(`  \x1b[32m[teammate] ${agentId} finished\x1b[0m`);
  return summary;
}

/** 拉起一个自主工作者：注册到 activeTeammates 并启动其独立的 runAgent 子循环。 */
function startTeammate(agentId: string, role: string): Promise<string> {
  const promise = runAgent<S17Effect, string>(
    (perform) => autonomousWorkerLoop(perform, agentId, role),
    s17Handlers,
  )
    .catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      teammateFailures.add(agentId);
      console.log(`  \x1b[31m[teammate] ${agentId} 异常: ${message}\x1b[0m`);
      // 异常退出走不到子循环的收尾代码，这里补一次归还，避免任务卡在 in_progress。
      try {
        const unfinished = unfinishedTaskFor(agentId);
        if (unfinished) {
          const released = releaseTask(unfinished.id, agentId);
          console.log(
            released.released
              ? `  \x1b[33m[teammate] ${agentId} 归还任务 ${unfinished.id}\x1b[0m`
              : `  \x1b[31m[teammate] ${agentId} 无法归还任务 ${unfinished.id}: ${released.reason}\x1b[0m`,
          );
        }
      } catch (releaseErr) {
        console.log(
          `  \x1b[31m[teammate] ${agentId} 归还任务失败: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}\x1b[0m`,
        );
      }
      try {
        await BUS.send(agentId, LEAD_ID, `[teammate error] ${message}`, 'result');
      } catch {
        // 错误结果本身写不进去时只保留上面的日志。
      }
      return '[teammate error]';
    })
    .finally(() => {
      if (activeTeammates.get(agentId) === promise) activeTeammates.delete(agentId);
    });

  activeTeammates.set(agentId, promise);
  return promise;
}

// ============================================================
// Part 6: Handler 实现（所有副作用集中处）
// ============================================================

const s17Handlers: EffectHandlers<S17Effect> = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages, agentId } = effect.input;
    const round = messages.filter((m) => m.role === 'assistant').length + 1;
    console.log(`\n[Chat:${agentId}] → 轮次 ${round}`);
    await new Promise((r) => setTimeout(r, 10));
    const isWorker = agentId !== LEAD_ID;
    // mock 只替换这一行模型调用；状态机、轮询、认领、信箱全是真实代码。
    return callChat(
      (m) => (isWorker ? mockWorker(m) : mockLead(m)),
      messages,
      {
        tools: isWorker ? WORKER_TOOLS : LEAD_TOOLS,
        system: isWorker ? WORKER_SYSTEM_PROMPT : LEAD_SYSTEM_PROMPT,
        maxTokens: MAX_TOKENS,
      },
    );
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    console.log(`[BashExec] → ${effect.input.command}`);
    // 教学演示：只模拟执行，不真正 fork 进程（与其余章节一致）
    return `(执行: ${effect.input.command})`;
  },

  SendMessage: async (effect: SendMessageEffect): Promise<{ messageId: string }> => {
    const { from, to, body, kind, metadata } = effect.input;
    // 只给仍在运行的队友发消息；否则消息会落进一个没人读的信箱。
    if (to !== LEAD_ID && !activeTeammates.has(to)) {
      throw new Error(`队友 '${to}' 未在运行`);
    }
    const messageId = await BUS.send(from, to, body, kind ?? 'message', metadata ?? {});
    return { messageId };
  },

  CheckInbox: async (effect: CheckInboxEffect): Promise<AgentMessage[]> => {
    const msgs = await BUS.readInbox(effect.input.agentId);
    if (effect.input.agentId === LEAD_ID) recordShutdownResponses(msgs);
    // 队友空闲时每轮都会读一次；只打印 lead 或真有消息的读取，避免刷屏。
    if (effect.input.agentId === LEAD_ID || msgs.length > 0) {
      console.log(`[CheckInbox:${effect.input.agentId}] 收到 ${msgs.length} 条消息`);
      msgs.forEach((m) => console.log(`  ✉ ${m.from} [${m.type}]: ${truncate(m.body, 80)}`));
    }
    return msgs;
  },

  RequestShutdown: async (
    effect: RequestShutdownEffect,
  ): Promise<{ requestId: string; delivered: boolean; reason?: string }> => {
    const { agentId, reason } = effect.input;
    validateAgentId(agentId);
    if (agentId === LEAD_ID) throw new Error(`'${LEAD_ID}' 是主 Agent 的保留名`);
    if (!activeTeammates.has(agentId)) {
      return { requestId: '', delivered: false, reason: `队友 '${agentId}' 未在运行` };
    }

    const requestId = newShutdownRequestId();
    pendingShutdowns.set(requestId, { agentId, status: 'pending' });
    await BUS.send(
      LEAD_ID,
      agentId,
      reason?.trim() ? `请优雅关闭：${reason.trim()}` : '请优雅关闭。',
      'shutdown_request',
      { request_id: requestId },
    );
    console.log(`  \x1b[35m[RequestShutdown] agentId=${agentId} requestId=${requestId}\x1b[0m`);
    return { requestId, delivered: true };
  },

  WaitForTeammates: async (effect: WaitForTeammatesEffect): Promise<string[]> => {
    return settleActiveWithin(activeTeammates, effect.input.timeoutMs);
  },

  SpawnTeammate: async (effect: SpawnTeammateEffect): Promise<{ agentId: string; status: 'spawned' }> => {
    const { agentId, role } = effect.input;
    validateAgentId(agentId);
    if (agentId === LEAD_ID) throw new Error(`'${LEAD_ID}' 是主 Agent 的保留名`);
    if (!role.trim()) throw new Error('role 不能为空');
    if (activeTeammates.has(agentId)) throw new Error(`队友 '${agentId}' 仍在运行`);

    BUS.ensureInbox(agentId);
    console.log(`\x1b[36m[SpawnTeammate] 生成: ${agentId} (${role})\x1b[0m`);
    startTeammate(agentId, role);
    // 让子循环先跑到第一个 await，再让 lead 继续
    await new Promise((r) => setTimeout(r, 0));
    return { agentId, status: 'spawned' };
  },

  ScanUnclaimed: async (_effect: ScanUnclaimedEffect): Promise<TaskRecord[]> => {
    const tasks = scanUnclaimedTasks();
    console.log(`[ScanUnclaimed] 发现 ${tasks.length} 个可认领任务`);
    tasks.forEach((t) => console.log(`  ○ ${t.id}: ${t.subject}`));
    return tasks;
  },

  AutoClaim: async (effect: AutoClaimEffect): Promise<ClaimOutcome> => {
    const { owner } = effect.input;
    const result = autoClaim(owner);
    if (result.success && result.task) {
      console.log(`[AutoClaim] ◑ ${result.task.id}: ${result.task.subject} → ${owner}`);
    } else {
      console.log(`[AutoClaim] ✗ ${result.reason}`);
    }
    return result;
  },

  ClaimTask: async (effect: ClaimTaskEffect): Promise<ClaimOutcome> => {
    const { taskId, owner } = effect.input;
    const result = claimTask(taskId, owner);
    if (result.success && result.task) {
      console.log(`[ClaimTask] ● ${result.task.id}: ${result.task.subject} → ${owner}`);
    } else {
      console.log(`[ClaimTask] ✗ ${result.reason}`);
    }
    return result;
  },

  CompleteTask: async (effect: CompleteTaskEffect): Promise<CompleteOutcome> => {
    const { taskId, owner } = effect.input;
    const result = completeTask(taskId, owner);
    if (result.success) {
      console.log(`[CompleteTask] ✓ ${result.task.id}: ${result.task.subject}`);
      if (result.unblocked.length > 0) {
        console.log(`[CompleteTask] 解锁: ${result.unblocked.map((t) => t.subject).join(', ')}`);
      }
    } else {
      console.log(`[CompleteTask] ✗ ${result.reason}`);
    }
    return result;
  },

  ListTasks: async (_effect: ListTasksEffect): Promise<TaskRecord[]> => listTasks(),

  ReleaseTask: async (effect: ReleaseTaskEffect): Promise<ReleaseOutcome> => {
    const { taskId, owner } = effect.input;
    const result = releaseTask(taskId, owner);
    if (result.released) {
      console.log(`[ReleaseTask] ↩ ${taskId}: 放回任务板（原 owner=${owner}）`);
    } else {
      console.log(`[ReleaseTask] ✗ ${result.reason}`);
    }
    return result;
  },

  // s17 核心：真实的空闲轮询。逐轮 sleep → 读信箱 → 扫任务板 → 机会主义认领。
  IdlePoll: async (effect: IdlePollEffect): Promise<IdleOutcome> => {
    const { agentId, pollIntervalMs, reason } = effect.input;
    const interval = Math.max(1, pollIntervalMs);
    const startedAt = Date.now();
    const deadline = startedAt + IDLE_TIMEOUT_MS;
    console.log(
      `[IdlePoll:${agentId}] ${reason ?? '等待新任务'} (间隔=${interval}ms, 超时=${IDLE_TIMEOUT_MS}ms)`,
    );

    while (Date.now() < deadline) {
      // 单次 sleep 不超过剩余时间：否则模型传一个很大的 pollIntervalMs 会越过空闲超时。
      await new Promise((r) => setTimeout(r, Math.min(interval, Math.max(1, deadline - Date.now()))));

      // 1) 信箱优先：shutdown_request → shutdown；其它 → 唤醒回 WORK
      const inbox = await BUS.readInbox(agentId);
      if (inbox.length > 0) {
        if (inbox.some((m) => m.type === 'shutdown_request')) {
          const shutdownMsg = inbox.find((m) => m.type === 'shutdown_request');
          const requestId =
            shutdownMsg && typeof shutdownMsg.metadata['request_id'] === 'string'
              ? shutdownMsg.metadata['request_id']
              : '';
          await BUS.send(agentId, LEAD_ID, 'Shutting down gracefully.', 'shutdown_response', {
            request_id: requestId,
            approve: true,
            responder: agentId,
          });
          console.log(`  \x1b[35m[protocol] ${agentId} approved shutdown in IDLE\x1b[0m`);
          return { state: 'shutdown', trigger: 'inbox', inbox };
        }
        return { state: 'work', trigger: 'inbox', inbox };
      }

      // 2) 自己名下还有未完成任务：先恢复它，不要再去认领新任务。
      const unfinished = unfinishedTaskFor(agentId);
      if (unfinished) {
        console.log(`  \x1b[36m[idle] ${agentId} 恢复未完成任务 ${unfinished.id}\x1b[0m`);
        return { state: 'work', trigger: 'resume', task: unfinished };
      }

      // 3) 任务板：有可认领任务就真认领
      const unclaimed = scanUnclaimedTasks();
      if (unclaimed.length > 0) {
        const claim = claimTask(unclaimed[0].id, agentId);
        if (claim.success && claim.task) {
          console.log(`  \x1b[32m[idle] ${agentId} auto-claimed: ${claim.task.subject}\x1b[0m`);
          return { state: 'work', trigger: 'claimed', task: claim.task };
        }
        console.log(`  \x1b[33m[idle] ${agentId} claim failed: ${claim.reason}\x1b[0m`);
      }

      console.log(`[IdlePoll:${agentId}] 空闲中... (${Date.now() - startedAt}ms / ${IDLE_TIMEOUT_MS}ms)`);
    }

    console.log(`  \x1b[31m[idle] ${agentId} timeout (${IDLE_TIMEOUT_MS}ms)\x1b[0m`);
    return { state: 'shutdown', trigger: 'timeout' };
  },
};

// ============================================================
// Part 7: lead 主 Agent 循环
// ============================================================

function* leadLoop(perform: PerformFn<S17Effect>) {
  const messages: Message[] = [
    {
      role: 'user',
      content: '启动一个自主工作者，让它扫描任务板、认领并完成任务，最后收集它的报告。',
    },
  ];
  let drains = 0;

  while (true) {
    const response = yield* perform({ type: 'Chat', input: { messages, agentId: LEAD_ID } });
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      // 回合结束后由宿主最多等一段固定时间，等活跃队友结束，再把新消息注入对话；check_inbox 本身不等待。
      if (drains < MAX_END_TURN_DRAINS) {
        const remaining = yield* perform({
          type: 'WaitForTeammates',
          input: { timeoutMs: JOIN_TIMEOUT_MS },
        });
        const inbox = yield* perform({ type: 'CheckInbox', input: { agentId: LEAD_ID } });
        if (inbox.length > 0) {
          messages.push({ role: 'user', content: `<inbox>${formatInbox(inbox)}</inbox>` });
          console.log(`[inject inbox] ${inbox.length} 条`);
          drains += 1;
          continue;
        }
        if (remaining.length > 0) {
          console.log(`[inject inbox] 等待超时，仍在运行: ${remaining.join(', ')}`);
        }
      }
      return extractText(response);
    }

    const toolResults: ToolResultBlock[] = [];
    for (const block of getToolUseBlocks(response)) {
      try {
        let output: string;
        switch (block.name) {
          case 'bash':
            output = yield* perform({
              type: 'BashExec',
              input: { command: String(block.input['command'] ?? '') },
            });
            break;
          case 'spawn_teammate': {
            const { agentId } = yield* perform({
              type: 'SpawnTeammate',
              input: {
                agentId: String(block.input['agentId'] ?? WORKER_ID),
                role: String(block.input['role'] ?? '自主工作者'),
              },
            });
            output = `自主工作者已创建: ${agentId}`;
            break;
          }
          case 'send_message': {
            const { messageId } = yield* perform({
              type: 'SendMessage',
              input: {
                from: LEAD_ID,
                to: String(block.input['to'] ?? ''),
                body: String(block.input['body'] ?? ''),
              },
            });
            output = `消息已发送 (${messageId})`;
            break;
          }
          case 'check_inbox': {
            const msgs = yield* perform({ type: 'CheckInbox', input: { agentId: LEAD_ID } });
            output = msgs.length ? formatInbox(msgs) : '信箱为空';
            break;
          }
          case 'request_shutdown': {
            const result = yield* perform({
              type: 'RequestShutdown',
              input: {
                agentId: String(block.input['agentId'] ?? ''),
                reason: String(block.input['reason'] ?? ''),
              },
            });
            output = result.delivered
              ? `已发送关机请求 (${result.requestId})`
              : `关机请求失败: ${result.reason ?? '未知原因'}`;
            break;
          }
          default:
            output = `[未知工具] ${block.name}`;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: output });
      } catch (err) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `[错误] ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }
}

// ============================================================
// Part 8: 启动入口（预置任务板：一个任务被另一个阻塞）
// ============================================================

/**
 * 预置四个 demo 任务，展示依赖解锁与两处归属检查：
 *   task_..._0001（无依赖）可立即认领
 *   task_..._0002（blockedBy: [0001]）在 0001 完成前不出现在 scan_unclaimed 结果里
 *   task_owned_by_lead（owner=main）不会被扫描到，工作者强行认领会被拒绝
 *   task_owned_by_lead_active（status=in_progress, owner=main）用于演示完成阶段的 owner 拒绝
 * 本章任务板在 .tasks/s17/，启动时只重置这个目录，不扫描共享 .tasks/ 根目录。
 */
function seedDemoTasks(): TaskRecord[] {
  resetS17TaskDir();
  const a: TaskRecord = {
    id: 'task_0000_s17_0001',
    subject: '更新文档索引',
    description: '重建搜索索引',
    status: 'pending',
    owner: null,
    blockedBy: [],
  };
  const b: TaskRecord = {
    id: 'task_0000_s17_0002',
    subject: '清理日志文件',
    description: '删除 7 天前的日志',
    status: 'pending',
    owner: null,
    blockedBy: [a.id],
  };
  const owned: TaskRecord = {
    id: OWNED_TASK_ID,
    subject: '（由 lead 持有）',
    description: '演示认领阶段的 owner 检查：别的 worker 不能认领',
    status: 'pending',
    owner: LEAD_ID,
    blockedBy: [],
  };
  const ownedActive: TaskRecord = {
    id: OWNED_ACTIVE_TASK_ID,
    subject: '（由 lead 执行中）',
    description: '演示完成阶段的 owner 检查：别的 worker 不能完成',
    status: 'in_progress',
    owner: LEAD_ID,
    blockedBy: [],
  };
  saveTask(a);
  saveTask(b);
  saveTask(owned);
  saveTask(ownedActive);
  return [a, b, owned, ownedActive];
}

const seeded = seedDemoTasks();

console.log('[S17] Autonomous Agents 启动\n');
console.log(`任务目录: ${S17_TASKS_DIR}（启动时只重置本章目录）`);
console.log(`信箱目录: ${S17_MAILBOX_DIR}`);
console.log(`模式: ${describeMode()}`);
console.log(
  `生命周期: WORK → IDLE → SHUTDOWN (间隔=${IDLE_POLL_INTERVAL_MS}ms, 超时=${IDLE_TIMEOUT_MS}ms; 真实默认 5000/60000ms)`,
);
console.log(
  `预置 ${seeded.length} 个任务（'${seeded[1].subject}' 依赖 '${seeded[0].subject}'；'${OWNED_TASK_ID}' 由 ${LEAD_ID} 持有；'${OWNED_ACTIVE_TASK_ID}' 由 ${LEAD_ID} 执行中）\n`,
);

let result: string | undefined;
let ok = true;
let stillRunning: string[] = [];
try {
  result = await runAgent<S17Effect, string>(leadLoop, s17Handlers);
} catch (err) {
  ok = false;
  process.exitCode = 1;
  console.error(
    `[S17] lead 运行失败（${describeMode()}）: ${err instanceof Error ? err.message : String(err)}`,
  );
} finally {
  // 收尾：最多等一段固定时间；不再一直挂住进程。
  stillRunning = await settleActiveWithin(activeTeammates, CLEANUP_WAIT_MS);
  if (stillRunning.length > 0) {
    // Lead 已经返回，这些队友的结果没有进入对话，整次运行按不完整处理。
    process.exitCode = 1;
    console.warn(
      `[S17] 退出前仍有队友在运行: ${stillRunning.join(', ')}（不会强制结束；如有在途模型请求，进程可能要等它完成）`,
    );
  }
}

console.log('\n[Lifecycle] 任务板最终状态:');
for (const task of listTasks()) {
  console.log(`  ${task.id}: ${task.subject} [${task.status}]${task.owner ? ` owner=${task.owner}` : ''}`);
}

if (teammateFailures.size > 0) {
  process.exitCode = 1;
  console.error(`[S17] 自主工作者失败: ${[...teammateFailures].join(', ')}`);
}

if (ok && result !== undefined && teammateFailures.size === 0 && stillRunning.length === 0) {
  console.log('\n[S17] 完成:', result);
} else {
  console.log('[S17] 失败');
}