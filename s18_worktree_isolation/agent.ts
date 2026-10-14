/**
 * s18: Git Worktree Isolation — Worktree 是代码变更的效应沙箱
 *
 * 本章在 s12 任务系统之上新增 3 个 Effect：
 *   CreateWorktree — 真实执行 `git worktree add <path> -b wt/<name> HEAD`
 *   BindWorktree   — 把任务绑定到某个 worktree（真实写入 .tasks/*.json 的 worktree 字段）
 *   RemoveWorktree — 真实执行 `git worktree remove --force` + `git branch -D wt/<name>`
 *
 * 核心思想：Worktree = 文件系统层面的效应作用域隔离。
 * 就像 s06 的 Delegate 隔离了消息上下文，Worktree 隔离了文件系统变更。
 *
 * 所有 git 操作都是真实的，mock 只替代「模型调用」。
 * 路径来自 runtime/workspace.ts：
 *   WORKTREES_DIR        = <workspace>/.worktrees
 *   WORKTREE_EVENTS_PATH = <workspace>/.worktrees/events.jsonl
 *
 * 环境约束（e2e 会用一个全新临时目录作为 AGENT_WORKSPACE，而 cwd 是仓库根）：
 *   git 命令一律以 WORKSPACE_ROOT 为仓库；若它不是 git 仓库，启动时自动 `git init`
 *   并创建一个空的初始提交，保证 HEAD 存在（`worktree add -b ... HEAD` 需要）。
 */

import { runAgent } from '../runtime/core.ts';
import type { Effect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, TaskRecord, ToolResultBlock } from '../runtime/types.ts';
import { extractText, getToolUseBlocks } from '../runtime/response.ts';
import { callChat } from '../runtime/model.ts';
import { schemasFor } from '../runtime/tool-schemas.ts';
import { buildSystemPrompt } from '../runtime/system-prompt.ts';
import {
  WORKSPACE_ROOT,
  TASKS_DIR,
  WORKTREES_DIR,
  WORKTREE_EVENTS_PATH,
} from '../runtime/workspace.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

interface ChatEffect extends Effect<'Chat', { messages: Message[] }, LLMResponse> {}

interface BashExecEffect extends Effect<'BashExec', { command: string; cwd?: string }, string> {}

// s12：真实任务系统（持久化 + 依赖图）。s18 起 TaskRecord 增加 worktree 字段。
interface CreateTaskEffect
  extends Effect<'CreateTask', { subject: string; description: string; blockedBy?: string[] }, WorktreeTask> {}

interface ListTasksEffect extends Effect<'ListTasks', Record<string, never>, WorktreeTask[]> {}

interface GetTaskEffect extends Effect<'GetTask', { taskId: string }, string> {}

/** 认领结果：成功返回任务；失败返回可读的拒绝原因。 */
type ClaimResult = { ok: true; task: WorktreeTask } | { ok: false; error: string };

/** 完成结果：成功返回任务 + 被解锁的下游；失败返回拒绝原因。 */
type CompleteResult =
  | { ok: true; task: WorktreeTask; unblocked: WorktreeTask[] }
  | { ok: false; error: string };

interface ClaimTaskEffect extends Effect<'ClaimTask', { taskId: string; owner?: string }, ClaimResult> {}

interface CompleteTaskEffect extends Effect<'CompleteTask', { taskId: string }, CompleteResult> {}

/** worktree 操作结果：ok=false 时 message 为可读的错误说明。 */
interface WorktreeOpResult {
  ok: boolean;
  message: string;
}

// s18 新增：worktree 生命周期
interface CreateWorktreeEffect
  extends Effect<'CreateWorktree', { name: string; taskId?: string }, WorktreeOpResult> {}

interface BindWorktreeEffect
  extends Effect<'BindWorktree', { name: string; taskId: string }, WorktreeOpResult> {}

interface RemoveWorktreeEffect
  extends Effect<'RemoveWorktree', { name: string; discardChanges?: boolean }, WorktreeOpResult> {}

