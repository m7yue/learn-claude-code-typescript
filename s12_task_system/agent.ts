/**
 * s12: Task System — 任务图是持久化效应状态
 *
 * 本章新增 4 个 Effect：
 *   CreateTask   — 创建新任务（含依赖声明）
 *   ListTasks    — 列出所有任务
 *   ClaimTask    — 认领 pending 任务（→ in_progress）
 *   CompleteTask — 完成 in_progress 任务（→ completed，报告解锁的下游）
 *
 * 持久化：每个任务 = .tasks/{id}.json 文件（教学版用内存模拟）
 */

import { runAgent } from '../runtime/core.ts';
import type { BaseEffect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolUseBlock, TaskRecord, TaskStatus } from '../runtime/types.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

interface ChatEffect extends BaseEffect {
  type: 'Chat';
  input: { messages: Message[] };
  output: LLMResponse;
}

interface BashExecEffect extends BaseEffect {
  type: 'BashExec';
  input: { command: string };
  output: string;
}

// s12 新增：任务管理
interface CreateTaskEffect extends BaseEffect {
  type: 'CreateTask';
  input: { subject: string; description: string; blockedBy?: string[] };
  output: TaskRecord;
}

interface ListTasksEffect extends BaseEffect {
  type: 'ListTasks';
  input: Record<string, never>;
  output: TaskRecord[];
}

interface ClaimTaskEffect extends BaseEffect {
  type: 'ClaimTask';
  input: { taskId: string; owner?: string };
  output: TaskRecord;
}

interface CompleteTaskEffect extends BaseEffect {
  type: 'CompleteTask';
  input: { taskId: string };
  output: { task: TaskRecord; unblocked: TaskRecord[] };
}

type S12Effect = ChatEffect | BashExecEffect | CreateTaskEffect | ListTasksEffect | ClaimTaskEffect | CompleteTaskEffect;

// ============================================================
// Part 2: Handler 实现（任务存储）
// ============================================================

const TASKS_DIR = path.join(os.tmpdir(), 'learn-claude-code-typescript', 's12', 'tasks');

function ensureTasksDir() {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
}

function generateTaskId(): string {
  return `task_${Date.now()}_${Math.floor(Math.random() * 9000) + 1000}`;
}

function saveTask(task: TaskRecord): void {
  ensureTasksDir();
  fs.writeFileSync(path.join(TASKS_DIR, `${task.id}.json`), JSON.stringify(task, null, 2), 'utf8');
}

function loadTask(taskId: string): TaskRecord | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, `${taskId}.json`), 'utf8')) as TaskRecord;
  } catch { return null; }
}

function listAllTasks(): TaskRecord[] {
  ensureTasksDir();
  return fs.readdirSync(TASKS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8')) as TaskRecord; }
      catch { return null; }
    })
    .filter((t): t is TaskRecord => t !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function canStart(taskId: string): boolean {
  const task = loadTask(taskId);
  if (!task) return false;
  return task.blockedBy.every(depId => {
    const dep = loadTask(depId);
    return dep?.status === 'completed';
  });
}

function formatTasks(tasks: TaskRecord[]): string {
  const icons: Record<TaskStatus, string> = { pending: '○', in_progress: '◑', completed: '●' };
  return tasks.map(t => `  ${icons[t.status]} [${t.id.slice(-8)}] ${t.subject}${t.blockedBy.length ? ` (等待: ${t.blockedBy.map(id => id.slice(-8)).join(', ')})` : ''}`).join('\n');
}

function extractText(response: LLMResponse): string {
  return response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text).join('');
}

function getToolUseBlocks(response: LLMResponse): ToolUseBlock[] {
  return response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

// 清理旧任务（每次运行前清空）
function cleanupTasks() {
  ensureTasksDir();
  fs.readdirSync(TASKS_DIR).forEach(f => {
    try { fs.unlinkSync(path.join(TASKS_DIR, f)); } catch {}
  });
}

// Mock LLM：创建任务→认领→完成→继续
const mockResponses = [
  // 轮1：创建3个任务（任务2和3依赖任务1）
  (ids: string[]) => ({
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '我来创建任务计划。' },
      { type: 'tool_use' as const, id: 'm1', name: 'create_task', input: { subject: '初始化项目', description: '安装依赖，配置环境', blockedBy: [] } },
      { type: 'tool_use' as const, id: 'm2', name: 'create_task', input: { subject: '实现核心功能', description: '编写主要业务逻辑', blockedBy: [] } },
      { type: 'tool_use' as const, id: 'm3', name: 'create_task', input: { subject: '编写测试', description: '单元测试和集成测试', blockedBy: [] } },
    ],
  }),
  // 轮2：列出任务
  (ids: string[]) => ({
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '查看任务列表。' },
      { type: 'tool_use' as const, id: 'm4', name: 'list_tasks', input: {} },
    ],
  }),
  // 轮3：认领第一个任务
  (ids: string[]) => ({
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: `认领任务: ${ids[0] ?? 'unknown'}。` },
      { type: 'tool_use' as const, id: 'm5', name: 'claim_task', input: { taskId: ids[0] ?? '', owner: 'agent' } },
    ],
  }),
  // 轮4：完成第一个任务
  (ids: string[]) => ({
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '完成任务。' },
      { type: 'tool_use' as const, id: 'm6', name: 'complete_task', input: { taskId: ids[0] ?? '' } },
    ],
  }),
  // 轮5：结束
  (_: string[]) => ({
    stop_reason: 'end_turn' as const,
    content: [{ type: 'text' as const, text: '任务规划和执行演示完成！任务图已持久化。' }],
  }),
];

