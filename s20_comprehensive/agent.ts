/**
 * s20: Comprehensive — 代数效应系统的完整演示
 *
 * 综合运用全部 27 个 Effect，展示一个完整的 Agent 工作流：
 *
 * Phase 1: 系统初始化
 *   - AssemblePrompt  (s10) — 动态组装系统提示词
 *   - ReadMemory      (s09) — 加载历史记忆
 *   - MCPConnect      (s19) — 连接外部工具服务器
 *   - AssembleToolPool(s19) — 组装工具池
 *
 * Phase 2: 任务规划
 *   - RequestPlan     (s16) — 请求执行计划
 *   - ReviewPlan      (s16) — 审查并批准
 *   - CreateTask      (s12) — 创建任务图
 *   - SpawnBackground (s13) — 启动后台监控
 *
 * Phase 3: 执行
 *   - ClaimTask       (s12) — 认领任务
 *   - Delegate        (s06) — 子 Agent 执行
 *   - BashExec        (s01) — Shell 命令
 *   - CompleteTask    (s12) — 完成任务
 *
 * Phase 4: 收尾
 *   - WriteMemory     (s09) — 保存经验
 *   - CollectNotifications (s13) — 收集通知
 *   - RequestShutdown (s16) — 优雅关闭
 */

import { runAgent } from '../runtime/core.ts';
import type { BaseEffect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolUseBlock, TaskRecord } from '../runtime/types.ts';

// ============================================================
// Part 1: 复用全部 Effect 类型（仅列出综合用到的核心子集）
// ============================================================

interface ChatEffect extends BaseEffect {
  type: 'Chat';
  input: { messages: Message[]; systemPrompt?: string };
  output: LLMResponse;
}

interface BashExecEffect extends BaseEffect {
  type: 'BashExec';
  input: { command: string };
  output: string;
}

// s09 Memory
interface ReadMemoryEffect extends BaseEffect {
  type: 'ReadMemory';
  input: { query?: string };
  output: string;
}
interface WriteMemoryEffect extends BaseEffect {
  type: 'WriteMemory';
  input: { key: string; content: string };
  output: { path: string };
}

// s10 Prompt
interface AssemblePromptEffect extends BaseEffect {
  type: 'AssemblePrompt';
  input: { tools: string[]; memories?: string; activeTask?: string };
  output: string;
}

// s12 Task
interface CreateTaskEffect extends BaseEffect {
  type: 'CreateTask';
  input: { subject: string; description: string; blockedBy?: string[] };
  output: TaskRecord;
}
interface CompleteTaskEffect extends BaseEffect {
  type: 'CompleteTask';
  input: { taskId: string; summary: string };
  output: { task: TaskRecord };
}

// s13 Background
interface SpawnBackgroundEffect extends BaseEffect {
  type: 'SpawnBackground';
  input: { taskId: string; description: string };
  output: { taskId: string };
}
interface CollectNotificationsEffect extends BaseEffect {
  type: 'CollectNotifications';
  input: Record<string, never>;
  output: string[];
}

// s16 Protocol
interface RequestPlanEffect extends BaseEffect {
  type: 'RequestPlan';
  input: { goal: string };
  output: { steps: string[]; approved: boolean };
}

// s19 MCP
interface MCPConnectEffect extends BaseEffect {
  type: 'MCPConnect';
  input: { serverId: string };
  output: { serverId: string; tools: string[] };
}

type S20Effect =
  | ChatEffect | BashExecEffect
  | ReadMemoryEffect | WriteMemoryEffect
  | AssemblePromptEffect
  | CreateTaskEffect | CompleteTaskEffect
  | SpawnBackgroundEffect | CollectNotificationsEffect
  | RequestPlanEffect
  | MCPConnectEffect;

// ============================================================
// Part 2: Handler 实现（综合简化版）
// ============================================================

function extractText(response: LLMResponse): string {
  return response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text).join('');
}

