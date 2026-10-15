/**
 * s17: Autonomous Agents — WORK / IDLE / SHUTDOWN 自主工作者状态机
 *
 * 本章机制：
 *   - scanUnclaimedTasks：扫描 pending + 未认领 + 依赖已满足 的任务
 *   - IdlePoll：空闲轮询（默认 5s 间隔 / 60s 超时），命中 inbox 或任务板则回 WORK
 *   - claimTask：owner 检查 + canStart 依赖检查
 *   - 队友生命周期：WORK → IDLE → SHUTDOWN
 *   - 依赖 owner 的任务归属（owner 持久化在 .tasks/*.json）
 *
 * 这是一个**真实的工作者状态机**，状态全部落在文件与注册表里，不靠全局变量传递：
 *   WORK  — 读信箱（真 JSONL）→ Chat（mock 只替换模型调用）→ 派发工具
 *   IDLE  — 由循环主动调用 IdlePoll Effect：真 sleep，逐轮读信箱 + 扫任务板；
 *           任务板有可认领任务就真认领并回 WORK，超时才 SHUTDOWN
 *   SHUTDOWN — 退出子循环，把最终摘要经信箱回报给 lead
 * autoClaim 自己扫描并认领第一个合格任务，不依赖任何全局变量。
 *
 * 三个 s17 Effect：
 *   IdlePoll      — 空闲等待：真轮询 + 真扫描 + 真认领，返回 work/shutdown
 *   ScanUnclaimed — 扫描可认领任务（pending + 无 owner + canStart）
 *   AutoClaim     — 主动认领第一个能做的任务（检查 owner 和依赖）
 *
 * 路径来自 runtime/workspace.ts（.tasks/、.mailboxes/），锁来自 runtime/locks.ts。
 */

import { runAgent } from '../runtime/core.ts';
import type { Effect, EffectHandlers, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, TaskRecord, ToolResultBlock } from '../runtime/types.ts';
import { extractText, getToolUseBlocks, messageText } from '../runtime/response.ts';
import { callChat } from '../runtime/model.ts';
import { schemasFor } from '../runtime/tool-schemas.ts';
import { buildSystemPrompt } from '../runtime/system-prompt.ts';
import { resolveMode } from '../runtime/env.ts';
import { TASKS_DIR, MAILBOXES_DIR } from '../runtime/workspace.ts';
import { Mutex } from '../runtime/locks.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------- 通用字符串小工具 ----------
/** 超长文本截断显示：超过 n 个字符时截断并追加省略号。 */
function truncate(text: string, n: number): string {
  return text.length > n ? text.slice(0, n) + '…' : text;
}

// ============================================================
// Part 0: 常量（默认 5s 轮询 / 60s 超时）
// ============================================================

const LEAD_ID = 'main';      // lead 的 mailbox 名
const WORKER_ID = 'worker';  // 自主工作者
const OWNED_TASK_ID = 'task_owned_by_lead'; // 预置的"别人持有"任务，用于演示 owner 检查

const MAX_WORK_ITERATIONS = 10; // WORK 阶段最多 10 个工作轮

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

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

interface ChatEffect extends Effect<'Chat', { messages: Message[]; agentId: string }, LLMResponse> {}

interface BashExecEffect extends Effect<'BashExec', { command: string }, string> {}

/** 一条信箱消息的结构（与 s15 一致：from / to / body / type / timestamp）。 */
interface AgentMessage {
  from: string;
  to: string;
  body: string;
  type: string;
  timestamp: number;
}

interface SendMessageEffect extends Effect<'SendMessage', { from: string; to: string; body: string; kind?: string }, { messageId: string }> {}

interface CheckInboxEffect extends Effect<'CheckInbox', { agentId: string }, AgentMessage[]> {}

interface SpawnTeammateEffect extends Effect<'SpawnTeammate', { agentId: string; role: string }, { agentId: string; status: 'spawned' }> {}

// ── 任务工具（scan / claim / complete）──
type ClaimOutcome = { task: TaskRecord | null; success: boolean; reason?: string };

type CompleteOutcome =
  | { task: TaskRecord; success: true; unblocked: TaskRecord[] }
  | { task: null; success: false; reason: string; unblocked: [] };

