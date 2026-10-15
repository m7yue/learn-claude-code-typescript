/**
 * s13: Background Tasks — 后台任务是真正脱离主循环的异步执行
 *
 * 本章机制：
 *   - BackgroundRegistry：用两张表记录后台任务（backgroundTasks 记录进行中/已完成，
 *     backgroundResults 存结果），并用 Mutex 加锁，保证同一时刻只有一个操作在改表
 *   - startBackgroundTask：自增计数、按 bg_%04d 命名、先记为 running，然后启动一个
 *     「不等它结束」的 async 任务，立即把任务 id 返回给主循环
 *   - collectBackgroundResults：只挑出已经完成的任务，整理成 <task_notification> 文本
 *   - shouldRunBackground：模型明确要求 run_in_background 时就用后台；否则按命令里的
 *     关键字猜测它是不是慢命令
 *   - agentLoop：bash 命中后台条件 → 交给后台跑，本轮先回一条「已开始」的占位结果；
 *     每轮结束时，把已经完成的后台通知并进同一条 user 消息
 *
 * 数据流：
 *
 *   tool_use(bash, run_in_background) ── shouldRunBackground? ──► StartBackground
 *         │                                                            │
 *         │                                          BackgroundRegistry.startBackgroundTask()
 *         ▼                                                            │ 记为 running、返回 bg_xxxx
 *   占位 tool_result                              ┌───────────────────┘
 *   "[Background task bg_xxxx started] ..."       ▼
 *         │                              后台任务（一个不 await 的 async 函数）
 *         │                                   稍后写回：status=completed + 结果
 *         ▼                                          │
 *   CollectBackgroundResults ◄───────────────────────┘  不等它完成，只取「已完成」的
 *         │
 *         ▼
 *   与本轮 tool_result 合并进同一条 user 消息（模型下一轮即可看到）
 *
 * 并发模型（本章的关键点）：
 *   JS 只有一个线程，代码轮流执行：一个 async 函数只有在别的代码 await（等待）时，
 *   才有机会往下跑。所以这里把后台工作写成一个「启动后不等它」的 async 函数，它靠各轮
 *   之间的等待（比如等 Chat 返回）来推进。代价：如果进程在后台任务完成前就退出，结果会
 *   丢失——真正上线时，需要在退出前等所有后台任务结束（见 README）。
 *
 * 代数效应视角（保留 Effect + handler + generator 惯用法）：
 *   Chat                     — 与 LLM 对话（mock 只替换这里）
 *   ExecuteTool              — 前台同步执行一个工具
 *   StartBackground          — 把工具调用交给后台注册表（不等它，立即返回）
 *   CollectBackgroundResults — 只看已完成的后台任务，取回它们的通知
 *
 * 注意：本章并没有 spawn_background / wait_background / collect_notifications
 * 这三个工具——后台执行由 bash 的 run_in_background 参数触发，通知由循环自动注入。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { runAgent } from '../runtime/core.ts';
import type { Effect, PerformFn } from '../runtime/core.ts';
import type {
  LLMResponse,
  Message,
  TaskRecord,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '../runtime/types.ts';
import { extractText, getToolUseBlocks, messageText } from '../runtime/response.ts';
import { callChat } from '../runtime/model.ts';
import { schemasFor } from '../runtime/tool-schemas.ts';
import { buildSystemPrompt } from '../runtime/system-prompt.ts';
import { Mutex } from '../runtime/locks.ts';
import { TASKS_DIR, WORKSPACE_ROOT } from '../runtime/workspace.ts';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

interface ChatEffect extends Effect<'Chat', { messages: Message[] }, LLMResponse> {}

/** 前台同步执行一个工具调用，返回输出。 */
interface ExecuteToolEffect extends Effect<'ExecuteTool', { block: ToolUseBlock }, string> {}

/** s13 新增：把工具调用派发到后台注册表，立即拿到 bg id（不阻塞）。 */
interface StartBackgroundEffect extends Effect<'StartBackground', { block: ToolUseBlock }, { bgId: string }> {}