let roundIndex = 0;
const createdTaskIds: string[] = [];

function mockLLM(messages: Message[]): LLMResponse {
  const fn = mockResponses[Math.min(roundIndex, mockResponses.length - 1)];
  roundIndex++;
  return fn(createdTaskIds) as LLMResponse;
}

const s12Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const round = effect.input.messages.filter(m => m.role === 'assistant').length;
    console.log(`\n[Chat] → 轮次 ${round + 1}`);
    await new Promise(r => setTimeout(r, 50));
    return mockLLM(effect.input.messages);
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    return `(执行: ${effect.input.command})`;
  },

  CreateTask: async (effect: CreateTaskEffect): Promise<TaskRecord> => {
    const { subject, description, blockedBy = [] } = effect.input;
    const task: TaskRecord = {
      id: generateTaskId(),
      subject,
      description,
      status: 'pending',
      owner: null,
      blockedBy,
    };
    saveTask(task);
    createdTaskIds.push(task.id);
    console.log(`[CreateTask] ○ [${task.id.slice(-8)}] ${subject}${blockedBy.length ? ` (等待 ${blockedBy.length} 个)` : ''}`);
    return task;
  },

  ListTasks: async (_: ListTasksEffect): Promise<TaskRecord[]> => {
    const tasks = listAllTasks();
    console.log(`[ListTasks] ${tasks.length} 个任务:`);
    console.log(formatTasks(tasks));
    return tasks;
  },

  ClaimTask: async (effect: ClaimTaskEffect): Promise<TaskRecord> => {
    const { taskId, owner = 'agent' } = effect.input;
    const task = loadTask(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    if (task.status !== 'pending') throw new Error(`任务状态不是 pending: ${task.status}`);
    if (!canStart(taskId)) {
      const blocked = task.blockedBy.filter(id => loadTask(id)?.status !== 'completed');
      throw new Error(`任务被阻塞，等待: ${blocked.join(', ')}`);
    }
    task.status = 'in_progress';
    task.owner = owner;
    saveTask(task);
    console.log(`[ClaimTask] ◑ [${task.id.slice(-8)}] ${task.subject} → in_progress (owner: ${owner})`);
    return task;
  },

  CompleteTask: async (effect: CompleteTaskEffect): Promise<{ task: TaskRecord; unblocked: TaskRecord[] }> => {
    const { taskId } = effect.input;
    const task = loadTask(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    task.status = 'completed';
    saveTask(task);
    // 查找被解锁的下游任务
    const allTasks = listAllTasks();
    const unblocked = allTasks.filter(t => t.status === 'pending' && t.blockedBy.includes(taskId) && canStart(t.id));
    console.log(`[CompleteTask] ● [${task.id.slice(-8)}] ${task.subject} ✓`);
    if (unblocked.length > 0) {
      console.log(`[CompleteTask] 解锁: ${unblocked.map(t => t.subject).join(', ')}`);
    }
    return { task, unblocked };
  },
};

// ============================================================
// Part 3: Agent Generator
// ============================================================

function* agentLoop(perform: PerformFn<S12Effect>) {
  const messages: Message[] = [
    { role: 'user', content: '帮我规划一个三步骤的项目：初始化、实现、测试。并演示任务认领和完成。' },
  ];

  while (true) {
    const response = yield* perform({ type: 'Chat', input: { messages } });
    messages.push({ role: 'assistant', content: extractText(response) });

    if (response.stop_reason !== 'tool_use') {
      return extractText(response);
    }

    const toolResults: Array<{ tool_use_id: string; content: string }> = [];

    for (const block of getToolUseBlocks(response)) {
      let output: string;
      switch (block.name) {
        case 'bash':
          output = yield* perform({ type: 'BashExec', input: { command: block.input['command'] as string } });
          break;
        case 'create_task': {
          const task = yield* perform({
            type: 'CreateTask',
            input: {
              subject: block.input['subject'] as string,
              description: block.input['description'] as string,
              blockedBy: (block.input['blockedBy'] as string[] | undefined) ?? [],
            },
          });
          output = JSON.stringify({ id: task.id, subject: task.subject, status: task.status });
          break;
        }
        case 'list_tasks': {
          const tasks = yield* perform({ type: 'ListTasks', input: {} });
          output = tasks.map(t => `[${t.status}] ${t.subject}`).join('\n');
          break;
        }
        case 'claim_task': {
          const task = yield* perform({
            type: 'ClaimTask',
            input: { taskId: block.input['taskId'] as string },
          });
          output = `已认领: ${task.subject} → ${task.status}`;
          break;
        }
        case 'complete_task': {
          const { task, unblocked } = yield* perform({
            type: 'CompleteTask',
            input: { taskId: block.input['taskId'] as string },
          });
          output = `已完成: ${task.subject}${unblocked.length ? `，解锁: ${unblocked.map(t => t.subject).join(', ')}` : ''}`;
          break;
        }
        default:
          output = `[未知工具] ${block.name}`;
      }
      toolResults.push({ tool_use_id: block.id, content: output });
    }

    messages.push({ role: 'user', content: JSON.stringify(toolResults) });
  }
}

// ============================================================
// Part 4: 启动入口
// ============================================================

cleanupTasks();
console.log('[S12] Task System 启动\n');
console.log(`任务目录: ${TASKS_DIR}\n`);

const result = await runAgent<S12Effect, string>(agentLoop, s12Handlers);

console.log('\n[S12] 完成:', result);