interface ScanUnclaimedEffect extends Effect<'ScanUnclaimed', Record<string, never>, TaskRecord[]> {}

interface AutoClaimEffect extends Effect<'AutoClaim', { owner: string }, ClaimOutcome> {}

interface ClaimTaskEffect extends Effect<'ClaimTask', { taskId: string; owner: string }, ClaimOutcome> {}

interface CompleteTaskEffect extends Effect<'CompleteTask', { taskId: string; owner: string }, CompleteOutcome> {}

interface ListTasksEffect extends Effect<'ListTasks', Record<string, never>, TaskRecord[]> {}

// ── s17 核心：idle_poll 的返回（真实状态机转换的依据）──
type IdleOutcome = {
  state: 'work' | 'shutdown';
  trigger: 'inbox' | 'claimed' | 'timeout';
  inbox?: AgentMessage[];
  task?: TaskRecord | null;
};

interface IdlePollEffect
  extends Effect<'IdlePoll', { agentId: string; pollIntervalMs: number; reason?: string }, IdleOutcome> {}

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
  | ListTasksEffect
  | IdlePollEffect;

// ============================================================
// Part 2: 真实任务存储（文件持久化 + 依赖/归属检查）
// ============================================================

function ensureTasksDir(): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
}

function taskPath(taskId: string): string {
  return path.join(TASKS_DIR, `${taskId}.json`);
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
    .readdirSync(TASKS_DIR)
    .filter((f) => /^task_.*\.json$/.test(f))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8')) as TaskRecord;
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
  if (task.owner && task.owner !== owner) {
    return { task: null, success: false, reason: `Task ${taskId} is owned by ${task.owner}, not ${owner}`, unblocked: [] };
  }
  task.status = 'completed';
  saveTask(task);
  const unblocked = listTasks().filter(
    (t) => t.status === 'pending' && t.blockedBy.length > 0 && canStart(t.id),
  );
  return { task, success: true, unblocked };
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

/**
 * 文件消息总线：每个 Agent 一个 `.jsonl` 信箱，一行一条 JSON 消息。
 *   send()       —— append 一行（真实追加写）
 *   readInbox()  —— 读出全部行并清空（消费式读取）
 *
 * 并发队友会同时读写，用 runtime/locks.ts 的 Mutex 串行化 append / read-clear，
 * 避免交错写坏 JSONL。
 */
class MessageBus {
  private readonly mutex = new Mutex();
  private seq = 0;

  constructor() {
    fs.mkdirSync(MAILBOXES_DIR, { recursive: true });
  }

  private inboxPath(agentId: string): string {
    validateAgentId(agentId);
    return path.join(MAILBOXES_DIR, `${agentId}.jsonl`);
  }

  async send(from: string, to: string, body: string, type = 'message'): Promise<string> {
    return this.mutex.withLock(() => {
      fs.mkdirSync(MAILBOXES_DIR, { recursive: true });
      const msg: AgentMessage = { from, to, body, type, timestamp: Date.now() };
      fs.appendFileSync(this.inboxPath(to), JSON.stringify(msg) + '\n', 'utf8');
      const messageId = `msg_${Date.now()}_${++this.seq}`;
      console.log(`  \x1b[33m[bus] ${from} → ${to}: (${type}) ${truncate(body, 50)}\x1b[0m`);
      return messageId;
    });
  }

  /** 消费式读取：读出全部消息后把文件清空为 0 字节。 */
  async readInbox(agentId: string): Promise<AgentMessage[]> {
    return this.mutex.withLock(() => {
      const p = this.inboxPath(agentId);
      if (!fs.existsSync(p)) return [];
      const msgs = fs
        .readFileSync(p, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as AgentMessage);
      fs.writeFileSync(p, '', 'utf8');
      return msgs;
    });
  }
}

const BUS = new MessageBus();

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

/** 找出"已认领但尚未完成"的任务（显式认领优先，其次是空闲期自动认领的）。 */
function unfinishedWork(messages: Message[]): string | undefined {
  let claimed: string | undefined;
  let autoClaimed: string | undefined;
  const completed = new Set<string>();
  for (const message of messages) {
    const s = typeof message.content === 'string' ? message.content : messageText(message.content);
    for (const match of s.matchAll(CLAIMED_RE)) claimed = match[1];
    for (const match of s.matchAll(AUTO_CLAIMED_RE)) autoClaimed = match[1];
    for (const match of s.matchAll(COMPLETED_RE)) completed.add(match[1]);
  }
  if (claimed && !completed.has(claimed)) return claimed;
  if (autoClaimed && !completed.has(autoClaimed)) return autoClaimed;
  return undefined;
}

/** lead 剧本：spawn 自主工作者 → 收报告 → 结束。 */
function mockLead(): LLMResponse {
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
    default:
      return {
        stop_reason: 'end_turn',
        content: [text('自主工作者已认领并完成任务，成果通过信箱回报。')],
      };
  }
}

