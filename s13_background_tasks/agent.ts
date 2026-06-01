/**
 * s13: Background Tasks — 后台任务是异步效应的并发容器
 *
 * 本章新增 3 个 Effect：
 *   SpawnBackground      — 启动后台任务（返回任务句柄）
 *   CollectNotifications — 轮询通知队列（非阻塞）
 *   WaitBackground       — 等待特定后台任务完成（阻塞）
 *
 * 核心思想：后台任务 = 不阻塞主 Generator 的效应调度
 * 主 Agent 继续执行，后台任务异步运行，完成时写入通知队列。
 * 通知注入不依赖 LLM 主动调用工具——每轮 Chat 前自动检查。
 */

import { runAgent } from '../runtime/core.ts';
import type { BaseEffect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolUseBlock } from '../runtime/types.ts';

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

// s13 新增：后台任务管理
interface SpawnBackgroundEffect extends BaseEffect {
  type: 'SpawnBackground';
  input: { taskId: string; description: string; durationMs: number };
  output: { taskId: string; status: 'started' };
}

interface CollectNotificationsEffect extends BaseEffect {
  type: 'CollectNotifications';
  input: Record<string, never>;
  output: Notification[];
}

interface WaitBackgroundEffect extends BaseEffect {
  type: 'WaitBackground';
  input: { taskId: string };
  output: { taskId: string; result: string };
}

interface Notification {
  taskId: string;
  event: 'completed' | 'failed';
  result: string;
  timestamp: number;
}

type S13Effect = ChatEffect | BashExecEffect | SpawnBackgroundEffect | CollectNotificationsEffect | WaitBackgroundEffect;

// ============================================================
// Part 2: Handler 实现（后台任务调度）
// ============================================================

// 全局通知队列（Handler 与 Generator 解耦的共享状态）
const notificationQueue: Notification[] = [];
const backgroundTasks = new Map<string, Promise<string>>();

// 启发式慢操作检测：识别需要后台化的命令
// 对应 CC 源码的 pendingToolUseSummary / is_slow_operation() 逻辑
function isSlowOperation(command: string): boolean {
  const slowKeywords = ['install', 'build', 'test', 'compile', 'lint', 'typecheck', 'tsc', 'webpack', 'vite'];
  const lower = command.toLowerCase();
  return slowKeywords.some(kw => lower.includes(kw));
}

function extractText(response: LLMResponse): string {
  return response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text).join('');
}

function getToolUseBlocks(response: LLMResponse): ToolUseBlock[] {
  return response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

// Mock LLM：前台工作 + 后台任务自动后台化 + 通知自动注入
const mockResponses = [
  // 轮1：启动一个明确的后台任务 + 一个耗时命令（自动后台化）
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '启动后台扫描，同时执行构建命令。' },
      { type: 'tool_use' as const, id: 'm1', name: 'spawn_background', input: { taskId: 'bg_scan', description: '扫描代码库', durationMs: 80 } },
      { type: 'tool_use' as const, id: 'm2', name: 'bash', input: { command: 'npm run build' } }, // build → isSlowOperation → 自动后台化
    ],
  },
  // 轮2：前台继续工作（此时 bg_scan 和 build 都在后台运行）
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '前台继续执行其他任务...' },
      { type: 'tool_use' as const, id: 'm3', name: 'bash', input: { command: 'echo "前台工作进行中"' } },
    ],
  },
  // 轮3：等待扫描任务（通知可能已在 Chat 前自动注入了）
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '等待代码扫描完成。' },
      { type: 'tool_use' as const, id: 'm4', name: 'wait_background', input: { taskId: 'bg_scan' } },
    ],
  },
  // 轮4：结束
  {
    stop_reason: 'end_turn' as const,
    content: [{ type: 'text' as const, text: '所有后台任务已完成，主 Agent 完成工作。' }],
  },
];

let roundIndex = 0;
function mockLLM(_messages: Message[]): LLMResponse {
  return mockResponses[Math.min(roundIndex++, mockResponses.length - 1)] as LLMResponse;
}

