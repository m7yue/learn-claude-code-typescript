/**
 * s12: Task System — 任务图是持久化效应状态
 *
 * 本章新增 5 个 Effect：
 *   CreateTask   — 创建新任务（含依赖声明）
 *   ListTasks    — 列出所有任务
 *   GetTask      — 读取单个任务详情
 *   ClaimTask    — 认领 pending 任务（→ in_progress；依赖未完成则拒绝）
 *   CompleteTask — 完成 in_progress 任务（→ completed，报告解锁的下游）
 *
 * 持久化是真实的：每个任务 = <workspace>/.tasks/{id}.json 文件。
 * 每次操作都从磁盘读取，进程启动时不清空 —— 重启即从磁盘恢复任务图。
 * 路径来自 runtime/workspace.ts 的 TASKS_DIR。
 *
 * 依赖检查（canStart / blockedBy）同样是真实代码，不是脚本模拟。
 * mock 只替代「模型调用」这一件事：它学习 create_task 返回的运行时 ID，
 * 再用这些真实 ID 构造依赖图并驱动一整条 阻塞→解锁 的流程。
 */

import { runAgent } from '../runtime/core.ts';
import type { Effect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, TaskRecord, TaskStatus, ToolResultBlock } from '../runtime/types.ts';
import { extractText, getToolUseBlocks } from '../runtime/response.ts';
import { callChat } from '../runtime/model.ts';
import { schemasFor } from '../runtime/tool-schemas.ts';
import { buildSystemPrompt } from '../runtime/system-prompt.ts';
import { WORKSPACE_ROOT, TASKS_DIR } from '../runtime/workspace.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

interface ChatEffect extends Effect<'Chat', { messages: Message[] }, LLMResponse> {}

interface BashExecEffect extends Effect<'BashExec', { command: string }, string> {}

interface ReadFileEffect extends Effect<'ReadFile', { path: string; limit?: number }, string> {}

interface WriteFileEffect extends Effect<'WriteFile', { path: string; content: string }, string> {}

// s12 新增：任务管理
interface CreateTaskEffect extends Effect<'CreateTask', { subject: string; description: string; blockedBy?: string[] }, TaskRecord> {}

interface ListTasksEffect extends Effect<'ListTasks', Record<string, never>, TaskRecord[]> {}

interface GetTaskEffect extends Effect<'GetTask', { taskId: string }, string> {}

/** 认领结果：成功返回任务；失败返回可读的拒绝原因。 */
type ClaimResult = { ok: true; task: TaskRecord } | { ok: false; error: string };

/** 完成结果：成功返回任务 + 被解锁的下游；失败返回拒绝原因。 */
type CompleteResult = { ok: true; task: TaskRecord; unblocked: TaskRecord[] } | { ok: false; error: string };

interface ClaimTaskEffect extends Effect<'ClaimTask', { taskId: string; owner?: string }, ClaimResult> {}

interface CompleteTaskEffect extends Effect<'CompleteTask', { taskId: string }, CompleteResult> {}

type S12Effect =
  | ChatEffect
  | BashExecEffect
  | ReadFileEffect
  | WriteFileEffect
  | CreateTaskEffect
  | ListTasksEffect
  | GetTaskEffect
  | ClaimTaskEffect
  | CompleteTaskEffect;

// ============================================================
// Part 2: 真实任务存储（文件持久化 + 依赖检查）
// ============================================================

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

function saveTask(task: TaskRecord): void {
  ensureTasksDir();
  fs.writeFileSync(taskPath(task.id), JSON.stringify(task, null, 2), 'utf8');
}

/** 从磁盘读取任务；文件不存在或解析失败返回 null。 */
function loadTask(taskId: string): TaskRecord | null {
  const file = taskPath(taskId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as TaskRecord;
  } catch {
    return null;
  }
}