interface KeepWorktreeEffect extends Effect<'KeepWorktree', { name: string }, WorktreeOpResult> {}

type S18Effect =
  | ChatEffect
  | BashExecEffect
  | CreateTaskEffect
  | ListTasksEffect
  | GetTaskEffect
  | ClaimTaskEffect
  | CompleteTaskEffect
  | CreateWorktreeEffect
  | BindWorktreeEffect
  | RemoveWorktreeEffect
  | KeepWorktreeEffect;

// ============================================================
// Part 2: 真实 git 执行器
//
// spawnSync 捕获 stdout/stderr/status；git 失败绝不抛异常，而是返回 ok=false。
// 返回 (ok, output) 二元结果。
// ============================================================

interface GitResult {
  ok: boolean;
  /** 合并后的 stdout + stderr（已 trim），原始值，可能为空串。 */
  out: string;
}

function runGit(args: string[], cwd: string = WORKSPACE_ROOT): GitResult {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error) {
    return { ok: false, out: `Error: ${r.error.message}` };
  }
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return { ok: r.status === 0, out };
}

/** 展示用：空输出统一成 "(no output)"。 */
function gitOut(res: GitResult): string {
  return res.out || '(no output)';
}

/** 确保 WORKSPACE_ROOT 是一个可用的 git 仓库，且 HEAD 存在。 */
function ensureGitRepo(): void {
  if (runGit(['rev-parse', '--git-dir']).ok) return;

  runGit(['init']);
  // 空提交，保证 HEAD 存在——`git worktree add -b wt/<name> HEAD` 需要一个 commit。
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
    's18 worktree demo base',
  ]);
}

/** child 是否位于 parent 目录之下（用于识别本章管理的 worktree）。 */
function isUnder(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

/**
 * 清理本章创建的所有 worktree 与 wt/* 分支。
 *
 * - 删除所有位于 WORKTREES_DIR 下的已注册 worktree（保留主工作区）；
 * - prune 失效的 worktree 管理数据；
 * - 删除残留的物理目录；
 * - 删除 refs/heads/wt/* 分支。
 *
 * 启动时与退出时各调用一次，保证重复运行可复现、仓库保持干净。
 */
function cleanupWorktrees(): void {
  const list = runGit(['worktree', 'list', '--porcelain']);
  if (list.ok) {
    for (const line of list.out.split(/\r?\n/)) {
      const m = /^worktree (.+)$/.exec(line.trim());
      if (!m) continue;
      const wtPath = m[1];
      if (path.resolve(wtPath) === path.resolve(WORKSPACE_ROOT)) continue;
      if (isUnder(wtPath, WORKTREES_DIR)) {
        runGit(['worktree', 'remove', '--force', wtPath]);
      }
    }
  }
  runGit(['worktree', 'prune']);

  // 物理目录兜底（worktree remove 失败或从未注册时残留）。
  try {
    if (fs.existsSync(WORKTREES_DIR)) {
      for (const entry of fs.readdirSync(WORKTREES_DIR)) {
        const full = path.join(WORKTREES_DIR, entry);
        if (fs.statSync(full).isDirectory()) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      }
    }
  } catch {
    // 清理失败不阻断演示
  }

  const refs = runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads/wt/']);
  if (refs.ok) {
    for (const branch of refs.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      runGit(['branch', '-D', branch]);
    }
  }
}

// ============================================================
// Part 2b: 真实任务存储（持久化 + 依赖检查 + worktree 字段）
// ============================================================

/** s18：任务记录在 s12 的 TaskRecord 上增加 worktree 绑定字段。 */
interface WorktreeTask extends TaskRecord {
  worktree: string | null;
}

function ensureTasksDir(): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
}

/** 任务文件路径：<TASKS_DIR>/<task_id>.json。 */
function taskPath(taskId: string): string {
  return path.join(TASKS_DIR, `${taskId}.json`);
}