const s13Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const round = effect.input.messages.filter(m => m.role === 'assistant').length;
    console.log(`\n[Chat] → 轮次 ${round + 1}`);
    await new Promise(r => setTimeout(r, 30));
    return mockLLM(effect.input.messages);
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    const { command } = effect.input;
    if (isSlowOperation(command)) {
      // 自动后台化：耗时操作不阻塞 Handler 返回
      const taskId = `bg_auto_${Date.now()}`;
      console.log(`[BashExec] 检测到慢操作，自动后台化: "${command}" → taskId=${taskId}`);
      const promise = new Promise<string>(resolve => {
        setTimeout(() => {
          const result = `${command} 完成（自动后台）`;
          notificationQueue.push({ taskId, event: 'completed', result, timestamp: Date.now() });
          resolve(result);
        }, 60);
      });
      backgroundTasks.set(taskId, promise);
      return `已后台化 (${taskId})，主 Agent 可继续工作`;
    }
    console.log(`[BashExec] → ${command}`);
    return `(执行: ${command})`;
  },

  SpawnBackground: async (effect: SpawnBackgroundEffect): Promise<{ taskId: string; status: 'started' }> => {
    const { taskId, description, durationMs } = effect.input;
    console.log(`[SpawnBackground] 启动: ${taskId} — ${description} (${durationMs}ms)`);
    const promise = new Promise<string>(resolve => {
      setTimeout(() => {
        const result = `${description} 完成`;
        notificationQueue.push({ taskId, event: 'completed', result, timestamp: Date.now() });
        resolve(result);
      }, durationMs);
    });
    backgroundTasks.set(taskId, promise);
    return { taskId, status: 'started' };
  },

  CollectNotifications: async (_effect: CollectNotificationsEffect): Promise<Notification[]> => {
    const notifications = [...notificationQueue];
    notificationQueue.length = 0;
    console.log(`[CollectNotifications] 收到 ${notifications.length} 条通知`);
    notifications.forEach(n => console.log(`  ✓ ${n.taskId}: ${n.result}`));
    return notifications;
  },

  WaitBackground: async (effect: WaitBackgroundEffect): Promise<{ taskId: string; result: string }> => {
    const { taskId } = effect.input;
    const promise = backgroundTasks.get(taskId);
    if (!promise) throw new Error(`后台任务不存在: ${taskId}`);
    console.log(`[WaitBackground] 等待: ${taskId}...`);
    const result = await promise;
    console.log(`[WaitBackground] 完成: ${taskId} → ${result}`);
    return { taskId, result };
  },
};

// ============================================================
// Part 3: Agent Generator
// ============================================================

// 通知自动注入：每轮 Chat 前检查 notificationQueue
// 这是关键机制——通知由 Loop 自动前置，不依赖 LLM 主动调用工具
// 对应 CC 源码 Agent Loop 的 pendingToolUseSummary 注入逻辑
function* agentLoop(perform: PerformFn<S13Effect>) {
  const messages: Message[] = [
    { role: 'user', content: '启动后台分析任务，同时继续前台工作，然后收集结果。' },
  ];

  while (true) {
    // 自动注入：每轮 Chat 前，将已完成的后台任务通知前置注入 messages
    if (notificationQueue.length > 0) {
      const pending = [...notificationQueue];
      notificationQueue.length = 0;
      const notifText = pending.map(n => `<task_notification>\n任务 ${n.taskId} ${n.event}: ${n.result}\n</task_notification>`).join('\n');
      console.log(`[AutoInject] 自动注入 ${pending.length} 条通知到 messages`);
      messages.push({ role: 'user', content: notifText });
    }

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
        case 'spawn_background': {
          const { taskId, status } = yield* perform({
            type: 'SpawnBackground',
            input: {
              taskId: block.input['taskId'] as string,
              description: block.input['description'] as string,
              durationMs: block.input['durationMs'] as number,
            },
          });
          output = `后台任务已启动: ${taskId} (${status})`;
          break;
        }
        case 'collect_notifications': {
          const notifications = yield* perform({ type: 'CollectNotifications', input: {} });
          output = notifications.length
            ? notifications.map(n => `${n.taskId}: ${n.result}`).join('\n')
            : '暂无通知';
          break;
        }
        case 'wait_background': {
          const { taskId, result } = yield* perform({
            type: 'WaitBackground',
            input: { taskId: block.input['taskId'] as string },
          });
          output = `${taskId} 完成: ${result}`;
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

console.log('[S13] Background Tasks 启动\n');

const result = await runAgent<S13Effect, string>(agentLoop, s13Handlers);

console.log('\n[S13] 完成:', result);
