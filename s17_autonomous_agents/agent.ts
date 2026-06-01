/**
 * s17: Autonomous Agents — 空闲循环是自主行为的效应基础
 *
 * 本章新增 3 个 Effect：
 *   IdlePoll      — 空闲时轮询（等待一段时间后返回，支持超时进入 SHUTDOWN）
 *   ScanUnclaimed — 扫描未认领的任务（status=pending 且依赖已满足）
 *   AutoClaim     — 原子认领任务（并发安全，失败时返回 success=false）
 *
 * 核心思想：自主 Agent = 主动轮询 + 机会主义执行
 * Agent 不等待用户指令，而是持续扫描环境，找到可执行任务就自动处理。
 * 空闲循环 = 在没有任务时的低频轮询 Effect，60s 超时后进入 SHUTDOWN。
 */

import { runAgent } from '../runtime/core.ts';
import type { BaseEffect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolUseBlock, TaskRecord } from '../runtime/types.ts';
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

// s17 新增：自主行为
interface IdlePollEffect extends BaseEffect {
  type: 'IdlePoll';
  input: { pollIntervalMs: number; reason: string };
  output: 'work' | 'shutdown'; // 发现任务=work，超时=shutdown
}

interface ScanUnclaimedEffect extends BaseEffect {
  type: 'ScanUnclaimed';
  input: Record<string, never>;
  output: TaskRecord[];
}

interface AutoClaimEffect extends BaseEffect {
  type: 'AutoClaim';
  input: { taskId: string; owner: string };
  output: { task: TaskRecord; success: boolean };
}

type S17Effect = ChatEffect | BashExecEffect | IdlePollEffect | ScanUnclaimedEffect | AutoClaimEffect;

// ============================================================
// Part 2: Handler 实现（自主任务扫描）
// ============================================================

const TASKS_DIR = path.join(os.tmpdir(), 'learn-claude-code-typescript', 's17', 'tasks');

// WORK → IDLE → SHUTDOWN 生命周期状态
type AgentLifecycle = 'WORK' | 'IDLE' | 'SHUTDOWN';
let lifecycle: AgentLifecycle = 'WORK';
let idleStartedAt: number | null = null;
const IDLE_TIMEOUT_MS = 500;    // 演示用短超时（真实场景 60000ms）
const IDLE_POLL_INTERVAL = 50;  // 演示用短间隔（真实场景 5000ms）

function ensureTasksDir() {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
}

function loadTask(taskId: string): TaskRecord | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, `${taskId}.json`), 'utf8')) as TaskRecord;
  } catch { return null; }
}

function saveTask(task: TaskRecord): void {
  ensureTasksDir();
  fs.writeFileSync(path.join(TASKS_DIR, `${task.id}.json`), JSON.stringify(task, null, 2), 'utf8');
}

function listAllTasks(): TaskRecord[] {
  ensureTasksDir();
  return fs.readdirSync(TASKS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8')) as TaskRecord; } catch { return null; }
    })
    .filter((t): t is TaskRecord => t !== null);
}

function extractText(response: LLMResponse): string {
  return response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text).join('');
}

function getToolUseBlocks(response: LLMResponse): ToolUseBlock[] {
  return response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

// Mock LLM：空闲扫描 → 发现任务 → 自动认领 → 执行 → 空闲 → SHUTDOWN
const mockResponses = [
  // 轮1：扫描未认领任务
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '扫描可用任务。' },
      { type: 'tool_use' as const, id: 'm1', name: 'scan_unclaimed', input: {} },
    ],
  },
  // 轮2：自动认领第一个任务
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '发现任务，自动认领。' },
      { type: 'tool_use' as const, id: 'm2', name: 'auto_claim', input: { owner: 'autonomous_agent' } },
    ],
  },
  // 轮3：执行任务
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '执行已认领的任务。' },
      { type: 'tool_use' as const, id: 'm3', name: 'bash', input: { command: 'echo "执行: 更新文档索引"' } },
    ],
  },
  // 轮4：任务完成，进入空闲轮询（会触发 SHUTDOWN 超时）
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '任务完成，进入空闲等待新任务。' },
      { type: 'tool_use' as const, id: 'm4', name: 'idle_poll', input: { pollIntervalMs: IDLE_POLL_INTERVAL, reason: '等待新任务' } },
    ],
  },
  // 轮5：结束（idle_poll 超时返回 shutdown）
  {
    stop_reason: 'end_turn' as const,
    content: [{ type: 'text' as const, text: '自主代理演示完成：WORK→IDLE→SHUTDOWN 生命周期。' }],
  },
];

let roundIndex = 0;
let lastClaimedTaskId: string | null = null;

function mockLLM(_messages: Message[]): LLMResponse {
  return mockResponses[Math.min(roundIndex++, mockResponses.length - 1)] as LLMResponse;
}