/** 任务 ID 格式：task_{epochSeconds}_{4 位随机数}。 */
function generateTaskId(): string {
  const seconds = Math.floor(Date.now() / 1000);
  const suffix = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  return `task_${seconds}_${suffix}`;
}

function saveTask(task: WorktreeTask): void {
  ensureTasksDir();
  fs.writeFileSync(taskPath(task.id), JSON.stringify(task, null, 2), 'utf8');
}

function loadTask(taskId: string): WorktreeTask | null {
  const file = taskPath(taskId);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WorktreeTask>;
    return { ...(parsed as WorktreeTask), worktree: parsed.worktree ?? null };
  } catch {
    return null;
  }
}

function createTask(subject: string, description = '', blockedBy: string[] = []): WorktreeTask {
  const task: WorktreeTask = {
    id: generateTaskId(),
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

/** 扫描 .tasks/task_*.json，按 id 排序。 */
function listTasks(): WorktreeTask[] {
  ensureTasksDir();
  return fs
    .readdirSync(TASKS_DIR)
    .filter((f) => /^task_.*\.json$/.test(f))
    .map((f) => {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8')) as Partial<WorktreeTask>;
        return { ...(parsed as WorktreeTask), worktree: parsed.worktree ?? null };
      } catch {
        return null;
      }
    })
    .filter((t): t is WorktreeTask => t !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function getTaskJson(taskId: string): string {
  const task = loadTask(taskId);
  if (!task) return `Error: Task ${taskId} not found`;
  return JSON.stringify(task, null, 2);
}

/** 只有当所有 blockedBy 依赖都存在且已完成时才能启动。 */
function canStart(taskId: string): boolean {
  const task = loadTask(taskId);
  if (!task) return false;
  return task.blockedBy.every((depId) => {
    const dep = loadTask(depId);
    return dep !== null && dep.status === 'completed';
  });
}

/** 返回仍然阻塞该任务的依赖 ID（文件缺失或状态非 completed）。 */
function blockingDeps(task: WorktreeTask): string[] {
  return task.blockedBy.filter((depId) => {
    const dep = loadTask(depId);
    return dep === null || dep.status !== 'completed';
  });
}

function claimTask(taskId: string, owner = 'agent'): ClaimResult {
  const task = loadTask(taskId);
  if (!task) return { ok: false, error: `Error: Task ${taskId} not found` };
  if (task.status !== 'pending') {
    return { ok: false, error: `Task ${taskId} is ${task.status}, cannot claim` };
  }
  if (task.owner) {
    return { ok: false, error: `Task ${taskId} already owned by ${task.owner}` };
  }
  const blocking = blockingDeps(task);
  if (blocking.length > 0) {
    return { ok: false, error: `Cannot start — blocked by: ${blocking.join(', ')}` };
  }
  task.owner = owner;
  task.status = 'in_progress';
  saveTask(task);
  return { ok: true, task };
}

function completeTask(taskId: string): CompleteResult {
  const task = loadTask(taskId);
  if (!task) return { ok: false, error: `Error: Task ${taskId} not found` };
  if (task.status !== 'in_progress') {
    return { ok: false, error: `Task ${taskId} is ${task.status}, cannot complete` };
  }
  task.status = 'completed';
  saveTask(task);
  const unblocked = listTasks().filter(
    (t) => t.status === 'pending' && t.blockedBy.length > 0 && canStart(t.id),
  );
  return { ok: true, task, unblocked };
}

/** 可读的任务列表（含 wt: 绑定标注）。 */
function formatTaskList(tasks: WorktreeTask[]): string {
  if (tasks.length === 0) return 'No tasks.';
  return tasks
    .map((t) => `  ${t.id}: ${t.subject} [${t.status}]${t.worktree ? ` (wt:${t.worktree})` : ''}`)
    .join('\n');
}

// ============================================================
// Part 2c: 真实 Worktree 系统
// ============================================================

const VALID_WT_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** 返回错误信息（字符串）表示非法，返回 null 表示合法。 */
function validateWorktreeName(name: string): string | null {
  if (!name) return 'Worktree name cannot be empty';
  if (name === '.' || name === '..') return `'${name}' is not a valid worktree name`;
  if (!VALID_WT_NAME.test(name)) {
    return (
      `Invalid worktree name '${name}': ` +
      'only letters, digits, dots, underscores, dashes (1-64 chars)'
    );
  }
  return null;
}

/** 某 worktree 的目录路径：<workspace>/.worktrees/<name>。 */
function worktreePath(name: string): string {
  return path.join(WORKTREES_DIR, name);
}

/** 本章创建的 worktree：name → 绝对路径（供 bash 的 cwd 路由与清理）。 */
const worktreePaths = new Map<string, string>();

/** 追加一条生命周期事件到 .worktrees/events.jsonl。 */
function logEvent(type: 'create' | 'bind' | 'remove' | 'keep', worktree: string, taskId = ''): void {
  const event = { type, worktree, task_id: taskId, ts: Date.now() / 1000 };
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  fs.appendFileSync(WORKTREE_EVENTS_PATH, JSON.stringify(event) + '\n', 'utf8');
}

/**
 * 统计 worktree 的未提交文件数与相对基准的本地提交数。
 * 失败返回 (-1, -1)。
 */
function countWorktreeChanges(wtPath: string): { files: number; commits: number } {
  const status = runGit(['status', '--porcelain'], wtPath);
  if (!status.ok) return { files: -1, commits: -1 };
  const files = status.out.split(/\r?\n/).filter((l) => l.trim()).length;

  // 基准 = 主工作区当前 HEAD 的 commit SHA。新建 worktree 从 HEAD 分出，故初始为 0。
  const base = runGit(['rev-parse', 'HEAD']);
  const baseRef = base.ok ? base.out.trim() : '';
  let commits = 0;
  if (baseRef) {
    const count = runGit(['rev-list', '--count', 'HEAD', '--not', baseRef], wtPath);
    commits = count.ok ? Number(count.out.trim()) || 0 : 0;
  }
  return { files, commits };
}

/** 真实创建 worktree：`git worktree add <path> -b wt/<name> HEAD`，可选绑定任务。 */
function createWorktree(name: string, taskId = ''): WorktreeOpResult {
  const err = validateWorktreeName(name);
  if (err) return { ok: false, message: `Error: ${err}` };

  const wtPath = worktreePath(name);
  if (fs.existsSync(wtPath)) {
    return { ok: false, message: `Worktree '${name}' already exists at ${wtPath}` };
  }

  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  const res = runGit(['worktree', 'add', wtPath, '-b', `wt/${name}`, 'HEAD']);
  if (!res.ok) return { ok: false, message: `Git error: ${gitOut(res)}` };

  worktreePaths.set(name, wtPath);
  if (taskId) bindTaskToWorktree(taskId, name);
  logEvent('create', name, taskId);
  return { ok: true, message: `Worktree '${name}' created at ${wtPath}` };
}

/** 真实写入 task.worktree 字段；状态保持 pending（等待认领）。 */
function bindTaskToWorktree(taskId: string, name: string): WorktreeOpResult {
  const task = loadTask(taskId);
  if (!task) return { ok: false, message: `Error: Task ${taskId} not found` };
  task.worktree = name;
  saveTask(task);
  logEvent('bind', name, taskId);
  return { ok: true, message: `Bound task ${taskId} (${task.subject}) to worktree '${name}'` };
}

/**
 * 保留 worktree 供人工审查：不做任何删除，只记一条 keep 事件。
 * 分支 wt/<name> 一并保留。
 */
function keepWorktree(name: string): WorktreeOpResult {
  const err = validateWorktreeName(name);
  if (err) return { ok: false, message: err };
  logEvent('keep', name);
  return { ok: true, message: `Worktree '${name}' kept for review (branch: wt/${name})` };
}

/**
 * 真实移除 worktree。
 * 安全检查：有未提交文件或未合并提交时拒绝，除非 discardChanges=true。
 * 成功后 `git branch -D wt/<name>`。
 */
function removeWorktree(name: string, discardChanges = false): WorktreeOpResult {
  const err = validateWorktreeName(name);
  if (err) return { ok: false, message: err };

  const wtPath = worktreePath(name);
  if (!fs.existsSync(wtPath)) return { ok: false, message: `Worktree '${name}' not found` };

  if (!discardChanges) {
    const { files, commits } = countWorktreeChanges(wtPath);
    if (files < 0) {
      return {
        ok: false,
        message: `Cannot verify worktree '${name}' status. Use discard_changes=true to force removal.`,
      };
    }
    if (files > 0 || commits > 0) {
      return {
        ok: false,
        message:
          `Worktree '${name}' has ${files} uncommitted file(s) ` +
          `and ${commits} unpushed commit(s). ` +
          'Use discard_changes=true to force removal.',
      };
    }
  }

  const res = runGit(['worktree', 'remove', wtPath, '--force']);
  if (!res.ok) return { ok: false, message: `Failed to remove worktree directory for '${name}'` };

  runGit(['branch', '-D', `wt/${name}`]);
  worktreePaths.delete(name);
  logEvent('remove', name);
  return { ok: true, message: `Worktree '${name}' removed` };
}

// ============================================================
// Part 3: Mock LLM —— 只替代模型调用；git 与任务系统都是真实的
// ============================================================

/** 从历史 tool_result 文本里收集任务 ID（按首次出现顺序去重）。 */
function collectTaskIds(messages: Message[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue;
      for (const match of block.content.matchAll(/task_\d+_\d+/g)) {
        if (!seen.has(match[0])) {
          seen.add(match[0]);
          ids.push(match[0]);
        }
      }
    }
  }
  return ids;
}

const text = (t: string) => ({ type: 'text' as const, text: t });
const tool = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'tool_use' as const,
  id,
  name,
  input,
});