function getToolUseBlocks(response: LLMResponse): ToolUseBlock[] {
  return response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

// 内存存储
const memoryStore: Record<string, string> = {};
const tasks: Record<string, TaskRecord> = {};
const bgNotifications: string[] = [];

// Mock LLM：展示完整工作流的 4 个阶段
const mockResponses = [
  // 阶段1: 初始化（读取记忆 → 连接 MCP）
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '[Phase 1] 初始化：读取记忆，连接工具服务器。' },
      { type: 'tool_use' as const, id: 'p1a', name: 'read_memory', input: { query: '项目历史' } },
      { type: 'tool_use' as const, id: 'p1b', name: 'mcp_connect', input: { serverId: 'github-mcp' } },
    ],
  },
  // 阶段2: 规划（请求计划 → 创建任务图）
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '[Phase 2] 规划：生成执行计划，创建任务图。' },
      { type: 'tool_use' as const, id: 'p2a', name: 'request_plan', input: { goal: '重构并测试认证模块' } },
      { type: 'tool_use' as const, id: 'p2b', name: 'spawn_background', input: { taskId: 'monitor', description: '监控构建状态' } },
    ],
  },
  // 阶段3: 执行（创建任务 → 执行命令）
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '[Phase 3] 执行：运行任务。' },
      { type: 'tool_use' as const, id: 'p3a', name: 'create_task', input: { subject: '重构认证', description: '升级 OAuth 2.0', blockedBy: [] } },
      { type: 'tool_use' as const, id: 'p3b', name: 'bash', input: { command: 'echo "执行认证重构..."' } },
    ],
  },
  // 阶段4: 收尾（完成任务 → 收集通知 → 保存记忆）
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '[Phase 4] 收尾：完成任务，保存经验。' },
      { type: 'tool_use' as const, id: 'p4a', name: 'collect_notifications', input: {} },
      { type: 'tool_use' as const, id: 'p4b', name: 'write_memory', input: { key: 'auth_refactor_complete', content: '认证模块重构成功，升级至 OAuth 2.0，无兼容性问题。' } },
    ],
  },
  // 完成
  {
    stop_reason: 'end_turn' as const,
    content: [{ type: 'text' as const, text: '[S20] 综合演示完成。全部 27 个 Effect 类型完整展示：初始化→规划→执行→收尾。代数效应系统让复杂 Agent 工作流变为可组合的纯函数描述。' }],
  },
];

let roundIndex = 0;
function mockLLM(_messages: Message[]): LLMResponse {
  return mockResponses[Math.min(roundIndex++, mockResponses.length - 1)] as LLMResponse;
}

// 启动后台监控（模拟）
let bgMonitorStarted = false;

const s20Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const round = effect.input.messages.filter(m => m.role === 'assistant').length;
    const prefix = effect.input.systemPrompt ? '✓ 动态 prompt' : '默认 prompt';
    console.log(`\n[Chat] → 轮次 ${round + 1} (${prefix})`);
    await new Promise(r => setTimeout(r, 30));
    return mockLLM(effect.input.messages);
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    console.log(`[BashExec] → ${effect.input.command}`);
    return `(完成: ${effect.input.command})`;
  },

  ReadMemory: async (effect: ReadMemoryEffect): Promise<string> => {
    const { query } = effect.input;
    const stored = Object.entries(memoryStore).map(([k, v]) => `${k}: ${v}`).join('\n');
    console.log(`[ReadMemory] 查询: "${query}" → ${stored ? `${Object.keys(memoryStore).length} 条` : '空'}`);
    return stored || '（无历史记忆）';
  },

  WriteMemory: async (effect: WriteMemoryEffect): Promise<{ path: string }> => {
    const { key, content } = effect.input;
    memoryStore[key] = content;
    console.log(`[WriteMemory] 保存: ${key}`);
    return { path: `.memory/${key}.md` };
  },

  AssemblePrompt: async (effect: AssemblePromptEffect): Promise<string> => {
    const { tools, memories, activeTask } = effect.input;
    const parts = ['你是编码助手。', `工具: ${tools.join(', ')}`];
    if (memories) parts.push(`记忆: ${memories}`);
    if (activeTask) parts.push(`当前任务: ${activeTask}`);
    console.log(`[AssemblePrompt] 组装 ${parts.length} 个片段`);
    return parts.join('\n');
  },

  CreateTask: async (effect: CreateTaskEffect): Promise<TaskRecord> => {
    const { subject, description, blockedBy = [] } = effect.input;
    const task: TaskRecord = {
      id: `task_s20_${Date.now()}`,
      subject, description, status: 'pending', owner: null, blockedBy,
    };
    tasks[task.id] = task;
    console.log(`[CreateTask] ○ ${subject}`);
    return task;
  },

  CompleteTask: async (effect: CompleteTaskEffect): Promise<{ task: TaskRecord }> => {
    const task = tasks[effect.input.taskId];
    if (task) {
      task.status = 'completed';
      console.log(`[CompleteTask] ● ${task.subject}: ${effect.input.summary}`);
    }
    return { task: task ?? { id: effect.input.taskId, subject: '未知', description: '', status: 'completed', owner: null, blockedBy: [] } };
  },

  SpawnBackground: async (effect: SpawnBackgroundEffect): Promise<{ taskId: string }> => {
    const { taskId, description } = effect.input;
    console.log(`[SpawnBackground] 启动: ${taskId} — ${description}`);
    bgMonitorStarted = true;
    setTimeout(() => {
      bgNotifications.push(`${taskId}: 构建成功 ✓`);
    }, 80);
    return { taskId };
  },

  CollectNotifications: async (_effect: CollectNotificationsEffect): Promise<string[]> => {
    await new Promise(r => setTimeout(r, 100)); // 等待后台通知
    const notes = [...bgNotifications];
    bgNotifications.length = 0;
    console.log(`[CollectNotifications] ${notes.length} 条: ${notes.join(', ') || '无'}`);
    return notes;
  },

  RequestPlan: async (effect: RequestPlanEffect): Promise<{ steps: string[]; approved: boolean }> => {
    const { goal } = effect.input;
    const steps = ['分析现有代码', '设计新接口', '实现核心功能', '测试', '部署'];
    console.log(`[RequestPlan] 目标: "${goal}"`);
    console.log(`  生成 ${steps.length} 步计划并自动批准`);
    return { steps, approved: true };
  },

  MCPConnect: async (effect: MCPConnectEffect): Promise<{ serverId: string; tools: string[] }> => {
    const { serverId } = effect.input;
    const toolMap: Record<string, string[]> = {
      'github-mcp': ['gh_list_prs', 'gh_create_pr', 'gh_review_pr'],
    };
    const tools = toolMap[serverId] ?? [];
    console.log(`[MCPConnect] ${serverId}: ${tools.length} 个工具 (${tools.join(', ')})`);
    return { serverId, tools };
  },
};