/** s13 新增：非阻塞收集已完成的后台任务通知。 */
interface CollectBackgroundResultsEffect
  extends Effect<'CollectBackgroundResults', Record<string, never>, string[]> {}

type S13Effect =
  | ChatEffect
  | ExecuteToolEffect
  | StartBackgroundEffect
  | CollectBackgroundResultsEffect;

// ============================================================
// Part 2: 工具实现（bash / read_file / write_file / task 工具）
// ============================================================

function safePath(p: string): string {
  const resolved = path.resolve(WORKSPACE_ROOT, p);
  const rel = path.relative(WORKSPACE_ROOT, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

/** 模拟执行：用一段「按命令长短决定的等待」代替真实子进程的运行时间。 */
async function runBash(command: string): Promise<string> {
  // 教学版不真的启动子进程。这里让慢命令多等一会，好让后台任务在时间上看得出差别：
  // 交给后台后主循环立刻继续，后台那段代码要等到别的代码 await（等待）时才往下跑，
  // 稍后才把结果写回注册表。
  const ms = isSlowOperation('bash', { command }) ? 25 : 3;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
  return `(执行: ${command})`;
}

function runRead(p: string, limit?: number): string {
  try {
    const lines = fs.readFileSync(safePath(p), 'utf8').split(/\r?\n/);
    if (limit && limit < lines.length) {
      lines.splice(limit, lines.length - limit, `... (${lines.length - limit} more lines)`);
    }
    return lines.join('\n');
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function runWrite(p: string, content: string): string {
  try {
    const fp = safePath(p);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, 'utf8');
    return `Wrote ${content.length} bytes to ${p}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ── Task System（沿用 s12 的实现）──
// 任务持久化到工作区 .tasks/（runtime/workspace.ts）。

function ensureTasksDir(): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
}

function taskPath(taskId: string): string {
  return path.join(TASKS_DIR, `${taskId}.json`);
}

function saveTask(task: TaskRecord): void {
  ensureTasksDir();
  fs.writeFileSync(taskPath(task.id), JSON.stringify(task, null, 2), 'utf8');
}

function loadTask(taskId: string): TaskRecord | null {
  try {
    return JSON.parse(fs.readFileSync(taskPath(taskId), 'utf8')) as TaskRecord;
  } catch {
    return null;
  }
}

function listTasks(): TaskRecord[] {
  ensureTasksDir();
  return fs
    .readdirSync(TASKS_DIR)
    .filter((f) => f.endsWith('.json'))
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

function canStart(taskId: string): boolean {
  const task = loadTask(taskId);
  if (!task) return false;
  return task.blockedBy.every((depId) => loadTask(depId)?.status === 'completed');
}

function createTask(subject: string, description: string, blockedBy: string[]): TaskRecord {
  const task: TaskRecord = {
    id: `task_${Math.floor(Date.now() / 1000)}_${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
    subject,
    description,
    status: 'pending',
    owner: null,
    blockedBy,
  };
  saveTask(task);
  return task;
}

// ── 统一工具派发（按工具名分发到对应实现）──

async function executeTool(block: ToolUseBlock): Promise<string> {
  switch (block.name) {
    case 'bash':
      return runBash(String(block.input['command'] ?? ''));
    case 'read_file':
      return runRead(String(block.input['path'] ?? ''), block.input['limit'] as number | undefined);
    case 'write_file':
      return runWrite(String(block.input['path'] ?? ''), String(block.input['content'] ?? ''));
    case 'create_task': {
      const task = createTask(
        String(block.input['subject'] ?? ''),
        String(block.input['description'] ?? ''),
        (block.input['blockedBy'] as string[] | undefined) ?? [],
      );
      return `Created ${task.id}: ${task.subject}`;
    }
    case 'list_tasks': {
      const tasks = listTasks();
      if (tasks.length === 0) return 'No tasks. Use create_task to add some.';
      const icons: Record<TaskRecord['status'], string> = {
        pending: '○',
        in_progress: '●',
        completed: '✓',
      };
      return tasks
        .map((t) => `  ${icons[t.status]} ${t.id}: ${t.subject} [${t.status}]`)
        .join('\n');
    }
    case 'get_task': {
      // 两种参数名都接受：章节用 taskId，工程层用 id
      const taskId = String(block.input['taskId'] ?? block.input['id'] ?? '');
      const task = loadTask(taskId);
      if (!task) return `Error: Task ${taskId} not found`;
      return JSON.stringify(task, null, 2);
    }
    case 'claim_task': {
      const taskId = String(block.input['taskId'] ?? '');
      const task = loadTask(taskId);
      if (!task) return `Error: Task ${taskId} not found`;
      if (task.status !== 'pending') return `Task ${taskId} is ${task.status}, cannot claim`;
      if (!canStart(taskId)) {
        const deps = task.blockedBy.filter((d) => loadTask(d)?.status !== 'completed');
        return `Blocked by: ${deps.join(', ')}`;
      }
      task.status = 'in_progress';
      task.owner = 'agent';
      saveTask(task);
      return `Claimed ${task.id} (${task.subject})`;
    }
    case 'complete_task': {
      const taskId = String(block.input['taskId'] ?? '');
      const task = loadTask(taskId);
      if (!task) return `Error: Task ${taskId} not found`;
      if (task.status !== 'in_progress') return `Task ${taskId} is ${task.status}, cannot complete`;
      task.status = 'completed';
      saveTask(task);
      const unblocked = listTasks().filter(
        (t) => t.status === 'pending' && t.blockedBy.length > 0 && canStart(t.id),
      );
      let msg = `Completed ${task.id} (${task.subject})`;
      if (unblocked.length > 0) msg += `\nUnblocked: ${unblocked.map((t) => t.subject).join(', ')}`;
      return msg;
    }
    default:
      return `Unknown tool: ${block.name}`;
  }
}

// ============================================================
// Part 3: 后台任务注册表（真实机制）
// ============================================================

interface BackgroundTaskRecord {
  toolUseId: string;
  command: string;
  status: 'running' | 'completed';
  startedAt: number;
  finishedAt?: number;
}

/**
 * 后台任务注册表 —— 用两张 Map 分别保存后台任务的记录与结果。
 *
 * startBackgroundTask 会启动一个「不等它结束」的 async 任务：调用方拿到 bg id 后
 * 主循环立刻继续，后台那段代码稍后才把结果写回。两张表都用 Mutex 加锁，保证同一时刻
 * 只有一个操作在读/写它们，不会互相打断。
 */
class BackgroundRegistry {
  private readonly lock = new Mutex(); // 加锁，保证同一时刻只有一个操作在读/写这两张表
  private counter = 0; // 自增计数，用于 bg_0001、bg_0002 这样的命名
  private readonly backgroundTasks = new Map<string, BackgroundTaskRecord>();
  private readonly backgroundResults = new Map<string, string>();

  /** 启动一个后台任务，立即返回 bg id。 */
  async startBackgroundTask(block: ToolUseBlock): Promise<string> {
    this.counter += 1;
    const bgId = `bg_${String(this.counter).padStart(4, '0')}`;
    const command =
      typeof block.input['command'] === 'string' ? block.input['command'] : block.name;

    const startedAt = Date.now();
    await this.lock.withLock(() => {
      this.backgroundTasks.set(bgId, {
        toolUseId: block.id,
        command,
        status: 'running',
        startedAt,
      });
    });

    // 不等它：主循环拿到 bgId 后立刻继续，后台那段代码稍后自己把结果写回来。
    (async () => {
      const result = await executeTool(block);
      await this.lock.withLock(() => {
        const task = this.backgroundTasks.get(bgId);
        if (task) {
          task.status = 'completed';
          task.finishedAt = Date.now();
        }
        this.backgroundResults.set(bgId, result);
      });
    })().catch((err) => {
      console.log(`  [background error] ${bgId}: ${err instanceof Error ? err.message : String(err)}`);
    });

    console.log(`  [background] dispatched ${bgId}: ${command.slice(0, 40)}`);
    return bgId;
  }

  /** 收集已完成任务，返回 <task_notification> 文本。 */
  async collectBackgroundResults(): Promise<string[]> {
    const readyIds = await this.lock.withLock(() =>
      [...this.backgroundTasks.entries()]
        .filter(([, task]) => task.status === 'completed')
        .map(([bgId]) => bgId),
    );

    const notifications: string[] = [];
    for (const bgId of readyIds) {
      const { task, output } = await this.lock.withLock(() => {
        const task = this.backgroundTasks.get(bgId)!;
        const output = this.backgroundResults.get(bgId) ?? '';
        this.backgroundTasks.delete(bgId);
        this.backgroundResults.delete(bgId);
        return { task, output };
      });

      const summary = output.length > 200 ? output.slice(0, 200) : output;
      const durationMs = task.finishedAt !== undefined ? task.finishedAt - task.startedAt : 0;
      notifications.push(
        `<task_notification>\n` +
          `  <task_id>${bgId}</task_id>\n` +
          `  <status>completed</status>\n` +
          `  <command>${task.command}</command>\n` +
          `  <duration_ms>${durationMs}</duration_ms>\n` +
          `  <summary>${summary}</summary>\n` +
          `</task_notification>`,
      );
      console.log(
        `  [background done] ${bgId}: ${task.command.slice(0, 40)} (+${durationMs}ms, ${output.length} chars)`,
      );
    }
    return notifications;
  }
}

const backgroundRegistry = new BackgroundRegistry();

// ============================================================
// Part 4: 后台判定（慢命令启发式 + 显式请求）
// ============================================================

const SLOW_KEYWORDS = [
  'install',
  'build',
  'test',
  'deploy',
  'compile',
  'docker build',
  'pip install',
  'npm install',
  'cargo build',
  'pytest',
  'make',
];

/** 兜底判断：命令里含慢命令关键字时，认为它很可能超过 30s。 */
function isSlowOperation(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName !== 'bash') return false;
  const cmd = String(toolInput['command'] ?? '').toLowerCase();
  return SLOW_KEYWORDS.some((kw) => cmd.includes(kw));
}

/** 模型明确要求就用后台；否则按关键字判断它是不是慢命令。 */
function shouldRunBackground(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolInput['run_in_background']) return true;
  return isSlowOperation(toolName, toolInput);
}

// ============================================================
// Part 5: Mock LLM（仅替换模型调用；后台机制是真的）
// ============================================================

const mockResponses: Array<(messages: Message[]) => LLMResponse> = [
  // 轮0：显式后台执行一个慢命令（run_in_background: true）→ 占位 tool_result
  () => ({
    stop_reason: 'tool_use',
    content: [
      { type: 'text', text: '启动后台安装（run_in_background），主 Agent 不必等待。' },
      {
        type: 'tool_use',
        id: 'bg_call',
        name: 'bash',
        input: { command: 'npm install', run_in_background: true },
      },
    ],
  }),
  // 轮1：前台继续执行其他命令（此时后台任务还在跑；本轮结束时自动注入通知）
  () => ({
    stop_reason: 'tool_use',
    content: [
      { type: 'text', text: '前台继续执行其他工作。' },
      { type: 'tool_use', id: 'fg_call', name: 'bash', input: { command: 'echo "foreground work"' } },
    ],
  }),
  // 轮2：结束——把对话里收到的 <task_notification> 回显出来，证明通知确实被注入
  (messages) => {
    const notif = findLastNotification(messages);
    return {
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: notif
            ? `前台工作结束，已收到后台任务完成通知：\n${notif}`
            : '所有后台任务已完成，主 Agent 完成工作。',
        },
      ],
    };
  },
];