/**
 * 工作者剧本（由对话状态驱动，而非固定轮次——因为"自主工作者"应该把任务板上
 * 所有可认领任务都干完，不管板上有几个任务）：
 *   1) 有已认领未完成的任务 → 执行并完成它
 *   2) 第一轮 → 扫描 + 尝试认领别人的任务（被拒）+ 机会主义认领
 *   3) 否则 → end_turn，进入 IDLE 轮询；IDLE 认领到新任务会被注入 <auto-claimed>，回到 (1)
 *   任务板清空后 IDLE 超时 → SHUTDOWN。
 */
function mockWorker(agentId: string, messages: Message[]): LLMResponse {
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
        // 故意尝试认领一个已被 lead 持有的任务 → 触发 owner 检查拒绝
        tool('w_owned', 'claim_task', { taskId: OWNED_TASK_ID }),
        tool('w2', 'auto_claim', { owner: agentId }),
      ],
    };
  }

  return {
    stop_reason: 'end_turn',
    content: [text('任务板已无更多可认领任务，进入空闲轮询。')],
  };
}

// real 模式注入 system prompt；mock 模式不读取，故零配置行为不变。
const LEAD_SYSTEM_PROMPT = buildSystemPrompt(
  '你是 lead：用 spawn_teammate 拉起自主工作者，用 check_inbox 收集它的完成报告，用 send_message 下达指令。' +
    '本教学演示中 bash 是模拟的：只回显命令文本、不会真正执行，请不要依赖它的输出。',
);
const WORKER_SYSTEM_PROMPT = buildSystemPrompt(
  '你是自主工作者：主动用 scan_unclaimed 扫描任务板、用 auto_claim 机会主义认领，用 complete_task 完成自己拥有的任务；没有工作时进入空闲轮询（不要空转）。' +
    '本教学演示中 bash 是模拟的：只回显命令文本、不会真正执行，请不要依赖它的输出。',
);

// ============================================================
// Part 5: 队友子循环 —— 真实 WORK/IDLE/SHUTDOWN 状态机
// ============================================================

/** 活跃队友：agentId → 它那一轮运行的 Promise（稍后用来等它结束，保证进程正常收尾）。 */
const activeTeammates = new Map<string, Promise<string>>();

/** 等待所有已启动的队友子循环结束；无论成功失败都返回，随后清空注册表。 */
async function awaitTeammates(): Promise<void> {
  const pending = [...activeTeammates.values()];
  if (pending.length === 0) return;
  await Promise.allSettled(pending);
  activeTeammates.clear();
}

type WorkerState = 'WORK' | 'IDLE' | 'SHUTDOWN';

