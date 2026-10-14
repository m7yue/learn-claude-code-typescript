/**
 * s20: Comprehensive — 把 s10–s19 的机制组合成一个完整的、真正能跑的 Agent
 *
 * 本章把每一章的机制都接上真实的文件、进程与定时器，再用同一个代数效应运行器（runAgent）串起来
 * （而不是只在内存里模拟、让各 Effect 只打印日志）：
 *
 *   s08 上下文压缩     → 每轮真实跑 预算/裁剪/微压缩/LLM 摘要；超长工具输出写入磁盘（PersistOutput）
 *   s09 Memory         → 真实读写 .memory/
 *   s10 Prompt 组装     → 运行时按上下文分段组装 system prompt
 *   s11 错误恢复        → 真实区分 429/529/过长，退避重试 + 连续 529 切换模型
 *   s12 Task System    → .tasks/ 持久化任务图 + blockedBy 依赖图
 *   s13 Background     → 真实后台任务注册表 + 通知收集
 *   s14 Cron           → 真实 setInterval 调度器 + .scheduled_tasks.json 持久化 + 队列注入
 *   s15 Agent Teams    → 真实 JSONL 信箱 + 独立 generator 的队友子循环
 *   s16 Team Protocols → request_id 协议状态机 + 计划审批会真的等待响应
 *   s17 Autonomous     → 队友空闲 WORK/IDLE/SHUTDOWN 状态机
 *   s18 Worktree       → 真实 git worktree 隔离（spawnSync 调 git）+ 变更保护
 *   s19 MCP Plugin     → 进程内 MCP 服务器（教学版）+ 工具池装配（mcp__{server}__{tool}）
 *
 * Mock 只替换「模型调用」这一件事：并发任务、定时器、锁、持久化、git、协议全部是真实代码。
 * 默认 AGENT_MODE=mock 完全离线可跑，末尾打印 [S20] 完成。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { runAgent } from '../runtime/core.ts';
import type { Effect, EffectHandlers, PerformFn } from '../runtime/core.ts';
import type {
  LLMResponse,
  Message,
  TaskRecord,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '../runtime/types.ts';
import type { ToolSchema } from '../runtime/model.ts';
import { extractText, getToolUseBlocks } from '../runtime/response.ts';
import { callChat } from '../runtime/model.ts';
import { schemasFor } from '../runtime/tool-schemas.ts';
import { buildSystemPrompt } from '../runtime/system-prompt.ts';
import { Mutex } from '../runtime/locks.ts';
import { classifyError } from '../runtime/errors.ts';
import { resolveMode } from '../runtime/env.ts';
import {
  MAILBOXES_DIR,
  MEMORY_DIR,
  MEMORY_INDEX_PATH,
  SCHEDULED_TASKS_PATH,
  TASKS_DIR,
  TOOL_RESULTS_DIR,
  TRANSCRIPTS_DIR,
  WORKSPACE_ROOT,
  WORKTREE_EVENTS_PATH,
  WORKTREES_DIR,
} from '../runtime/workspace.ts';

// ============================================================
// Part 0: 常量 / 小工具
// ============================================================

const LEAD_ID = 'lead';
const WORKER_ID = 'worker';
const SUBAGENT_ID = 'subagent';
const WORKER_ROLE = '工程师';

const DEFAULT_MODEL = (process.env.MODEL_ID || '').trim() || 'claude-opus-4-5';
const FALLBACK_MODEL =
  (process.env.FALLBACK_MODEL_ID || '').trim() || (resolveMode() === 'mock' ? 'claude-haiku-4-5' : '');

const DEFAULT_MAX_TOKENS = 8000;
const ESCALATED_MAX_TOKENS = 16000;
const MAX_CONSECUTIVE_529 = 2;
const BASE_DELAY_MS = 500;
const MOCK_DELAY_SCALE = 0.02;

const CONTEXT_LIMIT = 50000;
const SNIP_MAX_MESSAGES = 50;
const KEEP_RECENT_TOOL_RESULTS = 3;
const TOOL_RESULT_MAX_BYTES = 200000;
const PERSIST_THRESHOLD = 30000;

const MAX_TEAMMATE_TURNS = 10;
const POLL_MS = 5;
const IDLE_POLL_INTERVAL_MS = Number(process.env.S20_IDLE_POLL_MS) || 20;
const IDLE_TIMEOUT_MS = Number(process.env.S20_IDLE_TIMEOUT_MS) || 8000;
const GATE_TIMEOUT_MS = 8000;
const CRON_TICK_MS = 20;
const WORKTREE_NAME = 's20-wt';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s);

const textBlock = (t: string): TextBlock => ({ type: 'text', text: t });
const toolUse = (id: string, name: string, input: Record<string, unknown>): ToolUseBlock => ({
  type: 'tool_use',
  id,
  name,
  input,
});

/** 全局确定性脚本状态：mock 只换「模型调用」，这些是它跨轮次记住的东西。 */
const memo = {
  leadRound: 0,
  teammateRound: 0,
  subagentRound: 0,
  planRequestId: '',
  // subject → 持久化任务 id：由 CreateTask handler 真实回填，
  // 让 mock 能引用真实 id（而非依赖扫描聊天文本），并真实演示 blockedBy DAG。
  taskIdBySubject: {} as Record<string, string>,
};

/** mock 计划注入的错误：leadRound → 该轮首次调用前抛出，重试后不再抛。 */
const leadErrorArms: Array<{ kind: '429' | '529'; count: number } | undefined> = [];
leadErrorArms[6] = { kind: '429', count: 1 }; // 429 → 退避重试
leadErrorArms[9] = { kind: '529', count: 2 }; // 连续 529 → 切换备用模型

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

interface ChatEffect
  extends Effect<
    'Chat',
    { messages: Message[]; agentId: string; system: string; tools: ToolSchema[]; model?: string; maxTokens?: number },
    LLMResponse
  > {}

interface PromptContext {
  memories: string;
  connectedMcp: string[];
  activeTeammates: string[];
}
interface AssemblePromptEffect extends Effect<'AssemblePrompt', { context: PromptContext }, string> {}
interface AssembleToolPoolEffect extends Effect<'AssembleToolPool', Record<string, never>, ToolSchema[]> {}

interface PrepareContextEffect
  extends Effect<'PrepareContext', { messages: Message[]; force?: boolean; reactive?: boolean }, Message[]> {}
interface PersistOutputEffect extends Effect<'PersistOutput', { toolUseId: string; content: string }, string> {}

interface BashExecEffect extends Effect<'BashExec', { command: string; worktreeId?: string }, string> {}
interface ReadFileEffect extends Effect<'ReadFile', { path: string; limit?: number }, string> {}
interface WriteFileEffect extends Effect<'WriteFile', { path: string; content: string; worktreeId?: string }, string> {}
interface EditFileEffect extends Effect<'EditFile', { path: string; oldText: string; newText: string }, string> {}
interface GlobSearchEffect extends Effect<'GlobSearch', { pattern: string }, string> {}

interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}
interface TodoWriteEffect extends Effect<'TodoWrite', { todos: TodoItem[] }, string> {}

interface SpawnSubagentEffect extends Effect<'SpawnSubagent', { description: string }, string> {}
interface LoadSkillEffect extends Effect<'LoadSkill', { name: string }, string> {}

interface ReadMemoryEffect extends Effect<'ReadMemory', { query?: string }, string> {}
interface WriteMemoryEffect extends Effect<'WriteMemory', { key: string; content: string }, string> {}

interface CreateTaskEffect
  extends Effect<'CreateTask', { subject: string; description?: string; blockedBy?: string[] }, TaskRecord> {}
interface ListTasksEffect extends Effect<'ListTasks', Record<string, never>, TaskRecord[]> {}
interface GetTaskEffect extends Effect<'GetTask', { taskId: string }, string> {}
interface ClaimResult {
  ok: boolean;
  task?: TaskRecord;
  error?: string;
}
interface ClaimTaskEffect extends Effect<'ClaimTask', { taskId: string; owner: string }, ClaimResult> {}
interface CompleteResult {
  ok: boolean;
  task?: TaskRecord;
  unblocked: string[];
  error?: string;
}
interface CompleteTaskEffect extends Effect<'CompleteTask', { taskId: string; owner: string }, CompleteResult> {}

interface IdleOutcome {
  state: 'work' | 'shutdown' | 'timeout';
  trigger?: 'inbox' | 'claimed' | 'timeout';
  inbox?: AgentMessage[];
  task?: WorktreeTask;
}
interface IdlePollEffect
  extends Effect<'IdlePoll', { agentId: string; pollIntervalMs?: number; autoClaim?: boolean }, IdleOutcome> {}

interface StartBackgroundEffect extends Effect<'StartBackground', { block: ToolUseBlock }, { bgId: string }> {}
interface CollectBackgroundResultsEffect extends Effect<'CollectBackgroundResults', Record<string, never>, string[]> {}

interface CronJob {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
}
interface ScheduleCronEffect
  extends Effect<
    'ScheduleCron',
    { cronId: string; cron: string; prompt: string; recurring?: boolean; durable?: boolean },
    CronJob
  > {}
interface ListCronsEffect extends Effect<'ListCrons', Record<string, never>, CronJob[]> {}
interface CancelCronEffect extends Effect<'CancelCron', { cronId: string }, { cancelled: boolean; cronId: string }> {}

interface AgentMessage {
  from: string;
  to: string;
  body: string;
  type: string;
  timestamp: number;
  metadata: Record<string, unknown>;
}

interface SpawnTeammateEffect
  extends Effect<'SpawnTeammate', { agentId: string; role: string }, { agentId: string; status: 'spawned' }> {}
interface SendMessageEffect
  extends Effect<
    'SendMessage',
    { from: string; to: string; body: string; type?: string; metadata?: Record<string, unknown> },
    { messageId: string }
  > {}
interface CheckInboxEffect
  extends Effect<'CheckInbox', { agentId: string; expectType?: string; waitMs?: number }, AgentMessage[]> {}

interface SubmitPlanEffect extends Effect<'SubmitPlan', { from: string; plan: string }, { requestId: string }> {}
interface GateOutcome {
  kind: 'approved' | 'rejected' | 'shutdown' | 'timeout';
  feedback?: string;
}
interface WaitForPlanResponseEffect
  extends Effect<'WaitForPlanResponse', { agentId: string; requestId: string }, GateOutcome> {}

interface Plan {
  requestId: string;
  goal: string;
  steps: string[];
  status: 'approved' | 'rejected';
  feedback: string;
}
interface RequestPlanEffect extends Effect<'RequestPlan', { goal: string; requestId?: string; context?: string }, Plan> {}
interface ReviewPlanEffect
  extends Effect<'ReviewPlan', { requestId: string; reviewerId: string; planText?: string }, { ok: boolean; approved: boolean; error?: string }> {}
interface RequestShutdownEffect
  extends Effect<'RequestShutdown', { agentId: string; reason?: string }, { acknowledged: boolean; requestId: string; responder: string }> {}

interface CreateWorktreeEffect
  extends Effect<'CreateWorktree', { worktreeId: string; branch?: string }, { ok: boolean; worktreeId: string; path?: string; reason?: string }> {}
interface RemoveWorktreeEffect
  extends Effect<'RemoveWorktree', { worktreeId: string; discardChanges?: boolean }, { removed: boolean; reason?: string }> {}
interface KeepWorktreeEffect
  extends Effect<'KeepWorktree', { worktreeId: string }, { kept: boolean; reason?: string }> {}

interface MCPConnectEffect
  extends Effect<'MCPConnect', { serverId: string }, { serverId: string; toolNames: string[] }> {}
interface MCPToolCallEffect
  extends Effect<'MCPToolCall', { serverId: string; toolName: string; args: Record<string, unknown> }, string> {}