/**
 * 脚本化模型，驱动一条真实的 worktree 生命周期：
 *   轮0：create_task 两个任务（拿到运行时生成的 ID）
 *   轮1：create_worktree auth、ui（真实 git worktree add）
 *   轮2：bind_worktree 把任务绑定到 worktree（写 .tasks/*.json）
 *   轮3：list_tasks 查看绑定
 *   轮4：在 auth worktree 中 bash 写文件，制造未提交变更
 *   轮5：remove auth（被变更守卫拒绝）、keep auth（保留供审查）、remove ui（干净，成功）
 *   轮6：remove auth discard_changes=true（强制移除 + branch -D）
 *   轮7：结束
 */
function mockLLM(messages: Message[]): LLMResponse {
  const round = messages.filter((m) => m.role === 'assistant').length;
  const ids = collectTaskIds(messages);
  const t1 = ids[0] ?? '';
  const t2 = ids[1] ?? '';

  switch (round) {
    case 0:
      return {
        stop_reason: 'tool_use',
        content: [
          text('先在任务板上创建两个待办任务。'),
          tool('m1', 'create_task', { subject: '实现鉴权重构', description: '重构 auth 模块' }),
          tool('m2', 'create_task', { subject: 'API v2 迁移', description: '迁移到 v2 接口' }),
        ],
      };
    case 1:
      return {
        stop_reason: 'tool_use',
        content: [
          text('为两个任务分别创建隔离的 git worktree。'),
          tool('m3', 'create_worktree', { worktreeId: 'auth', branch: 'feature/auth' }),
          tool('m4', 'create_worktree', { worktreeId: 'ui', branch: 'feature/ui' }),
        ],
      };
    case 2:
      return {
        stop_reason: 'tool_use',
        content: [
          text('把任务绑定到对应的 worktree。'),
          tool('m5', 'bind_worktree', { worktreeId: 'auth', taskId: t1 }),
          tool('m6', 'bind_worktree', { worktreeId: 'ui', taskId: t2 }),
        ],
      };
    case 3:
      return {
        stop_reason: 'tool_use',
        content: [text('查看任务板上的 worktree 绑定。'), tool('m7', 'list_tasks', {})],
      };
    case 4:
      return {
        stop_reason: 'tool_use',
        content: [
          text('在 auth worktree 内制造一个未提交变更。'),
          tool('m8', 'bash', {
            command: 'echo "auth refactor" > auth.patch && git status --porcelain',
            worktreeId: 'auth',
          }),
        ],
      };
    case 5:
      return {
        stop_reason: 'tool_use',
        content: [
          text('尝试移除有变更的 auth（应被守卫拒绝）；保留 auth 供审查；移除干净的 ui。'),
          tool('m9', 'remove_worktree', { worktreeId: 'auth' }),
          tool('m10', 'keep_worktree', { worktreeId: 'auth' }),
          tool('m11', 'remove_worktree', { worktreeId: 'ui' }),
        ],
      };
    case 6:
      return {
        stop_reason: 'tool_use',
        content: [
          text('确认丢弃变更后强制移除 auth（worktree remove --force + branch -D）。'),
          tool('m12', 'remove_worktree', { worktreeId: 'auth', discard_changes: true }),
        ],
      };
    default:
      return {
        stop_reason: 'end_turn',
        content: [text('Worktree 隔离演示完成：创建 → 绑定 → 执行 → 守卫拒绝 → 强制清理。')],
      };
  }
}