/** 从对话历史里找出最后一条 <task_notification>，用于证明通知已被注入。 */
function findLastNotification(messages: Message[]): string | null {
  let last: string | null = null;
  for (const message of messages) {
    for (const match of messageText(message.content).matchAll(
      /<task_notification>[\s\S]*?<\/task_notification>/g,
    )) {
      last = match[0];
    }
  }
  return last;
}

let roundIndex = 0;
function mockLLM(messages: Message[]): LLMResponse {
  const fn = mockResponses[Math.min(roundIndex, mockResponses.length - 1)];
  roundIndex += 1;
  return fn(messages);
}

// real 模式注入的 system prompt；mock 模式不读取，零配置运行行为不变。
const SYSTEM_PROMPT = buildSystemPrompt(
  '使用工具解决任务。对耗时的 bash 命令（install/build/test/deploy 等）可用 run_in_background 放入后台，' +
    '主 Agent 继续前台工作；后台任务完成后系统会自动把 <task_notification> 注入对话。' +
    '本教学演示中 bash 是模拟的：只回显命令文本、不会真正执行（后台任务同理），请不要依赖它的输出。',
);

// ============================================================
// Part 6: Handler 实现（所有副作用在此）
// ============================================================

const s13Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const round = effect.input.messages.filter((m) => m.role === 'assistant').length;
    console.log(`\n[Chat] → 轮次 ${round + 1}`);
    // 这个等待有两层作用：一是模拟真实 Chat 的网络往返；二是 JS 只有一个线程，
    // 后台任务要等主循环 await（等待）时才有机会往下跑，所以它也给后台留出了完成的时间。
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

  // 前台同步执行：主循环等待结果
  ExecuteTool: async (effect: ExecuteToolEffect): Promise<string> => {
    console.log(`> ${effect.input.block.name}`);
    const output = await executeTool(effect.input.block);
    console.log(output.slice(0, 300));
    return output;
  },

  // 后台启动：注册表启动一个「不等它结束」的 async 函数，立即返回 bg id
  StartBackground: async (effect: StartBackgroundEffect): Promise<{ bgId: string }> => {
    console.log(`> ${effect.input.block.name}`);
    const bgId = await backgroundRegistry.startBackgroundTask(effect.input.block);
    return { bgId };
  },

  // 收集：不等待，只取已经完成的任务，返回它们的通知文本
  CollectBackgroundResults: async (
    _effect: CollectBackgroundResultsEffect,
  ): Promise<string[]> => {
    return backgroundRegistry.collectBackgroundResults();
  },
};