interface RetryWithBackoffEffect
  extends Effect<'RetryWithBackoff', { attempt: number; errorType: '429' | '529'; retryAfterMs?: number }, void> {}
interface SwitchModelEffect extends Effect<'SwitchModel', { reason: string; fromModel: string }, string> {}

type S20Effect =
  | ChatEffect
  | AssemblePromptEffect
  | AssembleToolPoolEffect
  | PrepareContextEffect
  | PersistOutputEffect
  | BashExecEffect
  | ReadFileEffect
  | WriteFileEffect
  | EditFileEffect
  | GlobSearchEffect
  | TodoWriteEffect
  | SpawnSubagentEffect
  | LoadSkillEffect
  | ReadMemoryEffect
  | WriteMemoryEffect
  | CreateTaskEffect
  | ListTasksEffect
  | GetTaskEffect
  | ClaimTaskEffect
  | CompleteTaskEffect
  | IdlePollEffect
  | StartBackgroundEffect
  | CollectBackgroundResultsEffect
  | ScheduleCronEffect
  | ListCronsEffect
  | CancelCronEffect
  | SpawnTeammateEffect
  | SendMessageEffect
  | CheckInboxEffect
  | SubmitPlanEffect
  | WaitForPlanResponseEffect
  | RequestPlanEffect
  | ReviewPlanEffect
  | RequestShutdownEffect
  | CreateWorktreeEffect
  | RemoveWorktreeEffect
  | KeepWorktreeEffect
  | MCPConnectEffect
  | MCPToolCallEffect
  | RetryWithBackoffEffect
  | SwitchModelEffect;

// ============================================================
// Part 2: 真实任务存储（.tasks/ + blockedBy DAG）  —— s12 / s17
// ============================================================

interface WorktreeTask extends TaskRecord {
  worktree: string | null;
}

function ensureTasksDir(): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
}
function taskPath(id: string): string {
  return path.join(TASKS_DIR, `${id}.json`);
}
function newTaskId(): string {
  return `task_${Date.now()}_${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`;
}
function saveTask(task: WorktreeTask): void {
  ensureTasksDir();
  fs.writeFileSync(taskPath(task.id), JSON.stringify(task, null, 2), 'utf8');
}
function loadTask(id: string): WorktreeTask | null {
  const p = taskPath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as WorktreeTask;
}
function listTasksOrdered(): WorktreeTask[] {
  ensureTasksDir();
  return fs
    .readdirSync(TASKS_DIR)
    .filter((f) => /^task_.*\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8')) as WorktreeTask);
}
function blockingDeps(task: WorktreeTask): string[] {
  return (task.blockedBy || []).filter((id) => {
    const dep = loadTask(id);
    return dep !== null && dep.status !== 'completed';
  });
}
function canStart(id: string): boolean {
  const task = loadTask(id);
  if (!task) return false;
  return blockingDeps(task).length === 0;
}
function createTask(subject: string, description: string, blockedBy: string[]): WorktreeTask {
  const task: WorktreeTask = {
    id: newTaskId(),
    subject,
    description,
    status: 'pending',
    owner: null,
    blockedBy,
    worktree: null,
  };
  saveTask(task);
  return task;
}
function claimTask(id: string, owner: string): ClaimResult {
  const task = loadTask(id);
  if (!task) return { ok: false, error: `task ${id} not found` };
  if (task.status !== 'pending' || task.owner) {
    return { ok: false, error: `task ${id} not claimable (status=${task.status}, owner=${task.owner ?? '-'})` };
  }
  const blockers = blockingDeps(task);
  if (blockers.length > 0) return { ok: false, error: `task ${id} blocked by ${blockers.join(', ')}` };
  task.status = 'in_progress';
  task.owner = owner;
  saveTask(task);
  return { ok: true, task };
}
function completeTask(id: string, owner: string): CompleteResult {
  const task = loadTask(id);
  if (!task) return { ok: false, unblocked: [], error: `task ${id} not found` };
  if (task.status !== 'in_progress') return { ok: false, unblocked: [], error: `task ${id} not in progress` };
  if (task.owner && task.owner !== owner) {
    return { ok: false, unblocked: [], error: `task ${id} owned by ${task.owner}, not ${owner}` };
  }
  task.status = 'completed';
  saveTask(task);
  const unblocked = listTasksOrdered()
    .filter((t) => t.status === 'pending' && t.blockedBy.includes(id) && canStart(t.id))
    .map((t) => t.id);
  return { ok: true, task, unblocked };
}
function formatTaskList(tasks: (TaskRecord & { worktree?: string | null })[]): string {
  if (tasks.length === 0) return 'No tasks.';
  return tasks
    .map((t) => {
      const mark = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : '○';
      const owner = t.owner ? ` owner=${t.owner}` : '';
      const wt = t.worktree ? ` wt=${t.worktree}` : '';
      return `  ${mark} ${t.id}: ${t.subject} [${t.status}]${owner}${wt}`;
    })
    .join('\n');
}

// ============================================================
// Part 3: 真实 git worktree（spawnSync 调 git）  —— s18
// ============================================================

const VALID_WT_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const worktreePaths = new Map<string, string>();

function runGit(args: string[], cwd: string = WORKSPACE_ROOT): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return { ok: r.status === 0, out };
}
function ensureGitRepo(): void {
  const inside = runGit(['rev-parse', '--is-inside-work-tree']);
  if (inside.ok && inside.out.includes('true')) return;
  runGit(['init']);
  runGit([
    '-c',
    'user.email=agent@example.com',
    '-c',
    'user.name=Agent',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-m',
    'init',
  ]);
}
function validateWorktreeName(name: string): string | null {
  return VALID_WT_NAME.test(name) ? null : `invalid worktree name: ${JSON.stringify(name)}`;
}
function worktreePath(name: string): string {
  return path.join(WORKTREES_DIR, name);
}
function logWorktreeEvent(eventType: string, name: string, taskId = ''): void {
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  fs.appendFileSync(
    WORKTREE_EVENTS_PATH,
    JSON.stringify({ type: eventType, worktree: name, taskId, timestamp: Date.now() }) + '\n',
    'utf8',
  );
}
function countWorktreeChanges(wtPath: string): number {
  const st = runGit(['-C', wtPath, 'status', '--porcelain']);
  if (!st.ok) return 0;
  return st.out ? st.out.split('\n').filter((l) => l.trim()).length : 0;
}
function createWorktree(name: string, taskId = ''): { ok: boolean; worktreeId: string; path?: string; reason?: string } {
  const bad = validateWorktreeName(name);
  if (bad) return { ok: false, worktreeId: name, reason: bad };
  ensureGitRepo();
  const wtPath = worktreePath(name);
  // 可以重复执行：先清掉同名的残留 worktree 与分支，避免上次异常中断导致这次 add 失败
  if (fs.existsSync(wtPath)) runGit(['worktree', 'remove', '--force', wtPath]);
  runGit(['branch', '-D', `wt/${name}`]);
  const r = runGit(['worktree', 'add', wtPath, '-b', `wt/${name}`, 'HEAD']);
  if (!r.ok) return { ok: false, worktreeId: name, reason: `git worktree add failed: ${r.out}` };
  worktreePaths.set(name, wtPath);
  logWorktreeEvent('create', name, taskId);
  return { ok: true, worktreeId: name, path: wtPath };
}
function removeWorktree(name: string, discardChanges: boolean): { removed: boolean; reason?: string } {
  const wtPath = worktreePaths.get(name) ?? worktreePath(name);
  if (!fs.existsSync(wtPath)) {
    worktreePaths.delete(name);
    return { removed: false, reason: `worktree '${name}' not found` };
  }
  const files = countWorktreeChanges(wtPath);
  if (files > 0 && !discardChanges) {
    return {
      removed: false,
      reason: `worktree '${name}' has ${files} uncommitted change(s); use discard_changes=true or keep_worktree`,
    };
  }
  runGit(['worktree', 'remove', '--force', wtPath]);
  runGit(['branch', '-D', `wt/${name}`]);
  fs.rmSync(wtPath, { recursive: true, force: true });
  worktreePaths.delete(name);
  logWorktreeEvent('remove', name);
  return { removed: true };
}
function keepWorktree(name: string): { kept: boolean; reason?: string } {
  logWorktreeEvent('keep', name);
  return { kept: true, reason: `worktree '${name}' preserved for manual review` };
}
function cleanupAllWorktrees(): void {
  for (const name of [...worktreePaths.keys()]) removeWorktree(name, true);
  runGit(['worktree', 'prune']);
}

// ============================================================
// Part 4: Knowledge —— Memory(s09) / Skill(s07) / Todo(s05)
// ============================================================

function readMemoryFile(query?: string): string {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  if (!fs.existsSync(MEMORY_INDEX_PATH)) return '（无历史记忆）';
  const content = fs.readFileSync(MEMORY_INDEX_PATH, 'utf8');
  if (!query) return content.slice(0, 2000);
  const lines = content.split('\n').filter((l) => l.toLowerCase().includes(query.toLowerCase()));
  return lines.length ? lines.join('\n') : `（未找到与 "${query}" 相关的记忆）`;
}
function writeMemory(key: string, content: string): string {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const file = path.join(MEMORY_DIR, `${key}.md`);
  fs.writeFileSync(file, content, 'utf8');
  fs.appendFileSync(MEMORY_INDEX_PATH, `- ${key}: ${content.slice(0, 120)}\n`, 'utf8');
  return `Saved memory '${key}' → ${file}`;
}

const SKILLS: Record<string, string> = {
  'worktree-isolation': '# Worktree Isolation\n\n每个任务在独立 git worktree 中执行，main 分支保持可发布。',
  'context-compact': '# Context Compact\n\n四层压缩：budget → snip → micro → summarize。',
};
function loadSkill(name: string): string {
  const body = SKILLS[name];
  if (!body) return `Skill '${name}' not found. Available: ${Object.keys(SKILLS).join(', ')}`;
  return body;
}
function runTodoWrite(todos: TodoItem[]): string {
  const lines = todos.map((t) => `  [${t.status}] ${t.content}`).join('\n');
  return `Updated ${todos.length} todos:\n${lines}`;
}

// ============================================================
// Part 5: 上下文压缩管线（s08）
// ============================================================

function estimateSize(messages: Message[]): number {
  return JSON.stringify(messages).length;
}
function hasToolResult(m: Message): boolean {
  return Array.isArray(m.content) && m.content.some((b) => (b as { type?: string }).type === 'tool_result');
}
function toolResultBudget(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (!hasToolResult(m)) return m;
    const blocks = (m.content as ToolResultBlock[]).map((b) => {
      if (typeof b.content === 'string' && Buffer.byteLength(b.content, 'utf8') > TOOL_RESULT_MAX_BYTES) {
        return { ...b, content: `[budget] tool output too large (${b.content.length} chars), truncated` };
      }
      return b;
    });
    return { ...m, content: blocks };
  });
}
function snipCompact(messages: Message[], maxMessages = SNIP_MAX_MESSAGES): Message[] {
  if (messages.length <= maxMessages) return messages;
  const keep = messages.slice(-(maxMessages - 1));
  return [{ role: 'user', content: '[earlier conversation snipped]' }, ...keep];
}
function microCompact(messages: Message[]): Message[] {
  const toolUseIds: string[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Array<{ type?: string; id?: string }>) {
      if (b.type === 'tool_use' && b.id) toolUseIds.push(b.id);
    }
  }
  const keep = new Set(toolUseIds.slice(-KEEP_RECENT_TOOL_RESULTS));
  return messages.map((m) => {
    if (!hasToolResult(m)) return m;
    const blocks = (m.content as ToolResultBlock[]).map((b) =>
      keep.has(b.tool_use_id) ? b : { ...b, content: '[cleared]' },
    );
    return { ...m, content: blocks };
  });
}
function writeTranscript(messages: Message[]): string {
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  const file = path.join(TRANSCRIPTS_DIR, `transcript_${Date.now()}.jsonl`);
  fs.writeFileSync(file, messages.map((m) => JSON.stringify(m)).join('\n'), 'utf8');
  return file;
}
function mockSummarizer(messages: Message[]): LLMResponse {
  const n = messages.length;
  return {
    stop_reason: 'end_turn',
    content: [
      textBlock(
        `[对话摘要] 前 ${Math.max(0, n - 3)} 条消息已压缩：涵盖初始化、任务图、队友计划审批、worktree 与 cron 调度等步骤。`,
      ),
    ],
  };
}
async function compactHistory(messages: Message[]): Promise<Message[]> {
  if (messages.length <= 4) return messages;
  writeTranscript(messages);
  const head = messages.slice(0, messages.length - 4);
  const tail = messages.slice(-4);
  const summary = await callChat(mockSummarizer, head, { tools: [] });
  return [
    { role: 'user', content: extractText(summary) },
    { role: 'user', content: '[Compacted. Continue with summarized context.]' },
    ...tail,
  ];
}