// real 模式注入的 system prompt，引导模型使用工具。
// mock 模式不读取该字段，故零配置运行行为不变。
const SYSTEM_PROMPT = buildSystemPrompt(
  '使用 create_worktree / bind_worktree / remove_worktree 管理隔离的 git worktree，并在 worktree 内用 bash 执行命令（通过 worktreeId 指定 cwd）。remove_worktree 在存在未提交变更时会拒绝，需显式 discard_changes=true 才强制移除。',
);

// ============================================================
// Part 4: Handlers（所有副作用在此）
// ============================================================

const s18Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const round = effect.input.messages.filter((m) => m.role === 'assistant').length;
    console.log(`\n[Chat] → 轮次 ${round + 1}`);
    return callChat(mockLLM, effect.input.messages, {
      tools: schemasFor(
        'bash',
        'create_task',
        'list_tasks',
        'get_task',
        'claim_task',
        'complete_task',
        'create_worktree',
        'remove_worktree',
        'keep_worktree',
        'bind_worktree',
      ),
      system: SYSTEM_PROMPT,
    });
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    const { command, cwd } = effect.input;
    const workDir = cwd ?? WORKSPACE_ROOT;
    const rel = path.relative(WORKSPACE_ROOT, workDir) || '.';
    console.log(`[BashExec] → ${command} (cwd: ${rel})`);
    const r = spawnSync(command, {
      shell: true,
      cwd: workDir,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    return out ? out.slice(0, 50000) : '(no output)';
  },

  CreateTask: async (effect: CreateTaskEffect): Promise<WorktreeTask> => {
    const { subject, description = '', blockedBy = [] } = effect.input;
    const task = createTask(subject, description, blockedBy);
    const deps = blockedBy.length ? ` (blockedBy: ${blockedBy.join(', ')})` : '';
    console.log(`[CreateTask] ○ ${task.id}: ${subject}${deps}`);
    return task;
  },

  ListTasks: async (_: ListTasksEffect): Promise<WorktreeTask[]> => {
    const tasks = listTasks();
    console.log(`[ListTasks] ${tasks.length} 个任务:`);
    console.log(formatTaskList(tasks));
    return tasks;
  },

  GetTask: async (effect: GetTaskEffect): Promise<string> => {
    console.log(`[GetTask] → ${effect.input.taskId}`);
    return getTaskJson(effect.input.taskId);
  },

  ClaimTask: async (effect: ClaimTaskEffect): Promise<ClaimResult> => {
    const { taskId, owner = 'agent' } = effect.input;
    const result = claimTask(taskId, owner);
    console.log(
      result.ok
        ? `[ClaimTask] ● ${result.task.id}: ${result.task.subject} → in_progress (owner: ${owner})`
        : `[ClaimTask] ✗ ${result.error}`,
    );
    return result;
  },

  CompleteTask: async (effect: CompleteTaskEffect): Promise<CompleteResult> => {
    const result = completeTask(effect.input.taskId);
    if (result.ok) {
      console.log(`[CompleteTask] ✓ ${result.task.id}: ${result.task.subject}`);
      if (result.unblocked.length > 0) {
        console.log(`[CompleteTask] 解锁: ${result.unblocked.map((t) => t.subject).join(', ')}`);
      }
    } else {
      console.log(`[CompleteTask] ✗ ${result.error}`);
    }
    return result;
  },

  CreateWorktree: async (effect: CreateWorktreeEffect): Promise<WorktreeOpResult> => {
    const { name, taskId = '' } = effect.input;
    const result = createWorktree(name, taskId);
    console.log(`[CreateWorktree] ${result.ok ? '✓' : '✗'} ${result.message}`);
    return result;
  },

  BindWorktree: async (effect: BindWorktreeEffect): Promise<WorktreeOpResult> => {
    const { name, taskId } = effect.input;
    const result = bindTaskToWorktree(taskId, name);
    console.log(`[BindWorktree] ${result.ok ? '✓' : '✗'} ${result.message}`);
    return result;
  },

  RemoveWorktree: async (effect: RemoveWorktreeEffect): Promise<WorktreeOpResult> => {
    const { name, discardChanges = false } = effect.input;
    const result = removeWorktree(name, discardChanges);
    console.log(`[RemoveWorktree] ${result.ok ? '✓' : '✗'} ${result.message}`);
    return result;
  },

  KeepWorktree: async (effect: KeepWorktreeEffect): Promise<WorktreeOpResult> => {
    const result = keepWorktree(effect.input.name);
    console.log(`[KeepWorktree] ${result.ok ? '✓' : '✗'} ${result.message}`);
    return result;
  },
};