const s17Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const round = effect.input.messages.filter(m => m.role === 'assistant').length;
    console.log(`\n[Chat] → 轮次 ${round + 1} [${lifecycle}]`);
    await new Promise(r => setTimeout(r, 30));
    return mockLLM(effect.input.messages);
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    console.log(`[BashExec] → ${effect.input.command}`);
    if (lastClaimedTaskId) {
      const task = loadTask(lastClaimedTaskId);
      if (task && task.status === 'in_progress') {
        task.status = 'completed';
        saveTask(task);
        console.log(`[BashExec] 任务 ${lastClaimedTaskId.slice(-8)} 已完成`);
        lastClaimedTaskId = null;
        lifecycle = 'IDLE'; // 完成任务后进入 IDLE
        idleStartedAt = Date.now();
        console.log(`[Lifecycle] WORK → IDLE`);
      }
    }
    return `(执行: ${effect.input.command})`;
  },

  // IdlePoll：Promise.race 实现真实超时
  // 对应 CC 源码中的 idle_poll 超时机制
  IdlePoll: async (effect: IdlePollEffect): Promise<'work' | 'shutdown'> => {
    const { pollIntervalMs, reason } = effect.input;
    console.log(`[IdlePoll] ${reason} (间隔=${pollIntervalMs}ms, 超时=${IDLE_TIMEOUT_MS}ms)`);

    const startTime = idleStartedAt ?? Date.now();
    let elapsed = Date.now() - startTime;

    while (elapsed < IDLE_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, pollIntervalMs));
      elapsed = Date.now() - startTime;

      // 扫描是否有新任务
      const unclaimed = listAllTasks().filter(t => t.status === 'pending');
      if (unclaimed.length > 0) {
        lifecycle = 'WORK';
        console.log(`[IdlePoll] 发现新任务 → IDLE → WORK`);
        return 'work';
      }
      console.log(`[IdlePoll] 空闲中... (${elapsed}ms / ${IDLE_TIMEOUT_MS}ms)`);
    }

    // 超时：IDLE → SHUTDOWN
    lifecycle = 'SHUTDOWN';
    console.log(`[IdlePoll] 超时 → IDLE → SHUTDOWN`);
    return 'shutdown';
  },

  ScanUnclaimed: async (_effect: ScanUnclaimedEffect): Promise<TaskRecord[]> => {
    // 扫描 status=pending 且所有依赖已完成的任务
    const tasks = listAllTasks().filter(t => t.status === 'pending' && t.blockedBy.every(dep => {
      const depTask = loadTask(dep);
      return depTask?.status === 'completed';
    }));
    console.log(`[ScanUnclaimed] 发现 ${tasks.length} 个可认领任务`);
    tasks.forEach(t => console.log(`  ○ [${t.id.slice(-8)}] ${t.subject}`));
    return tasks;
  },

  AutoClaim: async (effect: AutoClaimEffect): Promise<{ task: TaskRecord; success: boolean }> => {
    const { taskId, owner } = effect.input;
    const task = loadTask(taskId);
    if (!task || task.status !== 'pending') {
      return { task: task ?? { id: taskId, subject: '未知', description: '', status: 'completed', owner: null, blockedBy: [] }, success: false };
    }
    task.status = 'in_progress';
    task.owner = owner;
    saveTask(task);
    lastClaimedTaskId = taskId;
    lifecycle = 'WORK';
    console.log(`[AutoClaim] ◑ [${task.id.slice(-8)}] ${task.subject} → ${owner} [IDLE→WORK]`);
    return { task, success: true };
  },
};

// ============================================================
// Part 3: Agent Generator（自主扫描循环）
// ============================================================

function* agentLoop(perform: PerformFn<S17Effect>) {
  const messages: Message[] = [
    { role: 'user', content: '作为自主代理，持续扫描并执行可用任务，无任务时进入空闲等待。' },
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
        case 'idle_poll': {
          const pollResult = yield* perform({
            type: 'IdlePoll',
            input: { pollIntervalMs: block.input['pollIntervalMs'] as number, reason: block.input['reason'] as string },
          });
          output = pollResult === 'work' ? '发现新任务，回到 WORK 状态' : '空闲超时，进入 SHUTDOWN';
          break;
        }
        case 'scan_unclaimed': {
          const tasks = yield* perform({ type: 'ScanUnclaimed', input: {} });
          if (tasks.length > 0) {
            output = `发现 ${tasks.length} 个任务: ${tasks.map(t => `${t.id}(${t.subject})`).join(', ')}`;
            (globalThis as any)._pendingTaskId = tasks[0].id;
          } else {
            output = '暂无可用任务';
          }
          break;
        }
        case 'auto_claim': {
          const taskId = (globalThis as any)._pendingTaskId as string | undefined;
          if (!taskId) { output = '无待认领任务'; break; }
          const { task, success } = yield* perform({
            type: 'AutoClaim',
            input: { taskId, owner: block.input['owner'] as string },
          });
          output = success ? `已认领: ${task.subject}` : `认领失败: ${task.subject}`;
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
// Part 4: 启动入口（预置一些未认领任务）
// ============================================================

// 清理并预置任务
fs.mkdirSync(TASKS_DIR, { recursive: true });
fs.readdirSync(TASKS_DIR).forEach(f => { try { fs.unlinkSync(path.join(TASKS_DIR, f)); } catch {} });

const preloadedTasks: TaskRecord[] = [
  { id: `task_${Date.now()}_0001`, subject: '更新文档索引', description: '重建搜索索引', status: 'pending', owner: null, blockedBy: [] },
  { id: `task_${Date.now()}_0002`, subject: '清理日志文件', description: '删除7天前的日志', status: 'pending', owner: null, blockedBy: [] },
];
preloadedTasks.forEach(t => fs.writeFileSync(path.join(TASKS_DIR, `${t.id}.json`), JSON.stringify(t, null, 2), 'utf8'));

console.log('[S17] Autonomous Agents 启动\n');
console.log(`生命周期: WORK → IDLE → SHUTDOWN (超时=${IDLE_TIMEOUT_MS}ms, 间隔=${IDLE_POLL_INTERVAL}ms)`);
console.log(`预置 ${preloadedTasks.length} 个未认领任务\n`);

const result = await runAgent<S17Effect, string>(agentLoop, s17Handlers);

console.log(`\n[Lifecycle] 最终状态: ${lifecycle}`);
console.log('\n[S17] 完成:', result);