// ============================================================
// Part 6: 错误恢复（s11）
// ============================================================

/** 跨轮次保存的错误恢复进度：是否已升级 max_tokens / 连续 529 计数 / 当前使用的模型。 */
class RecoveryState {
  hasEscalated = false;
  consecutive529 = 0;
  currentModel = DEFAULT_MODEL;
}
function retryDelayMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs) return retryAfterMs;
  const base = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), 8000);
  return Math.round((base + Math.random() * base * 0.25) * MOCK_DELAY_SCALE);
}
function readRetryAfterMs(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    const v = (error as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof v === 'number') return v;
  }
  return undefined;
}

// ============================================================
// Part 7: 后台任务（s13）
// ============================================================

interface BackgroundRecord {
  id: string;
  description: string;
  status: 'running' | 'done';
  result?: string;
}
const backgroundTasks = new Map<string, BackgroundRecord>();
const backgroundPromises = new Set<Promise<void>>();
let bgSeq = 0;

function startBackground(block: ToolUseBlock): string {
  bgSeq += 1;
  const bgId = `bg_${String(bgSeq).padStart(4, '0')}`;
  const record: BackgroundRecord = {
    id: bgId,
    description: `${block.name} ${truncate(JSON.stringify(block.input), 60)}`,
    status: 'running',
  };
  backgroundTasks.set(bgId, record);
  const p = (async () => {
    await sleep(15);
    record.status = 'done';
    record.result = `[task_notification] ${bgId} 完成: ${block.name} 已执行`;
    console.log(`  \x1b[32m[background] ${bgId} done\x1b[0m`);
  })();
  backgroundPromises.add(p);
  console.log(`  \x1b[36m[background] ${bgId} started\x1b[0m`);
  return bgId;
}
function collectBackgroundResults(): string[] {
  const notes: string[] = [];
  for (const rec of backgroundTasks.values()) {
    if (rec.status === 'done' && rec.result) {
      notes.push(rec.result);
      rec.result = undefined; // 消费一次
    }
  }
  return notes;
}
async function flushBackground(): Promise<void> {
  await Promise.allSettled([...backgroundPromises]);
}

// ============================================================
// Part 8: Cron 调度器（s14）—— 真实 setInterval + 持久化 + 队列
// ============================================================

const cronJobs = new Map<string, CronJob>();
const cronQueue: CronJob[] = [];
const cronLastFired = new Map<string, string>();
const cronLock = new Mutex();
let cronTimer: ReturnType<typeof setInterval> | undefined;

function cronFieldMatches(field: string, value: number): boolean {
  if (field === '*') return true;
  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = Number(stepStr);
      const [lo, hi] = range === '*' ? [0, 59] : range.split('-').map(Number);
      if (!step) return false;
      for (let v = lo; v <= hi; v += step) if (v === value) return true;
      continue;
    }
    if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      if (value >= lo && value <= hi) return true;
      continue;
    }
    if (Number(part) === value) return true;
  }
  return false;
}
function cronMatches(expr: string, dt: Date): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;
  return (
    cronFieldMatches(f[0], dt.getMinutes()) &&
    cronFieldMatches(f[1], dt.getHours()) &&
    cronFieldMatches(f[2], dt.getDate()) &&
    cronFieldMatches(f[3], dt.getMonth() + 1) &&
    cronFieldMatches(f[4], dt.getDay())
  );
}
function validateCron(expr: string): string | null {
  const f = expr.trim().split(/\s+/);
  return f.length !== 5 ? `cron must have 5 fields, got ${f.length}` : null;
}
function minuteMarker(dt: Date): string {
  return `${dt.getFullYear()}-${dt.getMonth()}-${dt.getDate()}-${dt.getHours()}-${dt.getMinutes()}`;
}
function saveDurableJobs(): void {
  const durable = [...cronJobs.values()].filter((j) => j.durable);
  fs.writeFileSync(SCHEDULED_TASKS_PATH, JSON.stringify(durable, null, 2), 'utf8');
}
function loadDurableJobs(): void {
  if (!fs.existsSync(SCHEDULED_TASKS_PATH)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(SCHEDULED_TASKS_PATH, 'utf8')) as CronJob[];
    for (const job of raw) cronJobs.set(job.id, job);
  } catch {
    /* 损坏的持久化文件忽略 */
  }
}
async function cronTick(): Promise<void> {
  const now = new Date();
  const marker = minuteMarker(now);
  await cronLock.withLock(() => {
    for (const job of [...cronJobs.values()]) {
      if (!cronMatches(job.cron, now)) continue;
      if (cronLastFired.get(job.id) === marker) continue;
      cronLastFired.set(job.id, marker);
      cronQueue.push(job);
      console.log(`  \x1b[35m[cron] fired ${job.id}: ${truncate(job.prompt, 50)}\x1b[0m`);
      if (!job.recurring) {
        cronJobs.delete(job.id);
        if (job.durable) saveDurableJobs();
      }
    }
  });
}
function startCronScheduler(): void {
  cronTimer = setInterval(() => void cronTick(), CRON_TICK_MS);
  cronTimer.unref?.();
}
function stopCronScheduler(): void {
  if (cronTimer) {
    clearInterval(cronTimer);
    cronTimer = undefined;
  }
}
function consumeCronQueue(): CronJob[] {
  const fired = cronQueue.slice();
  cronQueue.length = 0;
  return fired;
}

// ============================================================
// Part 9: 消息总线 + 协议状态机（s15 / s16）
// ============================================================

/**
 * 文件消息总线：每个 Agent 一个 `.jsonl` 信箱，一行一条 JSON 消息。
 *   send()      —— append 一行（真实追加写，可带 metadata）
 *   readInbox() —— 读出全部行并清空（消费式读取）
 *   requeue()   —— 把暂不处理的消息原样写回（等待协议响应时不丢其它消息）
 *
 * 并发队友会同时读写，用 Mutex 串行化 append / read-clear，避免交错写坏 JSONL。
 */
class MessageBus {
  private readonly mutex = new Mutex();
  private seq = 0;
  private inboxPath(agentId: string): string {
    return path.join(MAILBOXES_DIR, `${agentId}.jsonl`);
  }
  async send(
    from: string,
    to: string,
    body: string,
    type = 'message',
    metadata: Record<string, unknown> = {},
  ): Promise<string> {
    return this.mutex.withLock(() => {
      fs.mkdirSync(MAILBOXES_DIR, { recursive: true });
      const msg: AgentMessage = { from, to, body, type, timestamp: Date.now(), metadata };
      fs.appendFileSync(this.inboxPath(to), JSON.stringify(msg) + '\n', 'utf8');
      signalMailbox(to);
      console.log(`  \x1b[33m[bus] ${from} → ${to}: (${type}) ${truncate(body, 50)}\x1b[0m`);
      return `msg_${Date.now()}_${++this.seq}`;
    });
  }
  async readInbox(agentId: string): Promise<AgentMessage[]> {
    return this.mutex.withLock(() => {
      const p = this.inboxPath(agentId);
      if (!fs.existsSync(p)) return [];
      const msgs = fs
        .readFileSync(p, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as AgentMessage);
      fs.writeFileSync(p, '', 'utf8');
      return msgs;
    });
  }
  async requeue(agentId: string, msgs: AgentMessage[]): Promise<void> {
    if (msgs.length === 0) return;
    return this.mutex.withLock(() => {
      fs.mkdirSync(MAILBOXES_DIR, { recursive: true });
      fs.appendFileSync(this.inboxPath(agentId), msgs.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');
    });
  }
}
const BUS = new MessageBus();

const mailboxWaiters = new Map<string, () => void>();
function signalMailbox(agentId: string): void {
  const wake = mailboxWaiters.get(agentId);
  if (wake) {
    mailboxWaiters.delete(agentId);
    wake();
  }
}
function waitForMailbox(agentId: string, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      mailboxWaiters.delete(agentId);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    mailboxWaiters.set(agentId, () => {
      clearTimeout(timer);
      finish();
    });
  });
}

type ProtocolType = 'plan_approval' | 'shutdown';
interface ProtocolState {
  requestId: string;
  type: ProtocolType;
  sender: string;
  target: string;
  status: 'pending' | 'approved' | 'rejected';
  payload: string;
  createdAt: number;
}
const pendingRequests = new Map<string, ProtocolState>();
let reqSeq = 0;
function newRequestId(prefix = 'req'): string {
  reqSeq += 1;
  return `${prefix}_${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}_${reqSeq}`;
}
function expectedResponseType(type: ProtocolType): string {
  return type === 'shutdown' ? 'shutdown_response' : 'plan_approval_response';
}
/** 按 request_id + 类型双校验关联响应；未知/错类型/重复都会被拒绝并记录。 */
function matchResponse(responseType: string, requestId: string, approve: boolean): ProtocolState | null {
  const state = pendingRequests.get(requestId);
  if (!state) {
    console.log(`  \x1b[31m[protocol] unknown request_id: ${requestId}\x1b[0m`);
    return null;
  }
  const expected = expectedResponseType(state.type);
  if (responseType !== expected) {
    console.log(`  \x1b[31m[protocol] type mismatch: expected ${expected}, got ${responseType}\x1b[0m`);
    return null;
  }
  if (state.status !== 'pending') {
    console.log(`  \x1b[33m[protocol] ${requestId} already ${state.status}, ignoring duplicate\x1b[0m`);
    return null;
  }
  state.status = approve ? 'approved' : 'rejected';
  const icon = approve ? '✓' : '✗';
  const color = approve ? '32' : '31';
  console.log(`  \x1b[${color}m[protocol] ${state.type} ${icon} (${requestId})\x1b[0m`);
  return state;
}
async function consumeLeadInbox(routeProtocol = true): Promise<AgentMessage[]> {
  const msgs = await BUS.readInbox(LEAD_ID);
  if (routeProtocol) {
    for (const msg of msgs) {
      const reqId = String(msg.metadata['request_id'] ?? '');
      if (reqId && msg.type.endsWith('_response')) matchResponse(msg.type, reqId, Boolean(msg.metadata['approve']));
    }
  }
  return msgs;
}
async function pollForResponse(expectedRequestId: string, expectedType: string, maxPolls = 4000): Promise<AgentMessage | null> {
  for (let i = 0; i < maxPolls; i += 1) {
    const msgs = await BUS.readInbox(LEAD_ID);
    let matched: AgentMessage | null = null;
    const keep: AgentMessage[] = [];
    for (const msg of msgs) {
      const reqId = String(msg.metadata['request_id'] ?? '');
      const isResponse = reqId.length > 0 && msg.type.endsWith('_response');
      if (isResponse) matchResponse(msg.type, reqId, Boolean(msg.metadata['approve']));
      if (!matched && isResponse && reqId === expectedRequestId && msg.type === expectedType) matched = msg;
      else keep.push(msg);
    }
    if (keep.length > 0) await BUS.requeue(LEAD_ID, keep);
    if (matched) return matched;
    await sleep(POLL_MS);
  }
  console.log(`  \x1b[31m[protocol] timeout waiting for ${expectedType}\x1b[0m`);
  return null;
}