// ============================================================
// Part 5: Agent Generator（业务逻辑，零副作用）
// ============================================================

function* agentLoop(perform: PerformFn<S18Effect>) {
  const messages: Message[] = [
    {
      role: 'user',
      content: '用真实的 git worktree 隔离并行开发两个功能：创建、绑定任务、在隔离目录里改动，最后清理。',
    },
  ];

  while (true) {
    const response = yield* perform({ type: 'Chat', input: { messages } });
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      return extractText(response);
    }

    const toolResults: ToolResultBlock[] = [];

    for (const block of getToolUseBlocks(response)) {
      try {
        let output: string;
        switch (block.name) {
          case 'bash': {
            const wtId = block.input['worktreeId'] as string | undefined;
            const cwd = wtId ? worktreePaths.get(wtId) : undefined;
            output = yield* perform({
              type: 'BashExec',
              input: { command: block.input['command'] as string, cwd },
            });
            break;
          }
          case 'create_task': {
            const task = yield* perform({
              type: 'CreateTask',
              input: {
                subject: block.input['subject'] as string,
                description: (block.input['description'] as string | undefined) ?? '',
                blockedBy: Array.isArray(block.input['blockedBy'])
                  ? (block.input['blockedBy'] as string[])
                  : [],
              },
            });
            const deps = task.blockedBy.length ? ` (blockedBy: ${task.blockedBy.join(', ')})` : '';
            output = `Created ${task.id}: ${task.subject}${deps}`;
            break;
          }
          case 'list_tasks': {
            const tasks = yield* perform({ type: 'ListTasks', input: {} });
            output = formatTaskList(tasks);
            break;
          }
          case 'get_task': {
            const rawId = block.input['id'] ?? block.input['taskId'];
            output = yield* perform({ type: 'GetTask', input: { taskId: String(rawId ?? '') } });
            break;
          }
          case 'claim_task': {
            const result = yield* perform({
              type: 'ClaimTask',
              input: {
                taskId: block.input['taskId'] as string,
                owner: block.input['owner'] as string | undefined,
              },
            });
            output = result.ok
              ? `Claimed ${result.task.id} (${result.task.subject})`
              : result.error;
            break;
          }
          case 'complete_task': {
            const result = yield* perform({
              type: 'CompleteTask',
              input: { taskId: block.input['taskId'] as string },
            });
            output = result.ok
              ? `Completed ${result.task.id} (${result.task.subject})` +
                (result.unblocked.length
                  ? `\nUnblocked: ${result.unblocked.map((t) => t.subject).join(', ')}`
                  : '')
              : result.error;
            break;
          }
          case 'create_worktree': {
            const name = String(block.input['worktreeId'] ?? block.input['name'] ?? '');
            const taskId = (block.input['taskId'] as string | undefined) ?? '';
            const result = yield* perform({ type: 'CreateWorktree', input: { name, taskId } });
            output = result.message;
            break;
          }
          case 'bind_worktree': {
            const name = String(block.input['worktreeId'] ?? block.input['name'] ?? '');
            const taskId = String(block.input['taskId'] ?? '');
            const result = yield* perform({ type: 'BindWorktree', input: { name, taskId } });
            output = result.message;
            break;
          }
          case 'remove_worktree': {
            const name = String(block.input['worktreeId'] ?? block.input['name'] ?? '');
            const discardChanges =
              (block.input['discard_changes'] as boolean | undefined) ??
              (block.input['discardChanges'] as boolean | undefined) ??
              false;
            const result = yield* perform({
              type: 'RemoveWorktree',
              input: { name, discardChanges },
            });
            output = result.message;
            break;
          }
          case 'keep_worktree': {
            const name = String(block.input['worktreeId'] ?? block.input['name'] ?? '');
            const result = yield* perform({ type: 'KeepWorktree', input: { name } });
            output = result.message;
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
// Part 6: 启动入口
// ============================================================

console.log('[S18] Git Worktree Isolation 启动\n');

// 保证 WORKSPACE_ROOT 是可用的 git 仓库（临时目录会走 git init 分支）。
ensureGitRepo();
// 清理上一次可能残留的 worktree / wt/* 分支，保证可重复运行。
cleanupWorktrees();
// 本次演示从零开始记录事件。
fs.mkdirSync(WORKTREES_DIR, { recursive: true });
fs.writeFileSync(WORKTREE_EVENTS_PATH, '', 'utf8');

console.log(`工作区 (git 仓库): ${WORKSPACE_ROOT}`);
console.log(`Worktrees 目录:     ${WORKTREES_DIR}`);
console.log(`事件日志:           ${WORKTREE_EVENTS_PATH}\n`);

let result = '';
try {
  result = await runAgent<S18Effect, string>(agentLoop, s18Handlers);
} finally {
  // 演示结束时兜底清理：即使流程中断也不留下 worktree / 分支。
  cleanupWorktrees();
}

console.log('\n[S18] 完成:', result);

// 展示事件日志（events.jsonl）
if (fs.existsSync(WORKTREE_EVENTS_PATH)) {
  const events = fs
    .readFileSync(WORKTREE_EVENTS_PATH, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
  console.log(`\n[Events] .worktrees/events.jsonl (${events.length} 条):`);
  for (const line of events) {
    const e = JSON.parse(line) as { type: string; worktree: string; task_id?: string; ts: number };
    const time = new Date(e.ts * 1000).toISOString().slice(11, 19);
    const bound = e.task_id ? ` ← ${e.task_id}` : '';
    console.log(`  ${time} ${e.type.padEnd(6)} ${e.worktree}${bound}`);
  }
}