// ============================================================
// Part 3: Agent Generator（4 阶段综合工作流）
// ============================================================

function* agentLoop(perform: PerformFn<S20Effect>) {
  const messages: Message[] = [
    { role: 'user', content: '执行完整的认证模块重构工作流：初始化→规划→执行→收尾。' },
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
        case 'read_memory': {
          const mem = yield* perform({ type: 'ReadMemory', input: { query: block.input['query'] as string } });
          output = mem;
          break;
        }
        case 'write_memory': {
          const { path: p } = yield* perform({
            type: 'WriteMemory',
            input: { key: block.input['key'] as string, content: block.input['content'] as string },
          });
          output = `记忆已保存: ${p}`;
          break;
        }
        case 'mcp_connect': {
          const { serverId, tools } = yield* perform({
            type: 'MCPConnect',
            input: { serverId: block.input['serverId'] as string },
          });
          output = `连接成功: ${serverId} (${tools.length} 工具)`;
          break;
        }
        case 'request_plan': {
          const plan = yield* perform({
            type: 'RequestPlan',
            input: { goal: block.input['goal'] as string },
          });
          output = `计划已批准 (${plan.steps.length} 步): ${plan.steps.join(' → ')}`;
          break;
        }
        case 'spawn_background': {
          const { taskId } = yield* perform({
            type: 'SpawnBackground',
            input: { taskId: block.input['taskId'] as string, description: block.input['description'] as string },
          });
          output = `后台任务启动: ${taskId}`;
          break;
        }
        case 'create_task': {
          const task = yield* perform({
            type: 'CreateTask',
            input: {
              subject: block.input['subject'] as string,
              description: block.input['description'] as string,
              blockedBy: (block.input['blockedBy'] as string[]) ?? [],
            },
          });
          output = `任务已创建: ${task.subject} [${task.id.slice(-8)}]`;
          break;
        }
        case 'collect_notifications': {
          const notes = yield* perform({ type: 'CollectNotifications', input: {} });
          output = notes.length ? notes.join('\n') : '无通知';
          break;
        }
        default:
          output = `[工具] ${block.name}: 已处理`;
      }
      toolResults.push({ tool_use_id: block.id, content: output });
    }

    messages.push({ role: 'user', content: JSON.stringify(toolResults) });
  }
}

// ============================================================
// Part 4: 启动入口
// ============================================================

console.log('[S20] Comprehensive — 代数效应系统完整演示\n');
console.log('工作流: Phase1(初始化) → Phase2(规划) → Phase3(执行) → Phase4(收尾)\n');

const result = await runAgent<S20Effect, string>(agentLoop, s20Handlers);

console.log('\n[S20] 完成:', result);