// ============================================================
// Part 10: MCP（s19）—— 进程内教学服务器 + 工具池装配
// ============================================================

interface MCPServer {
  serverId: string;
  tools: Array<{ name: string; description: string; handler: (args: Record<string, unknown>) => string }>;
}
const mcpClients = new Map<string, MCPServer>();
const mcpToolIndex = new Map<string, { serverId: string; toolName: string }>();

function mockServer(serverId: string): MCPServer | null {
  if (serverId === 'docs') {
    return {
      serverId,
      tools: [
        {
          name: 'search',
          description: 'Search documentation.',
          handler: (a) => `docs.search("${String(a['query'] ?? '')}") → 3 篇结果：oauth2-pkce, token-refresh, migration-guide`,
        },
        { name: 'fetch', description: 'Fetch a doc page.', handler: (a) => `docs.fetch("${String(a['id'] ?? '')}") → (doc content)` },
      ],
    };
  }
  if (serverId === 'deploy') {
    return {
      serverId,
      tools: [{ name: 'status', description: 'Deployment status.', handler: () => 'deploy.status() → all services healthy' }],
    };
  }
  return null;
}
function buildMcpToolName(serverId: string, toolName: string): string {
  const norm = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `mcp__${norm(serverId)}__${norm(toolName)}`;
}
function connectMcp(serverId: string): { serverId: string; toolNames: string[] } {
  const server = mockServer(serverId);
  if (!server) return { serverId, toolNames: [] };
  mcpClients.set(serverId, server);
  const toolNames = server.tools.map((t) => t.name);
  console.log(`  \x1b[34m[MCP] connected '${serverId}' → tools: ${toolNames.join(', ')}\x1b[0m`);
  return { serverId, toolNames };
}
function callMcpTool(serverId: string, toolName: string, args: Record<string, unknown>): string {
  const server = mcpClients.get(serverId);
  if (!server) return `MCP server '${serverId}' not connected`;
  const tool = server.tools.find((t) => t.name === toolName);
  if (!tool) return `MCP tool '${toolName}' not found on '${serverId}'`;
  return tool.handler(args);
}

// ============================================================
// Part 11: 工具 Schema（统一走 runtime 注册表）
// ============================================================

// lead（主 Agent）本地工具全集；连接 MCP 后，MCP 工具会在 AssembleToolPool 中动态并入。
const LEAD_LOCAL_TOOLS: ToolSchema[] = schemasFor(
  'bash',
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'todo_write',
  'task',
  'load_skill',
  'compact',
  'read_memory',
  'write_memory',
  'create_task',
  'list_tasks',
  'get_task',
  'claim_task',
  'complete_task',
  'schedule_cron',
  'list_crons',
  'cancel_cron',
  'spawn_teammate',
  'send_message',
  'check_inbox',
  'request_shutdown',
  'request_plan',
  'review_plan',
  'create_worktree',
  'remove_worktree',
  'keep_worktree',
  'mcp_connect',
);

// 队友可用工具：只能读写文件、收发消息、操作任务图与提交计划；不能拉起子代理或管理 worktree。
const TEAMMATE_TOOLS: ToolSchema[] = schemasFor(
  'bash',
  'read_file',
  'write_file',
  'send_message',
  'list_tasks',
  'claim_task',
  'complete_task',
  'submit_plan',
);

// 子代理只用基础文件/shell 工具，不参与任务图与协作协议（工具作用域隔离）。
const SUBAGENT_TOOLS: ToolSchema[] = schemasFor('bash', 'read_file', 'write_file', 'edit_file', 'glob');

// ============================================================
// Part 12: Mock 模型（唯一被替换的东西）
// ============================================================

function mockLead(messages: Message[]): LLMResponse {
  void messages; // 脚本状态已由 memo 驱动，不再扫描聊天文本
  const round = memo.leadRound;
  const arm = leadErrorArms[round];
  if (arm && arm.count > 0) {
    arm.count -= 1;
    throw Object.assign(
      new Error(arm.kind === '429' ? '429 rate limit exceeded' : '529 overloaded_error: service overloaded'),
      { status: Number(arm.kind) },
    );
  }
  // 用真实回填的 subject→id 映射引用任务（CreateTask handler 写入 memo）。
  const a = memo.taskIdBySubject['设计接口'] ?? '';
  const b = memo.taskIdBySubject['实现核心'] ?? '';
  const c = memo.taskIdBySubject['集成测试'] ?? '';
  const reqId = memo.planRequestId;

  const respond = (resp: LLMResponse): LLMResponse => {
    memo.leadRound += 1;
    return resp;
  };

  switch (round) {
    case 0:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('阶段1 初始化：读取历史记忆、加载技能、登记待办、连接 MCP 服务器。'),
          toolUse('L0a', 'read_memory', { query: '项目历史' }),
          toolUse('L0b', 'load_skill', { name: 'worktree-isolation' }),
          toolUse('L0c', 'todo_write', {
            todos: [
              { content: '初始化运行时', status: 'completed', activeForm: '初始化运行时' },
              { content: '规划认证重构任务图', status: 'in_progress', activeForm: '规划任务图' },
              { content: '隔离执行与验证', status: 'pending', activeForm: '隔离执行与验证' },
            ],
          }),
          toolUse('L0d', 'mcp_connect', { serverId: 'docs' }),
          toolUse('L0e', 'mcp_connect', { serverId: 'deploy' }),
        ],
      });
    case 1:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('阶段2 规划：拉起队友并请求一份执行计划（先派队友，避免其空转）。'),
          toolUse('L1a', 'spawn_teammate', { agentId: WORKER_ID, role: WORKER_ROLE }),
          toolUse('L1b', 'request_plan', { goal: '重构认证模块', context: '升级到 OAuth 2.0，保持向后兼容' }),
        ],
      });
    case 2:
      // 先创建无依赖的 A / B / D（C 依赖 A、B，下一轮才能引用真实 id）。
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('创建任务图的根节点：接口设计、核心实现、迁移说明。'),
          toolUse('L2a', 'create_task', { subject: '设计接口', description: '定义 OAuth2 适配器接口', blockedBy: [] }),
          toolUse('L2b', 'create_task', { subject: '实现核心', description: '实现 token 刷新', blockedBy: [] }),
          toolUse('L2d', 'create_task', { subject: '编写迁移说明', description: '面向升级用户的说明文档', blockedBy: [] }),
        ],
      });
    case 3:
      // C 依赖 A、B：用已回填的真实 id；并收取队友计划审批请求。
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('创建依赖 A、B 的集成测试任务，并等待队友的计划审批请求。'),
          toolUse('L3a', 'create_task', { subject: '集成测试', description: '端到端验证', blockedBy: [a, b] }),
          toolUse('L3b', 'check_inbox', { agentId: LEAD_ID, expectType: 'plan_approval_request' }),
        ],
      });
    case 4:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('调用 MCP 工具，检查被依赖阻塞的任务（claim 应失败），并审批队友计划。'),
          toolUse('L4a', 'mcp__docs__search', { query: 'oauth2' }),
          toolUse('L4b', 'get_task', { taskId: c }),
          toolUse('L4c', 'claim_task', { taskId: c }),
          toolUse('L4d', 'review_plan', { requestId: reqId, reviewerId: LEAD_ID }),
        ],
      });
    case 5:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('认领可开始的任务，并启动后台构建监控。'),
          toolUse('L5a', 'claim_task', { taskId: a }),
          toolUse('L5b', 'claim_task', { taskId: b }),
          toolUse('L5c', 'bash', { command: 'echo "start build monitor"', run_in_background: true }),
        ],
      });
    case 6:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('完成任务并产出文档（本轮会触发一次 429，由退避重试恢复）。'),
          toolUse('L6a', 'complete_task', { taskId: a }),
          toolUse('L6b', 'complete_task', { taskId: b }),
          toolUse('L6c', 'write_file', { path: 'docs/report.md', content: '# 认证重构报告\n\n1. 适配器接口\n2. token 刷新\n' }),
          toolUse('L6d', 'glob', { pattern: 'docs/*.md' }),
        ],
      });
    case 7:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('修订文档、读取文档，并派发子代理编写单元测试。'),
          toolUse('L7a', 'edit_file', { path: 'docs/report.md', oldText: '2. token 刷新', newText: '2. token 刷新（含 PKCE）' }),
          toolUse('L7b', 'read_file', { path: 'docs/report.md' }),
          toolUse('L7c', 'task', { description: '为认证适配器编写单元测试' }),
        ],
      });
    case 8:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('运行一个大输出命令，触发大结果落盘（PersistOutput）。'),
          toolUse('L8a', 'bash', { command: 'node -e "process.stdout.write(\'L\'.repeat(40000))"' }),
        ],
      });
    case 9:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('创建隔离 worktree（本轮连续 529，由模型切换恢复）。'),
          toolUse('L9a', 'create_worktree', { worktreeId: WORKTREE_NAME, branch: `wt/${WORKTREE_NAME}` }),
        ],
      });
    case 10:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('在 worktree 中执行写入，制造未提交变更。'),
          toolUse('L10a', 'bash', { command: 'echo "isolated change" > wt-note.txt', worktreeId: WORKTREE_NAME }),
        ],
      });
    case 11:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('尝试删除有变更的 worktree（应被拒绝），改为保留。'),
          toolUse('L11a', 'remove_worktree', { worktreeId: WORKTREE_NAME }),
          toolUse('L11b', 'keep_worktree', { worktreeId: WORKTREE_NAME }),
        ],
      });
    case 12:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('依赖已解除，认领并完成集成测试任务。'),
          toolUse('L12a', 'claim_task', { taskId: c }),
          toolUse('L12b', 'complete_task', { taskId: c }),
          toolUse('L12c', 'list_tasks', {}),
        ],
      });
    case 13:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('调度 cron：一个本分钟触发的巡检 + 一个每日持久任务，并取消后者。'),
          toolUse('L13a', 'schedule_cron', { cronId: 'health', cron: '* * * * *', prompt: '执行健康巡检', recurring: true, durable: false }),
          toolUse('L13b', 'schedule_cron', { cronId: 'nightly-cleanup', cron: '0 3 * * *', prompt: '清理临时文件', recurring: true, durable: true }),
          toolUse('L13c', 'cancel_cron', { cronId: 'nightly-cleanup' }),
        ],
      });
    case 14:
      return respond({
        stop_reason: 'tool_use',
        content: [textBlock('列出 cron 并压缩上下文。'), toolUse('L14a', 'list_crons', {}), toolUse('L14b', 'compact', { focus: '认证重构进度' })],
      });
    case 15:
      return respond({
        stop_reason: 'tool_use',
        content: [
          textBlock('丢弃变更并移除 worktree，然后查看任务总表。'),
          toolUse('L15a', 'remove_worktree', { worktreeId: WORKTREE_NAME, discard_changes: true }),
          toolUse('L15b', 'list_tasks', {}),
        ],
      });
    case 16:
      return respond({
        stop_reason: 'tool_use',
        content: [textBlock('任务完成，请求队友关闭（等待 shutdown_response）。'), toolUse('L16a', 'request_shutdown', { agentId: WORKER_ID, reason: '认证重构已完成' })],
      });
    case 17:
      return respond({
        stop_reason: 'tool_use',
        content: [textBlock('检查信箱收尾。'), toolUse('L17a', 'check_inbox', { agentId: LEAD_ID })],
      });
    default:
      return respond({
        stop_reason: 'end_turn',
        content: [textBlock('认证重构完成：任务图、队友协议、后台、cron、worktree、MCP 全部协同收尾。')],
      });
  }
}