function createTask(subject: string, description = '', blockedBy: string[] = []): TaskRecord {
  const task: TaskRecord = {
    id: generateTaskId(),
    subject,
    description,
    status: 'pending',
    owner: null,
    blockedBy,
  };
  saveTask(task);
  return task;
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

function getTask(taskId: string): string {
  const task = loadTask(taskId);
  if (!task) return `Error: Task ${taskId} not found`;
  return JSON.stringify(task, null, 2);
}

/** 返回仍然阻塞该任务的依赖 ID（文件缺失或状态非 completed）。 */
function blockingDeps(task: TaskRecord): string[] {
  return task.blockedBy.filter((depId) => {
    const dep = loadTask(depId);
    return dep === null || dep.status !== 'completed';
  });
}

/**
 * 只有当所有 blockedBy 依赖都存在且已完成时才能启动。
 * 缺失的依赖视为阻塞。
 */
function canStart(taskId: string): boolean {
  const task = loadTask(taskId);
  if (!task) return false;
  return task.blockedBy.every((depId) => {
    const dep = loadTask(depId);
    return dep !== null && dep.status === 'completed';
  });
}

/** claim：仅 pending 可认领；被阻塞时报告阻塞依赖；成功则 owner + in_progress。 */
function claimTask(taskId: string, owner = 'agent'): ClaimResult {
  const task = loadTask(taskId);
  if (!task) return { ok: false, error: `Error: Task ${taskId} not found` };
  if (task.status !== 'pending') {
    return { ok: false, error: `Task ${taskId} is ${task.status}, cannot claim` };
  }
  const blocking = blockingDeps(task);
  if (blocking.length > 0) {
    return { ok: false, error: `Blocked by: ${blocking.join(', ')}` };
  }
  task.owner = owner;
  task.status = 'in_progress';
  saveTask(task);
  return { ok: true, task };
}

/** complete：仅 in_progress 可完成；完成后报告被解锁的下游 pending 任务。 */
function completeTask(taskId: string): CompleteResult {
  const task = loadTask(taskId);
  if (!task) return { ok: false, error: `Error: Task ${taskId} not found` };
  if (task.status !== 'in_progress') {
    return { ok: false, error: `Task ${taskId} is ${task.status}, cannot complete` };
  }
  task.status = 'completed';
  saveTask(task);
  // 只有 blockedBy 直接包含刚完成任务、且此刻依赖全部完成的 pending 下游被解锁。
  const unblocked = listTasks().filter(
    (t) => t.status === 'pending' && t.blockedBy.includes(taskId) && canStart(t.id),
  );
  return { ok: true, task, unblocked };
}

/** 可读的任务列表（图标 / owner / 依赖）。 */
function formatTaskList(tasks: TaskRecord[]): string {
  if (tasks.length === 0) return 'No tasks. Use create_task to add some.';
  const icons: Record<TaskStatus, string> = { pending: '○', in_progress: '●', completed: '✓' };
  return tasks
    .map((t) => {
      const deps = t.blockedBy.length ? ` (blockedBy: ${t.blockedBy.join(', ')})` : '';
      const owner = t.owner ? ` [${t.owner}]` : '';
      return `  ${icons[t.status]} ${t.id}: ${t.subject} [${t.status}]${owner}${deps}`;
    })
    .join('\n');
}

// ============================================================
// Part 2b: 文件 / shell 工具（真实执行，mock 只替代模型调用）
// ============================================================

/** 工作区内安全路径：越界即抛错。 */
function safePath(p: string): string {
  const resolved = path.resolve(WORKSPACE_ROOT, p);
  const rel = path.relative(WORKSPACE_ROOT, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

// ============================================================
// Part 3: Mock LLM —— 只替代模型调用；它学会运行时生成的 ID
// ============================================================

/**
 * 从历史 tool_result 文本里收集任务 ID（按首次出现顺序去重）。
 * create_task 的结果最先出现，因此顺序天然是 [A, B, C]。
 * 真实模型也是从工具结果里读到这些 ID，再用它们声明依赖。
 */
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
 * 脚本化模型：构造一条真实的依赖链 A,B → C。
 *   轮0：create A、create B（无依赖）
 *   轮1：create C（blockedBy: [A, B] —— 用轮0 学到的真实 ID）
 *   轮2：list_tasks
 *   轮3：get_task(C)
 *   轮4：claim C → 被阻塞（演示 DAG 依赖检查）
 *   轮5：claim A、claim B
 *   轮6：complete A、complete B（完成 B 时 C 被解锁）
 *   轮7：claim C → 成功
 *   轮8：complete C
 *   轮9：结束
 */
function mockLLM(messages: Message[]): LLMResponse {
  const round = messages.filter((m) => m.role === 'assistant').length;
  const ids = collectTaskIds(messages);
  const a = ids[0] ?? '';
  const b = ids[1] ?? '';
  const c = ids[2] ?? '';

  switch (round) {
    case 0:
      return {
        stop_reason: 'tool_use',
        content: [
          text('先创建两个无依赖的起始任务。'),
          tool('c1', 'create_task', { subject: '初始化项目', description: '安装依赖，配置环境', blockedBy: [] }),
          tool('c2', 'create_task', { subject: '实现核心功能', description: '编写主要业务逻辑', blockedBy: [] }),
        ],
      };
    case 1:
      return {
        stop_reason: 'tool_use',
        content: [
          text('再创建一个依赖前两个任务的收尾任务。'),
          tool('c3', 'create_task', {
            subject: '编写测试',
            description: '单元测试和集成测试',
            blockedBy: [a, b],
          }),
        ],
      };
    case 2:
      return {
        stop_reason: 'tool_use',
        content: [text('查看当前任务图。'), tool('c4', 'list_tasks', {})],
      };
    case 3:
      return {
        stop_reason: 'tool_use',
        content: [text(`查看收尾任务 ${c} 的依赖详情。`), tool('c5', 'get_task', { taskId: c })],
      };
    case 4:
      return {
        stop_reason: 'tool_use',
        content: [text('尝试认领收尾任务，验证依赖阻塞。'), tool('c6', 'claim_task', { taskId: c, owner: 'agent' })],
      };
    case 5:
      return {
        stop_reason: 'tool_use',
        content: [
          text('先认领两个起始任务。'),
          tool('c7', 'claim_task', { taskId: a, owner: 'agent' }),
          tool('c8', 'claim_task', { taskId: b, owner: 'agent' }),
        ],
      };
    case 6:
      return {
        stop_reason: 'tool_use',
        content: [
          text('完成两个起始任务，观察下游解锁。'),
          tool('c9', 'complete_task', { taskId: a }),
          tool('c10', 'complete_task', { taskId: b }),
        ],
      };
    case 7:
      return {
        stop_reason: 'tool_use',
        content: [text('依赖已满足，现在认领收尾任务。'), tool('c11', 'claim_task', { taskId: c, owner: 'agent' })],
      };
    case 8:
      return {
        stop_reason: 'tool_use',
        content: [text('完成收尾任务。'), tool('c12', 'complete_task', { taskId: c })],
      };
    default:
      return {
        stop_reason: 'end_turn',
        content: [text('任务图演示完成：C 曾被 A、B 阻塞，A、B 完成后 C 被解锁并完成。')],
      };
  }
}

// real 模式注入的 system prompt，引导模型使用工具完成任务。
// mock 模式不读取该字段，故零配置运行行为不变。
const SYSTEM_PROMPT = buildSystemPrompt(
  '使用 create_task / list_tasks / get_task / claim_task / complete_task 跟踪依赖与进度；直接调用工具推进，不要只输出文字计划。',
  '先创建无依赖的起始任务；有依赖的任务必须等 create_task 返回确切 ID 后再创建，blockedBy 不要猜测或编造。',
  '按依赖顺序操作：依赖全部 completed 后再 claim 下游；每次 complete 后阅读 tool_result 里的 Unblocked。',
  '工作区 .tasks/ 可能残留其他运行的任务：只操作本次请求新建的任务，不要认领、完成或改动无关任务；本演示不需要 bash / read_file / write_file，请只用任务工具。',
);

const s12Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const round = effect.input.messages.filter((m) => m.role === 'assistant').length;
    console.log(`\n[Chat] → 轮次 ${round + 1}`);
    await new Promise((r) => setTimeout(r, 30));
    return callChat(mockLLM, effect.input.messages, {
      tools: schemasFor(
        'bash',
        'read_file',
        'write_file',
        'create_task',
        'list_tasks',
        'get_task',
        'claim_task',
        'complete_task',
      ),
      system: SYSTEM_PROMPT,
    });
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    const { command } = effect.input;
    console.log(`[BashExec] → ${command}`);
    const r = spawnSync(command, {
      shell: true,
      cwd: WORKSPACE_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    return out ? out.slice(0, 50000) : '(no output)';
  },

  ReadFile: async (effect: ReadFileEffect): Promise<string> => {
    const { path: filePath, limit } = effect.input;
    console.log(`[ReadFile] → ${filePath}`);
    try {
      const lines = fs.readFileSync(safePath(filePath), 'utf8').split(/\r?\n/);
      if (limit && limit < lines.length) {
        return [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`].join('\n');
      }
      return lines.join('\n');
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },

  WriteFile: async (effect: WriteFileEffect): Promise<string> => {
    const { path: filePath, content } = effect.input;
    console.log(`[WriteFile] → ${filePath}`);
    try {
      const target = safePath(filePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
      return `Wrote ${content.length} bytes to ${filePath}`;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },

  CreateTask: async (effect: CreateTaskEffect): Promise<TaskRecord> => {
    const { subject, description = '', blockedBy = [] } = effect.input;
    const task = createTask(subject, description, blockedBy);
    const deps = blockedBy.length ? ` (blockedBy: ${blockedBy.join(', ')})` : '';
    console.log(`[CreateTask] ○ ${task.id}: ${subject}${deps}`);
    return task;
  },

  ListTasks: async (_: ListTasksEffect): Promise<TaskRecord[]> => {
    const tasks = listTasks();
    console.log(`[ListTasks] ${tasks.length} 个任务:`);
    console.log(formatTaskList(tasks));
    return tasks;
  },

  GetTask: async (effect: GetTaskEffect): Promise<string> => {
    console.log(`[GetTask] → ${effect.input.taskId}`);
    return getTask(effect.input.taskId);
  },

  ClaimTask: async (effect: ClaimTaskEffect): Promise<ClaimResult> => {
    const { taskId, owner = 'agent' } = effect.input;
    const result = claimTask(taskId, owner);
    if (result.ok) {
      console.log(`[ClaimTask] ● ${result.task.id}: ${result.task.subject} → in_progress (owner: ${owner})`);
    } else {
      console.log(`[ClaimTask] ✗ ${result.error}`);
    }
    return result;
  },

  CompleteTask: async (effect: CompleteTaskEffect): Promise<CompleteResult> => {
    const { taskId } = effect.input;
    const result = completeTask(taskId);
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
};

// ============================================================
// Part 4: Agent Generator（业务逻辑，零副作用）
// ============================================================

function* agentLoop(perform: PerformFn<S12Effect>) {
  const messages: Message[] = [
    {
      role: 'user',
      content: '帮我规划一个三步骤的项目：初始化、实现、测试。让测试依赖前两步，并演示依赖阻塞与解锁。',
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
          case 'bash':
            output = yield* perform({ type: 'BashExec', input: { command: block.input['command'] as string } });
            break;
          case 'read_file':
            output = yield* perform({
              type: 'ReadFile',
              input: {
                path: block.input['path'] as string,
                limit: block.input['limit'] as number | undefined,
              },
            });
            break;
          case 'write_file':
            output = yield* perform({
              type: 'WriteFile',
              input: {
                path: block.input['path'] as string,
                content: block.input['content'] as string,
              },
            });
            break;
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
            // 工具参数定义同时列出 id（工程层数字）与 taskId（章节字符串）；本章优先 taskId，兼容回退 id。
            const rawId = block.input['taskId'] ?? block.input['id'];
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
// Part 5: 启动入口
// ============================================================

// 注意：这里不做任何清理。任务图持久化在磁盘上，重启后从 .tasks/ 恢复。
console.log('[S12] Task System 启动\n');
console.log(`任务目录: ${TASKS_DIR}`);
console.log(`已有任务: ${listTasks().length} 个（重启后从磁盘恢复）\n`);

const result = await runAgent<S12Effect, string>(agentLoop, s12Handlers);

console.log('\n[S12] 完成:', result);