// ============================================================
// Part 7: Agent Generator（业务逻辑，零副作用）
// ============================================================

function* agentLoop(perform: PerformFn<S13Effect>) {
  const messages: Message[] = [
    {
      role: 'user',
      content: '启动后台任务执行 npm install，同时继续前台工作，完成后把结果告诉我。',
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
      if (shouldRunBackground(block.name, block.input)) {
        // 命中后台条件：交给注册表，并回一条占位 tool_result
        const { bgId } = yield* perform({ type: 'StartBackground', input: { block } });
        const command = String(block.input['command'] ?? '');
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content:
            `[Background task ${bgId} started] Command: ${command}. ` +
            `Result will be available when complete.`,
        });
      } else {
        const output = yield* perform({ type: 'ExecuteTool', input: { block } });
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: output });
      }
    }

    // 把 tool_result 和后台通知合并进同一条 user 消息
    const userContent: Array<TextBlock | ToolResultBlock> = [...toolResults];
    const notifications = yield* perform({
      type: 'CollectBackgroundResults',
      input: {},
    });
    if (notifications.length > 0) {
      for (const notif of notifications) userContent.push({ type: 'text', text: notif });
      console.log(`  [inject] 注入 ${notifications.length} 条后台通知`);
      for (const notif of notifications) console.log(notif); // 确保通知正文可见
    }

    messages.push({ role: 'user', content: userContent });
  }
}

// ============================================================
// Part 8: 启动入口
// ============================================================

console.log('[S13] Background Tasks 启动\n');

const result = await runAgent<S13Effect, string>(agentLoop, s13Handlers);

console.log('\n[S13] 完成:', result);