function mockTeammate(): LLMResponse {
  const round = memo.teammateRound;
  switch (round) {
    case 0: {
      const plan = '执行计划：\n1. 分析现有认证逻辑\n2. 设计 OAuth 2.0 适配器接口\n3. 实现 token 刷新\n4. 补充向后兼容层';
      memo.teammateRound += 1;
      return { stop_reason: 'tool_use', content: [textBlock(plan), toolUse('T0a', 'submit_plan', { plan })] };
    }
    case 1:
      memo.teammateRound += 1;
      return { stop_reason: 'tool_use', content: [textBlock('计划已批准，查看任务总表。'), toolUse('T1a', 'list_tasks', {})] };
    case 2: {
      const d = memo.taskIdBySubject['编写迁移说明'] ?? '';
      memo.teammateRound += 1;
      return {
        stop_reason: 'tool_use',
        content: [
          textBlock(`认领并动手处理任务 ${d}。`),
          toolUse('T2a', 'claim_task', { taskId: d }),
          toolUse('T2b', 'write_file', { path: 'docs/worker-note.md', content: '# 迁移说明\n\n1. 更新依赖\n2. 切换 OAuth2\n' }),
        ],
      };
    }
    case 3: {
      const d = memo.taskIdBySubject['编写迁移说明'] ?? '';
      memo.teammateRound += 1;
      return { stop_reason: 'tool_use', content: [textBlock('任务完成。'), toolUse('T3a', 'complete_task', { taskId: d })] };
    }
    default:
      memo.teammateRound += 1;
      return { stop_reason: 'end_turn', content: [textBlock('worker：迁移说明已编写完成。')] };
  }
}

function mockSubagent(): LLMResponse {
  const round = memo.subagentRound;
  if (round === 0) {
    memo.subagentRound += 1;
    return {
      stop_reason: 'tool_use',
      content: [textBlock('子代理：检查测试目录。'), toolUse('S0a', 'bash', { command: 'echo "subagent scanning tests/"' })],
    };
  }
  memo.subagentRound += 1;
  return { stop_reason: 'end_turn', content: [textBlock('子代理：单元测试骨架已生成（3 个用例）。')] };
}

function mockModel(agentId: string, messages: Message[]): LLMResponse {
  if (agentId === LEAD_ID) return mockLead(messages);
  if (agentId === SUBAGENT_ID) return mockSubagent();
  void messages;
  return mockTeammate();
}

// ============================================================
// Part 13: 队友子循环（s15/s16/s17）+ 子代理（s06）
// ============================================================

const activeTeammates = new Map<string, Promise<string>>();

async function awaitTeammates(): Promise<void> {
  const pending = [...activeTeammates.values()];
  if (pending.length === 0) return;
  await Promise.allSettled(pending);
  activeTeammates.clear();
}
async function settleTeammatesWithin(ms: number): Promise<void> {
  await Promise.race([awaitTeammates(), sleep(ms)]);
}

function teammateSystemPrompt(agentId: string, role: string): string {
  return `你是 '${agentId}'，一名${role}。收到 lead 的计划请求后用 submit_plan 提交计划（这会关闭审批闸门，直到 lead 返回 plan_approval_response）；收到 shutdown_request 时优雅退出。`;
}