/** 把 idle_poll 的结果注入对话（认领/来信 → 下一轮 WORK 的输入）。 */
function applyIdleOutcome(messages: Message[], idle: IdleOutcome): void {
  if (idle.trigger === 'claimed' && idle.task) {
    messages.push({
      role: 'user',
      content: `<auto-claimed>Task ${idle.task.id}: ${idle.task.subject}</auto-claimed>`,
    });
  } else if (idle.trigger === 'inbox' && idle.inbox) {
    const nonProtocol = idle.inbox.filter((m) => m.type === 'message');
    if (nonProtocol.length > 0) {
      messages.push({ role: 'user', content: `<inbox>${JSON.stringify(nonProtocol)}</inbox>` });
    }
    console.log(`  \x1b[36m[idle] found inbox messages\x1b[0m`);
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
      content: `你是自主工作者 '${agentId}'（${role}）。主动扫描任务板、认领并完成可用任务；没有工作时进入空闲轮询，超时或收到 shutdown 请求则退出。需要主动汇报时用 send_message 发给 lead（它的信箱是 '${LEAD_ID}'）。`,
    },
  ];

  let state: WorkerState = 'WORK';
  let finalText = '';

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

      for (let iteration = 0; iteration < MAX_WORK_ITERATIONS; iteration++) {
        // 真实读取并清空自己的信箱
        const inbox = yield* perform({ type: 'CheckInbox', input: { agentId } });
        for (const msg of inbox) {
          if (msg.type === 'shutdown_request') {
            yield* perform({
              type: 'SendMessage',
              input: { from: agentId, to: LEAD_ID, body: 'Shutting down gracefully.', kind: 'shutdown_response' },
            });
            console.log(`  \x1b[35m[protocol] ${agentId} approved shutdown in WORK\x1b[0m`);
            shouldShutdown = true;
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
                const owner = String(block.input['owner'] ?? agentId) || agentId;
                const result = yield* perform({ type: 'AutoClaim', input: { owner } });
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
                break;
              }
              case 'idle_poll': {
                const idle = yield* perform({
                  type: 'IdlePoll',
                  input: {
                    agentId,
                    pollIntervalMs: Number(block.input['pollIntervalMs']) || IDLE_POLL_INTERVAL_MS,
                    reason: String(block.input['reason'] ?? '等待新任务'),
                  },
                });
                if (idle.state === 'shutdown') {
                  shouldShutdown = true;
                  output = '空闲超时，进入 SHUTDOWN';
                } else {
                  applyIdleOutcome(messages, idle);
                  output = '发现新任务，回到 WORK';
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
        console.log(`\x1b[35m[Lifecycle] ${agentId}: WORK → SHUTDOWN (shutdown_request)\x1b[0m`);
        break;
      }

      // WORK 阶段结束（模型不再请求工具）→ 进入 IDLE
      state = 'IDLE';
      console.log(`\x1b[36m[Lifecycle] ${agentId}: WORK → IDLE\x1b[0m`);
      continue;
    }

    // ── IDLE 阶段：真实 idle_poll（逐轮读信箱 + 扫任务板 + 机会主义认领）──
    const idle = yield* perform({
      type: 'IdlePoll',
      input: { agentId, pollIntervalMs: IDLE_POLL_INTERVAL_MS, reason: '等待新任务' },
    });

    if (idle.state === 'shutdown') {
      state = 'SHUTDOWN';
      console.log(`\x1b[35m[Lifecycle] ${agentId}: IDLE → SHUTDOWN (${idle.trigger})\x1b[0m`);
      break;
    }

    applyIdleOutcome(messages, idle);
    state = 'WORK';
    console.log(`\x1b[32m[Lifecycle] ${agentId}: IDLE → WORK (${idle.trigger})\x1b[0m`);
  }

  // 子循环结束：把最终摘要作为 'result' 消息发给 lead（真实信箱写入）
  const summary = finalText || 'Done.';
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
  ).catch((err: unknown) => {
    console.log(
      `  \x1b[31m[teammate] ${agentId} 异常: ${err instanceof Error ? err.message : String(err)}\x1b[0m`,
    );
    return '[teammate error]';
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
      (m) => (isWorker ? mockWorker(agentId, m) : mockLead()),
      messages,
      {
        tools: isWorker
          ? schemasFor(
              'bash',
              'scan_unclaimed',
              'auto_claim',
              'list_tasks',
              'claim_task',
              'complete_task',
              'idle_poll',
              'send_message',
            )
          : schemasFor('bash', 'spawn_teammate', 'send_message', 'check_inbox'),
        system: isWorker ? WORKER_SYSTEM_PROMPT : LEAD_SYSTEM_PROMPT,
      },
    );
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    console.log(`[BashExec] → ${effect.input.command}`);
    // 教学演示：只模拟执行，不真正 fork 进程（与其余章节一致）
    return `(执行: ${effect.input.command})`;
  },

  SendMessage: async (effect: SendMessageEffect): Promise<{ messageId: string }> => {
    const { from, to, body, kind } = effect.input;
    const messageId = await BUS.send(from, to, body, kind ?? 'message');
    return { messageId };
  },

  CheckInbox: async (effect: CheckInboxEffect): Promise<AgentMessage[]> => {
    // lead 查信箱前先等队友结束：保证队友已把 result 写回（演示结果才稳定）
    if (effect.input.agentId === LEAD_ID) {
      await awaitTeammates();
    }
    const msgs = await BUS.readInbox(effect.input.agentId);
    console.log(`[CheckInbox:${effect.input.agentId}] 收到 ${msgs.length} 条消息`);
    msgs.forEach((m) => console.log(`  ✉ ${m.from} [${m.type}]: ${truncate(m.body, 80)}`));
    return msgs;
  },

  SpawnTeammate: async (effect: SpawnTeammateEffect): Promise<{ agentId: string; status: 'spawned' }> => {
    const { agentId, role } = effect.input;
    if (activeTeammates.has(agentId)) {
      console.log(`[SpawnTeammate] ${agentId} 已存在`);
      return { agentId, status: 'spawned' };
    }
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
      console.log(`[AutoClaim] ◑ ${result.task.id}: ${result.task.subject} → ${owner} [IDLE→WORK]`);
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
      await new Promise((r) => setTimeout(r, interval));

      // 1) 信箱优先：shutdown_request → shutdown；其它 → 唤醒回 WORK
      const inbox = await BUS.readInbox(agentId);
      if (inbox.length > 0) {
        if (inbox.some((m) => m.type === 'shutdown_request')) {
          await BUS.send(agentId, LEAD_ID, 'Shutting down gracefully.', 'shutdown_response');
          console.log(`  \x1b[35m[protocol] ${agentId} approved shutdown in idle\x1b[0m`);
          return { state: 'shutdown', trigger: 'inbox', inbox };
        }
        return { state: 'work', trigger: 'inbox', inbox };
      }

      // 2) 任务板：有可认领任务就真认领
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

  while (true) {
    const response = yield* perform({ type: 'Chat', input: { messages, agentId: LEAD_ID } });
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      return extractText(response);
    }

    const toolResults: ToolResultBlock[] = [];
    for (const block of getToolUseBlocks(response)) {
      try {
        let output: string;
        switch (block.name) {
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
            output = msgs.length
              ? msgs.map((m) => `${m.from} [${m.type}]: ${m.body}`).join('\n')
              : '信箱为空';
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
 * 预置三个 demo 任务，展示依赖解锁与归属检查：
 *   task_..._0001（无依赖）可立即认领
 *   task_..._0002（blockedBy: [0001]）在 0001 完成前不出现在 scan_unclaimed 结果里
 *   task_owned_by_lead（owner=lead）不会被扫描到，工作者强行认领会被拒绝
 * id 用低位数字前缀，保证排序在最前，避免与工作区里其它章节的任务混淆。
 */
function seedDemoTasks(): TaskRecord[] {
  ensureTasksDir();
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
    description: '演示 owner 检查：别的 worker 不能认领',
    status: 'pending',
    owner: LEAD_ID,
    blockedBy: [],
  };
  saveTask(a);
  saveTask(b);
  saveTask(owned);
  return [a, b, owned];
}

const seeded = seedDemoTasks();

console.log('[S17] Autonomous Agents 启动\n');
console.log(`任务目录: ${TASKS_DIR}`);
console.log(`信箱目录: ${MAILBOXES_DIR}`);
console.log(
  `生命周期: WORK → IDLE → SHUTDOWN (间隔=${IDLE_POLL_INTERVAL_MS}ms, 超时=${IDLE_TIMEOUT_MS}ms; 真实默认 5000/60000ms)`,
);
console.log(
  `预置 ${seeded.length} 个任务（'${seeded[1].subject}' 依赖 '${seeded[0].subject}'；'${OWNED_TASK_ID}' 由 ${LEAD_ID} 持有）\n`,
);

const result = await runAgent<S17Effect, string>(leadLoop, s17Handlers);

// 收尾：确保所有队友都已结束（正常情况下 CheckInbox 里已经等过，这里再保险一次）
await awaitTeammates();

console.log('\n[Lifecycle] 任务板最终状态:');
for (const task of listTasks()) {
  console.log(`  ${task.id}: ${task.subject} [${task.status}]${task.owner ? ` owner=${task.owner}` : ''}`);
}

console.log('\n[S17] 完成:', result);