function* teammateLoop(perform: PerformFn<S20Effect>, agentId: string, role: string) {
  const messages: Message[] = [
    {
      role: 'user',
      content: `你是团队成员 '${agentId}'（${role}）。等待 lead 通过信箱派发任务：先提交计划等待审批，批准后执行任务，最后等待关闭。`,
    },
  ];
  let phase: 'await' | 'work' | 'done' = 'await';
  let workTurns = 0;
  let finalText = '';

  const finish = function* (why: string): Generator<S20Effect, string, { messageId: string }> {
    yield* perform({
      type: 'SendMessage',
      input: { from: agentId, to: LEAD_ID, body: finalText || why, type: 'result', metadata: {} },
    });
    console.log(`  \x1b[32m[teammate] ${agentId} finished (${why})\x1b[0m`);
    return finalText || why;
  };

  while (workTurns < MAX_TEAMMATE_TURNS) {
    if (phase === 'await' || phase === 'done') {
      const inbox = yield* perform({ type: 'CheckInbox', input: { agentId } });
      let groomed: AgentMessage[] = inbox;
      if (inbox.length === 0) {
        const outcome = yield* perform({
          type: 'IdlePoll',
          input: { agentId, pollIntervalMs: IDLE_POLL_INTERVAL_MS, autoClaim: false },
        });
        if (outcome.state === 'shutdown') return yield* finish('shutdown');
        if (outcome.state === 'timeout') break;
        if (outcome.inbox && outcome.inbox.length > 0) groomed = outcome.inbox;
        else groomed = [];
      }
      if (groomed.length > 0) {
        messages.push({ role: 'user', content: `<inbox>${JSON.stringify(groomed)}</inbox>` });
        if (phase === 'done') phase = 'await';
      } else if (phase === 'done') {
        continue; // 没有新消息，继续空闲等待
      }
    }

    workTurns += 1;
    const response = yield* perform({
      type: 'Chat',
      input: { messages, agentId, system: teammateSystemPrompt(agentId, role), tools: TEAMMATE_TOOLS },
    });
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      finalText = extractText(response);
      phase = 'done';
      continue;
    }

    const toolResults: ToolResultBlock[] = [];
    let shutdownNow = false;
    let gateMessage: string | null = null;
    for (const block of getToolUseBlocks(response)) {
      try {
        if (block.name === 'submit_plan') {
          const { requestId } = yield* perform({
            type: 'SubmitPlan',
            input: { from: agentId, plan: String(block.input['plan'] ?? '') },
          });
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Plan submitted (${requestId}); 等待审批中` });
          // 真的会在这里等：一直到 lead 返回匹配的 plan_approval_response 才继续
          const gate = yield* perform({ type: 'WaitForPlanResponse', input: { agentId, requestId } });
          if (gate.kind === 'shutdown') {
            shutdownNow = true;
            break;
          }
          gateMessage = gate.kind === 'approved' ? '[Plan approved] 继续执行。' : `[Plan rejected] ${gate.feedback ?? ''}`;
          phase = 'work';
          break; // 审批后的工具属于后续轮次，忽略本次响应里其余 block
        }
        let output: string;
        switch (block.name) {
          case 'bash':
            output = yield* perform({ type: 'BashExec', input: { command: String(block.input['command'] ?? '') } });
            break;
          case 'read_file': {
            const input: { path: string; limit?: number } = { path: String(block.input['path'] ?? '') };
            if (block.input['limit'] !== undefined) input.limit = Number(block.input['limit']);
            output = yield* perform({ type: 'ReadFile', input });
            break;
          }
          case 'write_file':
            output = yield* perform({
              type: 'WriteFile',
              input: { path: String(block.input['path'] ?? ''), content: String(block.input['content'] ?? '') },
            });
            break;
          case 'send_message': {
            const { messageId } = yield* perform({
              type: 'SendMessage',
              input: { from: agentId, to: String(block.input['to'] ?? ''), body: String(block.input['body'] ?? '') },
            });
            output = `已发送 (${messageId})`;
            break;
          }
          case 'list_tasks': {
            const tasks = yield* perform({ type: 'ListTasks', input: {} });
            output = formatTaskList(tasks);
            break;
          }
          case 'claim_task': {
            const res = yield* perform({ type: 'ClaimTask', input: { taskId: String(block.input['taskId'] ?? ''), owner: agentId } });
            output = res.ok ? `Claimed ${res.task?.id}` : `[错误] ${res.error}`;
            break;
          }
          case 'complete_task': {
            const res = yield* perform({ type: 'CompleteTask', input: { taskId: String(block.input['taskId'] ?? ''), owner: agentId } });
            output = res.ok
              ? `Completed ${res.task?.id}${res.unblocked.length ? `; unblocked: ${res.unblocked.join(', ')}` : ''}`
              : `[错误] ${res.error}`;
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
    if (shutdownNow) return yield* finish('shutdown');
    if (toolResults.length > 0) messages.push({ role: 'user', content: toolResults });
    if (gateMessage) messages.push({ role: 'user', content: gateMessage });
  }
  return yield* finish('idle-exit');
}

function* subagentLoop(perform: PerformFn<S20Effect>, description: string) {
  const messages: Message[] = [{ role: 'user', content: `子任务：${description}` }];
  while (true) {
    const response = yield* perform({
      type: 'Chat',
      input: {
        messages,
        agentId: SUBAGENT_ID,
        system: buildSystemPrompt('你是子代理，只返回最终摘要，不要冗长解释。'),
        tools: SUBAGENT_TOOLS,
      },
    });
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason !== 'tool_use') return extractText(response);
    const toolResults: ToolResultBlock[] = [];
    for (const block of getToolUseBlocks(response)) {
      try {
        let output: string;
        switch (block.name) {
          case 'bash':
            output = yield* perform({ type: 'BashExec', input: { command: String(block.input['command'] ?? '') } });
            break;
          case 'read_file':
            output = yield* perform({ type: 'ReadFile', input: { path: String(block.input['path'] ?? '') } });
            break;
          case 'write_file':
            output = yield* perform({
              type: 'WriteFile',
              input: { path: String(block.input['path'] ?? ''), content: String(block.input['content'] ?? '') },
            });
            break;
          case 'edit_file':
            output = yield* perform({
              type: 'EditFile',
              input: {
                path: String(block.input['path'] ?? ''),
                oldText: String(block.input['old_text'] ?? ''),
                newText: String(block.input['new_text'] ?? ''),
              },
            });
            break;
          case 'glob':
            output = yield* perform({ type: 'GlobSearch', input: { pattern: String(block.input['pattern'] ?? '') } });
            break;
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

function startTeammate(agentId: string, role: string): Promise<string> {
  const promise = runAgent<S20Effect, string>((perform) => teammateLoop(perform, agentId, role), s20Handlers).catch(
    (err: unknown) => {
      console.log(`  \x1b[31m[teammate] ${agentId} 异常: ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
      return '[teammate error]';
    },
  );
  activeTeammates.set(agentId, promise);
  return promise;
}

function updateContext(): PromptContext {
  let memories = '';
  if (fs.existsSync(MEMORY_INDEX_PATH)) memories = fs.readFileSync(MEMORY_INDEX_PATH, 'utf8').slice(0, 600);
  return { memories, connectedMcp: [...mcpClients.keys()], activeTeammates: [...activeTeammates.keys()] };
}

// ============================================================
// Part 14: Handler 实现（所有副作用在此）
// ============================================================

/** 把相对路径解析到 base 之下；越界（含同前缀兄弟目录）即抛错。 */
function safeChildPath(base: string, p: string): string {
  const resolved = path.resolve(base, p);
  const rel = path.relative(base, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

const s20Handlers: EffectHandlers<S20Effect> = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages, agentId, system, tools, model = DEFAULT_MODEL, maxTokens = DEFAULT_MAX_TOKENS } = effect.input;
    const tag =
      agentId === LEAD_ID ? `R${memo.leadRound}` : agentId === SUBAGENT_ID ? `S${memo.subagentRound}` : `t${memo.teammateRound}`;
    console.log(`\n[Chat:${agentId}] ${tag} (model=${model}, maxTokens=${maxTokens}, tools=${tools.length})`);
    // 让出一拍，令后台/定时器/队友有机会推进（教学版确定性）
    await sleep(15);
    const response = await callChat((m) => mockModel(agentId, m), messages, { tools, system, model, maxTokens });
    const used = getToolUseBlocks(response).map((b) => b.name).join(', ');
    console.log(`[Chat:${agentId}] ← ${response.stop_reason}${used ? `, 工具: ${used}` : ''}`);
    return response;
  },

  AssemblePrompt: async (effect: AssemblePromptEffect): Promise<string> => {
    const { memories, connectedMcp, activeTeammates } = effect.input.context;
    const clauses = [
      '你可以调度任务图、后台任务、cron、队友与隔离 worktree，并可通过 MCP 调用外部工具。',
      connectedMcp.length ? `已连接 MCP 服务器：${connectedMcp.join('、')}` : '',
      activeTeammates.length ? `活跃队友：${activeTeammates.join('、')}` : '',
      memories ? `记忆：\n${memories}` : '',
    ];
    return buildSystemPrompt(...clauses);
  },

  AssembleToolPool: async (): Promise<ToolSchema[]> => {
    mcpToolIndex.clear();
    const pool: ToolSchema[] = [...LEAD_LOCAL_TOOLS];
    for (const [serverId, server] of mcpClients) {
      for (const tool of server.tools) {
        const full = buildMcpToolName(serverId, tool.name);
        mcpToolIndex.set(full, { serverId, toolName: tool.name });
        pool.push({
          name: full,
          description: `[MCP:${serverId}] ${tool.description}`,
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string' }, id: { type: 'string' } },
            required: [],
          },
        });
      }
    }
    return pool;
  },

  PrepareContext: async (effect: PrepareContextEffect): Promise<Message[]> => {
    let msgs = effect.input.messages;
    if (effect.input.reactive) {
      console.log('  [reactive compact] 保留最近 5 条消息');
      const tail = msgs.slice(-5);
      return [{ role: 'user', content: '[Reactive compact] 前文已裁剪，从断点继续。' }, ...tail];
    }
    if (effect.input.force) return await compactHistory(msgs);
    msgs = toolResultBudget(msgs);
    msgs = snipCompact(msgs);
    msgs = microCompact(msgs);
    if (estimateSize(msgs) > CONTEXT_LIMIT) {
      console.log('  [compact] 超过上下文上限，执行 LLM 摘要压缩');
      msgs = await compactHistory(msgs);
    }
    return msgs;
  },

  PersistOutput: async (effect: PersistOutputEffect): Promise<string> => {
    fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
    const file = path.join(TOOL_RESULTS_DIR, `${effect.input.toolUseId}.txt`);
    fs.writeFileSync(file, effect.input.content, 'utf8');
    console.log(`  \x1b[33m[PersistOutput] ${effect.input.content.length} 字符 → ${file}\x1b[0m`);
    return `<persisted-output>\nFull output: ${file}\nPreview:\n${effect.input.content.slice(0, 2000)}\n</persisted-output>`;
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    const cwd = effect.input.worktreeId ? worktreePaths.get(effect.input.worktreeId) : undefined;
    console.log(`[BashExec] → ${effect.input.command}${cwd ? ` (cwd=${cwd})` : ''}`);
    const r = spawnSync(effect.input.command, {
      shell: true,
      cwd: cwd ?? WORKSPACE_ROOT,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.toString();
    return out.slice(0, 100000) || `(exit ${r.status ?? 'null'})`;
  },

  ReadFile: async (effect: ReadFileEffect): Promise<string> => {
    try {
      const target = safeChildPath(WORKSPACE_ROOT, effect.input.path);
      const lines = fs.readFileSync(target, 'utf8').split('\n');
      if (effect.input.limit && effect.input.limit < lines.length) {
        return [...lines.slice(0, effect.input.limit), `... (${lines.length - effect.input.limit} more lines)`].join('\n');
      }
      return lines.join('\n');
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  WriteFile: async (effect: WriteFileEffect): Promise<string> => {
    try {
      const base = effect.input.worktreeId ? worktreePaths.get(effect.input.worktreeId) ?? WORKSPACE_ROOT : WORKSPACE_ROOT;
      const target = safeChildPath(base, effect.input.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, effect.input.content, 'utf8');
      return `Wrote ${effect.input.content.length} bytes to ${effect.input.path}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  EditFile: async (effect: EditFileEffect): Promise<string> => {
    try {
      const target = safeChildPath(WORKSPACE_ROOT, effect.input.path);
      const content = fs.readFileSync(target, 'utf8');
      if (!content.includes(effect.input.oldText)) return `Error: old_text not found in ${effect.input.path}`;
      fs.writeFileSync(target, content.replace(effect.input.oldText, effect.input.newText), 'utf8');
      return `Edited ${effect.input.path}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  GlobSearch: async (effect: GlobSearchEffect): Promise<string> => {
    const pattern = effect.input.pattern;
    const dir = pattern.includes('/') ? pattern.slice(0, pattern.lastIndexOf('/')) : '.';
    const filePattern = pattern.includes('/') ? pattern.slice(pattern.lastIndexOf('/') + 1) : pattern;
    const re = new RegExp(
      '^' + filePattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    );
    try {
      const base = path.resolve(WORKSPACE_ROOT, dir);
      const hits = fs.readdirSync(base).filter((f) => re.test(f));
      return hits.length ? hits.map((h) => path.join(dir, h)).join('\n') : `No files matching ${pattern}`;
    } catch {
      return `No files matching ${pattern}`;
    }
  },

  TodoWrite: async (effect: TodoWriteEffect): Promise<string> => runTodoWrite(effect.input.todos),
  SpawnSubagent: async (effect: SpawnSubagentEffect): Promise<string> => {
    console.log(`\x1b[35m[SpawnSubagent] ${truncate(effect.input.description, 60)}\x1b[0m`);
    return runAgent<S20Effect, string>((perform) => subagentLoop(perform, effect.input.description), s20Handlers);
  },
  LoadSkill: async (effect: LoadSkillEffect): Promise<string> => loadSkill(effect.input.name),

  ReadMemory: async (effect: ReadMemoryEffect): Promise<string> => readMemoryFile(effect.input.query),
  WriteMemory: async (effect: WriteMemoryEffect): Promise<string> => writeMemory(effect.input.key, effect.input.content),

  CreateTask: async (effect: CreateTaskEffect): Promise<TaskRecord> => {
    const task = createTask(effect.input.subject, effect.input.description ?? '', effect.input.blockedBy ?? []);
    memo.taskIdBySubject[task.subject] = task.id; // 回填真实 id 供 mock 脚本引用
    console.log(`[CreateTask] ${task.id}: ${task.subject}${task.blockedBy.length ? ` (blockedBy ${task.blockedBy.join(',')})` : ''}`);
    return task;
  },
  ListTasks: async (): Promise<TaskRecord[]> => listTasksOrdered(),
  GetTask: async (effect: GetTaskEffect): Promise<string> => {
    const task = loadTask(effect.input.taskId);
    if (!task) return `task ${effect.input.taskId} not found`;
    return JSON.stringify({ ...task, blocked: blockingDeps(task) }, null, 2);
  },
  ClaimTask: async (effect: ClaimTaskEffect): Promise<ClaimResult> => {
    const res = claimTask(effect.input.taskId, effect.input.owner);
    console.log(`[ClaimTask] ${effect.input.taskId} by ${effect.input.owner}: ${res.ok ? 'ok' : res.error}`);
    return res;
  },
  CompleteTask: async (effect: CompleteTaskEffect): Promise<CompleteResult> => {
    const res = completeTask(effect.input.taskId, effect.input.owner);
    console.log(
      `[CompleteTask] ${effect.input.taskId}: ${res.ok ? `ok${res.unblocked.length ? ` (unblocked ${res.unblocked.join(',')})` : ''}` : res.error}`,
    );
    return res;
  },

  IdlePoll: async (effect: IdlePollEffect): Promise<IdleOutcome> => {
    const agentId = effect.input.agentId;
    const interval = effect.input.pollIntervalMs ?? IDLE_POLL_INTERVAL_MS;
    const autoClaim = effect.input.autoClaim !== false;
    const deadline = Date.now() + IDLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const inbox = await BUS.readInbox(agentId);
      if (inbox.length > 0) {
        for (const msg of inbox) {
          if (msg.type === 'shutdown_request') {
            const reqId = String(msg.metadata['request_id'] ?? '');
            await BUS.send(agentId, LEAD_ID, 'Shutting down gracefully.', 'shutdown_response', {
              request_id: reqId,
              approve: true,
              responder: agentId,
            });
            return { state: 'shutdown', trigger: 'inbox' };
          }
        }
        return { state: 'work', trigger: 'inbox', inbox };
      }
      if (autoClaim) {
        const unclaimed = listTasksOrdered().find((t) => t.status === 'pending' && !t.owner && canStart(t.id));
        if (unclaimed) {
          const res = claimTask(unclaimed.id, agentId);
          if (res.ok && res.task) {
            console.log(`  \x1b[36m[autonomous] ${agentId} auto-claimed ${res.task.id}\x1b[0m`);
            return { state: 'work', trigger: 'claimed', task: res.task as WorktreeTask };
          }
        }
      }
      await waitForMailbox(agentId, Math.min(interval, Math.max(1, deadline - Date.now())));
    }
    return { state: 'timeout', trigger: 'timeout' };
  },

  StartBackground: async (effect: StartBackgroundEffect): Promise<{ bgId: string }> => ({
    bgId: startBackground(effect.input.block),
  }),
  CollectBackgroundResults: async (): Promise<string[]> => collectBackgroundResults(),

  ScheduleCron: async (effect: ScheduleCronEffect): Promise<CronJob> => {
    const err = validateCron(effect.input.cron);
    if (err) throw new Error(err);
    const job: CronJob = {
      id: effect.input.cronId,
      cron: effect.input.cron,
      prompt: effect.input.prompt,
      recurring: effect.input.recurring ?? true,
      durable: effect.input.durable ?? false,
    };
    cronJobs.set(job.id, job);
    cronLastFired.delete(job.id);
    if (job.durable) saveDurableJobs();
    console.log(`[ScheduleCron] ${job.id} "${job.cron}" recurring=${job.recurring} durable=${job.durable}`);
    await sleep(CRON_TICK_MS + 40); // 让调度器真实 tick 一次，命中的任务进入队列
    return job;
  },
  ListCrons: async (): Promise<CronJob[]> => [...cronJobs.values()],
  CancelCron: async (effect: CancelCronEffect): Promise<{ cancelled: boolean; cronId: string }> => {
    const job = cronJobs.get(effect.input.cronId);
    const cancelled = cronJobs.delete(effect.input.cronId);
    if (job?.durable) saveDurableJobs();
    console.log(`[CancelCron] ${effect.input.cronId}: ${cancelled ? 'cancelled' : 'not found'}`);
    return { cancelled, cronId: effect.input.cronId };
  },

  SpawnTeammate: async (effect: SpawnTeammateEffect): Promise<{ agentId: string; status: 'spawned' }> => {
    const { agentId, role } = effect.input;
    if (activeTeammates.has(agentId)) return { agentId, status: 'spawned' };
    console.log(`\x1b[36m[SpawnTeammate] ${agentId} (${role})\x1b[0m`);
    startTeammate(agentId, role);
    await sleep(0);
    return { agentId, status: 'spawned' };
  },
  SendMessage: async (effect: SendMessageEffect): Promise<{ messageId: string }> => {
    const { from, to, body, type, metadata } = effect.input;
    return { messageId: await BUS.send(from, to, body, type ?? 'message', metadata ?? {}) };
  },
  CheckInbox: async (effect: CheckInboxEffect): Promise<AgentMessage[]> => {
    const { agentId, expectType, waitMs } = effect.input;
    if (expectType) {
      const deadline = Date.now() + (waitMs ?? GATE_TIMEOUT_MS);
      while (Date.now() < deadline) {
        const msgs = agentId === LEAD_ID ? await consumeLeadInbox(true) : await BUS.readInbox(agentId);
        const hit = msgs.find((m) => m.type === expectType);
        if (hit) {
          const rest = msgs.filter((m) => m !== hit);
          if (rest.length > 0) await BUS.requeue(agentId, rest);
          console.log(`[CheckInbox:${agentId}] 等到 ${expectType}`);
          return [hit];
        }
        if (msgs.length > 0) await BUS.requeue(agentId, msgs);
        await waitForMailbox(agentId, POLL_MS);
      }
      console.log(`[CheckInbox:${agentId}] 等待 ${expectType} 超时`);
      return [];
    }
    let msgs: AgentMessage[];
    if (agentId === LEAD_ID) {
      await settleTeammatesWithin(300);
      msgs = await consumeLeadInbox(true);
    } else {
      msgs = await BUS.readInbox(agentId);
    }
    console.log(`[CheckInbox:${agentId}] 收到 ${msgs.length} 条消息`);
    msgs.forEach((m) => console.log(`  ✉ [${m.type}] ${m.from}: ${truncate(m.body, 70)}`));
    return msgs;
  },

  SubmitPlan: async (effect: SubmitPlanEffect): Promise<{ requestId: string }> => {
    const requestId = newRequestId('plan');
    pendingRequests.set(requestId, {
      requestId,
      type: 'plan_approval',
      sender: effect.input.from,
      target: LEAD_ID,
      status: 'pending',
      payload: effect.input.plan,
      createdAt: Date.now(),
    });
    await BUS.send(effect.input.from, LEAD_ID, effect.input.plan, 'plan_approval_request', { request_id: requestId });
    memo.planRequestId = requestId; // 供 lead 侧 mock 审批时引用同一 request_id
    console.log(`[SubmitPlan] ${effect.input.from} 提交计划 ${requestId}（闸门关闭，等待审批）`);
    return { requestId };
  },
  WaitForPlanResponse: async (effect: WaitForPlanResponseEffect): Promise<GateOutcome> => {
    const { agentId, requestId } = effect.input;
    const deadline = Date.now() + GATE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const msgs = await BUS.readInbox(agentId);
      const keep: AgentMessage[] = [];
      for (const msg of msgs) {
        const reqId = String(msg.metadata['request_id'] ?? '');
        if (msg.type === 'shutdown_request') {
          await BUS.send(agentId, LEAD_ID, 'Shutting down gracefully.', 'shutdown_response', {
            request_id: reqId,
            approve: true,
            responder: agentId,
          });
          return { kind: 'shutdown' };
        }
        if (msg.type === 'plan_approval_response' && reqId === requestId) {
          const approved = Boolean(msg.metadata['approve']);
          console.log(`  \x1b[32m[gate] ${agentId} 收到审批 ${requestId}: ${approved ? 'approved' : 'rejected'}\x1b[0m`);
          return { kind: approved ? 'approved' : 'rejected', feedback: String(msg.metadata['feedback'] ?? '') };
        }
        keep.push(msg);
      }
      if (keep.length > 0) await BUS.requeue(agentId, keep);
      await waitForMailbox(agentId, POLL_MS);
    }
    return { kind: 'timeout' };
  },

  RequestPlan: async (effect: RequestPlanEffect): Promise<Plan> => {
    const { goal } = effect.input;
    console.log(`[RequestPlan] 请求 ${WORKER_ID} 提交计划: ${goal}`);
    await BUS.send(
      LEAD_ID,
      WORKER_ID,
      `请为下列目标提交执行计划：${goal}${effect.input.context ? `\n背景：${effect.input.context}` : ''}`,
      'message',
    );
    return { requestId: effect.input.requestId ?? '', goal, steps: [], status: 'approved', feedback: '已发出计划请求' };
  },
  ReviewPlan: async (effect: ReviewPlanEffect): Promise<{ ok: boolean; approved: boolean; error?: string }> => {
    const { requestId, reviewerId } = effect.input;
    const state = pendingRequests.get(requestId);
    if (!state) return { ok: false, approved: false, error: `request ${requestId} not found` };
    if (state.type !== 'plan_approval' || state.status !== 'pending') {
      return { ok: false, approved: false, error: `request ${requestId} not pending (type=${state.type}, status=${state.status})` };
    }
    // 真实审批规则：计划里至少列出 3 个编号步骤才批准，否则要求补充。
    const stepLines = state.payload.split('\n').filter((l) => /^\d+[.)、]/.test(l.trim()));
    const approved = stepLines.length >= 3;
    const feedback = approved ? `计划含 ${stepLines.length} 步，批准` : `仅 ${stepLines.length} 步，要求补充`;
    await BUS.send(reviewerId, state.sender, feedback, 'plan_approval_response', {
      request_id: requestId,
      approve: approved,
      feedback,
      reviewer: reviewerId,
    });
    // 经统一协议状态机结清该 pending 请求（approved/rejected），与响应双校验一致。
    matchResponse('plan_approval_response', requestId, approved);
    console.log(`[ReviewPlan] ${requestId}: ${approved ? '批准' : '拒绝'} → 回传 ${state.sender}`);
    return { ok: true, approved };
  },
  RequestShutdown: async (
    effect: RequestShutdownEffect,
  ): Promise<{ acknowledged: boolean; requestId: string; responder: string }> => {
    const { agentId } = effect.input;
    const requestId = newRequestId('shutdown');
    pendingRequests.set(requestId, {
      requestId,
      type: 'shutdown',
      sender: LEAD_ID,
      target: agentId,
      status: 'pending',
      payload: effect.input.reason ?? '',
      createdAt: Date.now(),
    });
    await BUS.send(LEAD_ID, agentId, effect.input.reason ? `请优雅关闭：${effect.input.reason}` : '请优雅关闭。', 'shutdown_request', {
      request_id: requestId,
    });
    console.log(`[RequestShutdown] ${agentId} ${requestId}（等待 shutdown_response）`);
    const resp = await pollForResponse(requestId, 'shutdown_response');
    if (!resp) return { acknowledged: false, requestId, responder: agentId };
    return { acknowledged: Boolean(resp.metadata['approve']), requestId, responder: resp.from };
  },

  CreateWorktree: async (
    effect: CreateWorktreeEffect,
  ): Promise<{ ok: boolean; worktreeId: string; path?: string; reason?: string }> => {
    const res = createWorktree(effect.input.worktreeId, effect.input.branch ?? '');
    console.log(`[CreateWorktree] ${effect.input.worktreeId}: ${res.ok ? res.path : res.reason}`);
    return res;
  },
  RemoveWorktree: async (effect: RemoveWorktreeEffect): Promise<{ removed: boolean; reason?: string }> => {
    const res = removeWorktree(effect.input.worktreeId, Boolean(effect.input.discardChanges));
    console.log(`[RemoveWorktree] ${effect.input.worktreeId}: ${res.removed ? 'removed' : res.reason}`);
    return res;
  },
  KeepWorktree: async (effect: KeepWorktreeEffect): Promise<{ kept: boolean; reason?: string }> => {
    const res = keepWorktree(effect.input.worktreeId);
    console.log(`[KeepWorktree] ${effect.input.worktreeId}: kept`);
    return res;
  },

  MCPConnect: async (effect: MCPConnectEffect): Promise<{ serverId: string; toolNames: string[] }> =>
    connectMcp(effect.input.serverId),
  MCPToolCall: async (effect: MCPToolCallEffect): Promise<string> => {
    console.log(`[MCPToolCall] ${effect.input.serverId}.${effect.input.toolName}`);
    return callMcpTool(effect.input.serverId, effect.input.toolName, effect.input.args);
  },

  RetryWithBackoff: async (effect: RetryWithBackoffEffect): Promise<void> => {
    const delay = retryDelayMs(effect.input.attempt, effect.input.retryAfterMs);
    console.log(`  \x1b[33m[Retry] ${effect.input.errorType} 第 ${effect.input.attempt + 1} 次，等待 ${delay}ms\x1b[0m`);
    await sleep(delay);
  },
  SwitchModel: async (effect: SwitchModelEffect): Promise<string> => {
    const next = FALLBACK_MODEL || effect.input.fromModel;
    console.log(`  \x1b[35m[SwitchModel] ${effect.input.fromModel} → ${next} (${effect.input.reason})\x1b[0m`);
    return next;
  },
};

// ============================================================
// Part 15: Lead Generator —— 把每个工具派发到对应 Effect
// ============================================================

function* leadLoop(perform: PerformFn<S20Effect>) {
  let messages: Message[] = [
    { role: 'user', content: '使用全部 Harness 机制完成一次认证模块重构：初始化 → 规划 → 计划审批 → 执行 → 隔离验证 → 收尾。' },
  ];
  const state = new RecoveryState();
  let maxTokens = DEFAULT_MAX_TOKENS;

  while (true) {
    // ── 注入：cron 队列 + 后台通知 ──
    for (const job of consumeCronQueue()) {
      messages.push({ role: 'user', content: `[Scheduled] ${job.prompt}` });
      console.log(`  \x1b[35m[cron inject] ${job.prompt}\x1b[0m`);
    }
    const bgNotes = yield* perform({ type: 'CollectBackgroundResults', input: {} });
    if (bgNotes.length > 0) messages.push({ role: 'user', content: bgNotes.map((n) => textBlock(n)) });

    // ── 上下文预算管线 + 提示词/工具池装配 ──
    messages = yield* perform({ type: 'PrepareContext', input: { messages } });
    const system = yield* perform({ type: 'AssemblePrompt', input: { context: updateContext() } });
    const tools = yield* perform({ type: 'AssembleToolPool', input: {} });

    // ── LLM 调用（含 429/529/过长 恢复）──
    let response: LLMResponse | undefined;
    let attempts = 0;
    while (!response && attempts < 50) {
      try {
        response = yield* perform({
          type: 'Chat',
          input: { messages, agentId: LEAD_ID, system, tools, model: state.currentModel, maxTokens },
        });
        state.consecutive529 = 0;
      } catch (error: unknown) {
        const kind = classifyError(error);
        if (kind === 'rate_limit') {
          yield* perform({
            type: 'RetryWithBackoff',
            input: { attempt: attempts, errorType: '429', retryAfterMs: readRetryAfterMs(error) },
          });
          attempts += 1;
          continue;
        }
        if (kind === 'overloaded') {
          state.consecutive529 += 1;
          if (state.consecutive529 >= MAX_CONSECUTIVE_529) {
            state.currentModel = yield* perform({
              type: 'SwitchModel',
              input: { reason: `连续 ${MAX_CONSECUTIVE_529} 次 529 过载`, fromModel: state.currentModel },
            });
            state.consecutive529 = 0;
          }
          yield* perform({
            type: 'RetryWithBackoff',
            input: { attempt: attempts, errorType: '529', retryAfterMs: readRetryAfterMs(error) },
          });
          attempts += 1;
          continue;
        }
        if (kind === 'prompt_too_long') {
          messages = yield* perform({ type: 'PrepareContext', input: { messages, reactive: true } });
          continue; // 不计次：压缩后重试同一请求
        }
        throw error;
      }
    }
    if (!response) {
      messages.push({ role: 'assistant', content: [textBlock('[Error] 重试耗尽')] });
      return '[Error] 重试耗尽';
    }

    // ── max_tokens 恢复路径 ──
    if (response.stop_reason === 'max_tokens') {
      if (!state.hasEscalated) {
        maxTokens = ESCALATED_MAX_TOKENS;
        state.hasEscalated = true;
        console.log(`  [max_tokens] 升级到 ${maxTokens}`);
        continue;
      }
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: '继续，从断点接着写，不要重复。' });
      continue;
    }
    maxTokens = DEFAULT_MAX_TOKENS;
    state.hasEscalated = false;
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') return extractText(response);

    // ── 工具派发 ──
    const toolResults: ToolResultBlock[] = [];
    let compactedNow = false;
    for (const block of getToolUseBlocks(response)) {
      try {
        if (block.name === 'compact') {
          messages = yield* perform({ type: 'PrepareContext', input: { messages, force: true } });
          messages.push({ role: 'user', content: '[Compacted. Continue with summarized context.]' });
          compactedNow = true;
          break;
        }
        if (block.name.startsWith('mcp__')) {
          const mapped = mcpToolIndex.get(block.name);
          if (!mapped) {
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `[MCP] 未知工具 ${block.name}（未装配）` });
            continue;
          }
          const out = yield* perform({
            type: 'MCPToolCall',
            input: { serverId: mapped.serverId, toolName: mapped.toolName, args: block.input },
          });
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: out });
          continue;
        }

        let output: string;
        switch (block.name) {
          case 'bash': {
            const command = String(block.input['command'] ?? '');
            if (block.input['run_in_background'] === true) {
              const { bgId } = yield* perform({ type: 'StartBackground', input: { block } });
              output = `[Background task ${bgId} started] 结果将以 task_notification 到达。`;
              break;
            }
            const input: { command: string; worktreeId?: string } = { command };
            if (block.input['worktreeId'] !== undefined) input.worktreeId = String(block.input['worktreeId']);
            output = yield* perform({ type: 'BashExec', input });
            break;
          }
          case 'read_file': {
            const input: { path: string; limit?: number } = { path: String(block.input['path'] ?? '') };
            if (block.input['limit'] !== undefined) input.limit = Number(block.input['limit']);
            output = yield* perform({ type: 'ReadFile', input });
            break;
          }
          case 'write_file': {
            const input: { path: string; content: string; worktreeId?: string } = {
              path: String(block.input['path'] ?? ''),
              content: String(block.input['content'] ?? ''),
            };
            if (block.input['worktreeId'] !== undefined) input.worktreeId = String(block.input['worktreeId']);
            output = yield* perform({ type: 'WriteFile', input });
            break;
          }
          case 'edit_file':
            output = yield* perform({
              type: 'EditFile',
              input: {
                path: String(block.input['path'] ?? ''),
                oldText: String(block.input['old_text'] ?? ''),
                newText: String(block.input['new_text'] ?? ''),
              },
            });
            break;
          case 'glob':
            output = yield* perform({ type: 'GlobSearch', input: { pattern: String(block.input['pattern'] ?? '') } });
            break;
          case 'todo_write': {
            const todos = Array.isArray(block.input['todos']) ? (block.input['todos'] as TodoItem[]) : [];
            output = yield* perform({ type: 'TodoWrite', input: { todos } });
            break;
          }
          case 'task':
            output = yield* perform({ type: 'SpawnSubagent', input: { description: String(block.input['description'] ?? '') } });
            break;
          case 'load_skill':
            output = yield* perform({ type: 'LoadSkill', input: { name: String(block.input['name'] ?? '') } });
            break;
          case 'read_memory': {
            const input: { query?: string } = {};
            if (block.input['query'] !== undefined) input.query = String(block.input['query']);
            output = yield* perform({ type: 'ReadMemory', input });
            break;
          }
          case 'write_memory':
            output = yield* perform({
              type: 'WriteMemory',
              input: { key: String(block.input['key'] ?? 'note'), content: String(block.input['content'] ?? '') },
            });
            break;
          case 'create_task': {
            const input: { subject: string; description?: string; blockedBy?: string[] } = {
              subject: String(block.input['subject'] ?? ''),
            };
            if (block.input['description'] !== undefined) input.description = String(block.input['description']);
            if (Array.isArray(block.input['blockedBy'])) input.blockedBy = block.input['blockedBy'] as string[];
            const task = yield* perform({ type: 'CreateTask', input });
            output = `Created ${task.id}: ${task.subject}`;
            break;
          }
          case 'list_tasks': {
            const tasks = yield* perform({ type: 'ListTasks', input: {} });
            output = formatTaskList(tasks as WorktreeTask[]);
            break;
          }
          case 'get_task':
            output = yield* perform({
              type: 'GetTask',
              input: { taskId: String(block.input['taskId'] ?? block.input['id'] ?? '') },
            });
            break;
          case 'claim_task': {
            const res = yield* perform({
              type: 'ClaimTask',
              input: { taskId: String(block.input['taskId'] ?? ''), owner: LEAD_ID },
            });
            output = res.ok ? `Claimed ${res.task?.id}` : `[错误] ${res.error}`;
            break;
          }
          case 'complete_task': {
            const res = yield* perform({
              type: 'CompleteTask',
              input: { taskId: String(block.input['taskId'] ?? ''), owner: LEAD_ID },
            });
            output = res.ok
              ? `Completed ${res.task?.id}${res.unblocked.length ? `; unblocked: ${res.unblocked.join(', ')}` : ''}`
              : `[错误] ${res.error}`;
            break;
          }
          case 'schedule_cron': {
            const input: { cronId: string; cron: string; prompt: string; recurring?: boolean; durable?: boolean } = {
              cronId: String(block.input['cronId'] ?? ''),
              cron: String(block.input['cron'] ?? ''),
              prompt: String(block.input['prompt'] ?? ''),
            };
            if (block.input['recurring'] !== undefined) input.recurring = Boolean(block.input['recurring']);
            if (block.input['durable'] !== undefined) input.durable = Boolean(block.input['durable']);
            const job = yield* perform({ type: 'ScheduleCron', input });
            output = `Scheduled ${job.id} (${job.cron})`;
            break;
          }
          case 'list_crons': {
            const jobs = yield* perform({ type: 'ListCrons', input: {} });
            output = jobs.length
              ? jobs.map((j) => `  ${j.id}: "${j.cron}" recurring=${j.recurring} durable=${j.durable}`).join('\n')
              : 'No cron jobs.';
            break;
          }
          case 'cancel_cron': {
            const res = yield* perform({ type: 'CancelCron', input: { cronId: String(block.input['cronId'] ?? '') } });
            output = res.cancelled ? `Cancelled ${res.cronId}` : `Not found: ${res.cronId}`;
            break;
          }
          case 'spawn_teammate': {
            const { agentId } = yield* perform({
              type: 'SpawnTeammate',
              input: { agentId: String(block.input['agentId'] ?? ''), role: String(block.input['role'] ?? '') },
            });
            output = `队友已创建: ${agentId}`;
            break;
          }
          case 'send_message': {
            const { messageId } = yield* perform({
              type: 'SendMessage',
              input: { from: LEAD_ID, to: String(block.input['to'] ?? ''), body: String(block.input['body'] ?? '') },
            });
            output = `消息已发送 (${messageId})`;
            break;
          }
          case 'check_inbox': {
            const input: { agentId: string; expectType?: string; waitMs?: number } = {
              agentId: String(block.input['agentId'] ?? LEAD_ID),
            };
            if (block.input['expectType'] !== undefined) input.expectType = String(block.input['expectType']);
            const msgs = yield* perform({ type: 'CheckInbox', input });
            output = msgs.length ? msgs.map((m) => `[${m.type}] ${m.from}: ${m.body}`).join('\n') : '信箱为空';
            break;
          }
          case 'request_plan': {
            const input: { goal: string; requestId?: string; context?: string } = { goal: String(block.input['goal'] ?? '') };
            if (block.input['context'] !== undefined) input.context = String(block.input['context']);
            const plan = yield* perform({ type: 'RequestPlan', input });
            output = `已请求计划: ${plan.goal}`;
            break;
          }
          case 'review_plan': {
            const input: { requestId: string; reviewerId: string; planText?: string } = {
              requestId: String(block.input['requestId'] ?? ''),
              reviewerId: String(block.input['reviewerId'] ?? LEAD_ID),
            };
            const res = yield* perform({ type: 'ReviewPlan', input });
            output = res.ok ? `计划 ${res.approved ? '已批准' : '被拒绝'}` : `[错误] ${res.error}`;
            break;
          }
          case 'request_shutdown': {
            const input: { agentId: string; reason?: string } = { agentId: String(block.input['agentId'] ?? '') };
            if (block.input['reason'] !== undefined) input.reason = String(block.input['reason']);
            const ack = yield* perform({ type: 'RequestShutdown', input });
            output = `关闭确认 (${ack.requestId}): acknowledged=${ack.acknowledged} ← ${ack.responder}`;
            break;
          }
          case 'create_worktree': {
            const res = yield* perform({
              type: 'CreateWorktree',
              input: { worktreeId: String(block.input['worktreeId'] ?? ''), branch: String(block.input['branch'] ?? '') },
            });
            output = res.ok ? `worktree ${res.worktreeId} created at ${res.path}` : `[错误] ${res.reason}`;
            break;
          }
          case 'remove_worktree': {
            const res = yield* perform({
              type: 'RemoveWorktree',
              input: {
                worktreeId: String(block.input['worktreeId'] ?? ''),
                discardChanges: Boolean(block.input['discard_changes']),
              },
            });
            output = res.removed ? 'worktree removed' : `[拒绝] ${res.reason}`;
            break;
          }
          case 'keep_worktree': {
            const res = yield* perform({
              type: 'KeepWorktree',
              input: { worktreeId: String(block.input['worktreeId'] ?? '') },
            });
            output = res.kept ? `worktree kept: ${res.reason}` : `[错误] ${res.reason}`;
            break;
          }
          case 'mcp_connect': {
            const res = yield* perform({ type: 'MCPConnect', input: { serverId: String(block.input['serverId'] ?? '') } });
            output = `MCP '${res.serverId}' connected: ${res.toolNames.join(', ') || '(no tools)'}`;
            break;
          }
          default:
            output = `[未知工具] ${block.name}`;
        }

        // 大输出写入磁盘（s08 L3）
        if (output.length > PERSIST_THRESHOLD) {
          output = yield* perform({ type: 'PersistOutput', input: { toolUseId: block.id, content: output } });
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

    if (compactedNow) continue;
    if (toolResults.length > 0) messages.push({ role: 'user', content: toolResults });
  }
}

// ============================================================
// Part 16: 启动入口 + 收尾
// ============================================================

fs.mkdirSync(TASKS_DIR, { recursive: true });
fs.mkdirSync(MEMORY_DIR, { recursive: true });
fs.mkdirSync(MAILBOXES_DIR, { recursive: true });
fs.writeFileSync(path.join(MAILBOXES_DIR, `${LEAD_ID}.jsonl`), '', 'utf8');
fs.writeFileSync(path.join(MAILBOXES_DIR, `${WORKER_ID}.jsonl`), '', 'utf8');

console.log('[S20] Comprehensive — 整合 Harness 启动');
console.log(`  模式: ${resolveMode()}  工作区: ${WORKSPACE_ROOT}`);
console.log(`  任务: ${TASKS_DIR}  信箱: ${MAILBOXES_DIR}  worktree: ${WORKTREES_DIR}\n`);

loadDurableJobs();
startCronScheduler();
cleanupAllWorktrees(); // 清掉上次异常中断的残留

const result = await runAgent<S20Effect, string>(leadLoop, s20Handlers);

await awaitTeammates();
stopCronScheduler();
cleanupAllWorktrees();
await flushBackground();

console.log('\n[Protocol] 协议请求汇总:');
for (const [id, req] of pendingRequests) {
  console.log(`  ${id}: type=${req.type} ${req.sender}→${req.target} [${req.status}]`);
}

// 负向自检：未知 / 错类型 / 重复响应必须被拒绝，而不是被静默接受
console.log('\n[Protocol] 负向自检 (match_response 拒绝孤立/错类型/重复响应):');
matchResponse('plan_approval_response', 'req_does_not_exist', true);
const probeId = newRequestId('probe');
pendingRequests.set(probeId, {
  requestId: probeId,
  type: 'shutdown',
  sender: LEAD_ID,
  target: WORKER_ID,
  status: 'pending',
  payload: '',
  createdAt: Date.now(),
});
matchResponse('plan_approval_response', probeId, true);
matchResponse('shutdown_response', probeId, false);
matchResponse('shutdown_response', probeId, true);
pendingRequests.delete(probeId);

console.log(`\n[S20] 结果: ${truncate(result, 200)}`);
console.log('[S20] 完成');
