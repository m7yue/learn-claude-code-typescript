/**
 * s16: Team Protocols — 协议是 Agent 间协作的效应约定
 *
 * 本章新增 3 个 Effect：
 *   RequestPlan     — 主 Agent 向规划 Agent 请求执行计划
 *   ReviewPlan      — 审查 Agent 审核并批准/拒绝计划
 *   RequestShutdown — 请求关闭 Agent（需经过确认协议）
 *
 * 核心思想：协议 = 效应的有序编排
 * 多 Agent 协作不是自由消息传递，而是有明确角色和状态机的效应序列。
 * 每一步都有确定的前置条件和后置结果，对应 ProtocolState 状态转换。
 */

import { runAgent } from '../runtime/core.ts';
import type { BaseEffect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolUseBlock } from '../runtime/types.ts';
import * as crypto from 'node:crypto';

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

type PlanStatus = 'pending' | 'approved' | 'rejected';

interface Plan {
  requestId: string;
  description: string;
  steps: string[];
  status: PlanStatus;
  reviewer?: string;
  feedback?: string;
}

// s16 新增：团队协议
interface RequestPlanEffect extends BaseEffect {
  type: 'RequestPlan';
  input: { requestId: string; goal: string; context: string };
  output: Plan;
}

interface ReviewPlanEffect extends BaseEffect {
  type: 'ReviewPlan';
  input: { plan: Plan; reviewerId: string };
  output: { approved: boolean; feedback: string; revisedPlan?: Plan };
}

interface RequestShutdownEffect extends BaseEffect {
  type: 'RequestShutdown';
  input: { agentId: string; reason: string };
  output: { acknowledged: boolean; gracePeriodMs: number };
}

type S16Effect = ChatEffect | BashExecEffect | RequestPlanEffect | ReviewPlanEffect | RequestShutdownEffect;

// ============================================================
// Part 2: Handler 实现（协议状态机）
// ============================================================

// ProtocolState：追踪每个协议请求的生命周期
// 对应 CC 源码 protocol.ts 的 ProtocolState 类
interface ProtocolState {
  requestId: string;
  type: 'plan' | 'shutdown';
  sender: string;
  target: string;
  status: 'pending' | 'fulfilled';
  createdAt: number;
}

// 活跃协议请求注册表：requestId → ProtocolState
const pendingRequests = new Map<string, ProtocolState>();

// 通过 requestId 关联响应，验证协议类型，标记 fulfilled
// 对应 CC 源码 protocol.ts 的 matchResponse()
function matchResponse(requestId: string, expectedType: 'plan' | 'shutdown'): ProtocolState | null {
  const req = pendingRequests.get(requestId);
  if (!req) return null;
  if (req.type !== expectedType) return null;
  if (req.status !== 'pending') return null;
  req.status = 'fulfilled';
  return req;
}

function extractText(response: LLMResponse): string {
  return response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text).join('');
}

function getToolUseBlocks(response: LLMResponse): ToolUseBlock[] {
  return response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

// Mock LLM：请求计划 → 审查 → 执行 → 关闭
const mockResponses = [
  // 轮1：请求执行计划（requestId 由 Handler 生成，LLM 可传也可留空由 Handler 生成）
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '向规划 Agent 请求执行计划。' },
      {
        type: 'tool_use' as const, id: 'm1', name: 'request_plan',
        input: { requestId: 'plan_001', goal: '重构认证模块', context: '需要升级到 OAuth 2.0，保持向后兼容' }
      },
    ],
  },
  // 轮2：提交审查（用 requestId 关联对应计划）
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '提交计划审查。' },
      {
        type: 'tool_use' as const, id: 'm2', name: 'review_plan',
        input: { requestId: 'plan_001', reviewerId: 'senior_agent' }
      },
    ],
  },
  // 轮3：执行已批准的计划步骤
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '执行计划第一步。' },
      { type: 'tool_use' as const, id: 'm3', name: 'bash', input: { command: 'echo "步骤1: 创建 OAuth 适配器"' } },
    ],
  },
  // 轮4：请求关闭（需要协议确认）
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '任务完成，请求关闭。' },
      {
        type: 'tool_use' as const, id: 'm4', name: 'request_shutdown',
        input: { agentId: 'main', reason: '重构任务已完成' }
      },
    ],
  },
  // 轮5：结束
  {
    stop_reason: 'end_turn' as const,
    content: [{ type: 'text' as const, text: '协议流程演示完成：计划请求→审查→执行→关闭。' }],
  },
];

let roundIndex = 0;
const plans = new Map<string, Plan>();

function mockLLM(_messages: Message[]): LLMResponse {
  return mockResponses[Math.min(roundIndex++, mockResponses.length - 1)] as LLMResponse;
}

const s16Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const round = effect.input.messages.filter(m => m.role === 'assistant').length;
    console.log(`\n[Chat] → 轮次 ${round + 1}`);
    await new Promise(r => setTimeout(r, 30));
    return mockLLM(effect.input.messages);
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    console.log(`[BashExec] → ${effect.input.command}`);
    return `(执行: ${effect.input.command})`;
  },

  RequestPlan: async (effect: RequestPlanEffect): Promise<Plan> => {
    const { requestId, goal, context: _context } = effect.input;
    // 注册协议请求（pending 状态），等待 ReviewPlan 响应
    const protocolReq: ProtocolState = {
      requestId,
      type: 'plan',
      sender: 'main',
      target: 'planner',
      status: 'pending',
      createdAt: Date.now(),
    };
    pendingRequests.set(requestId, protocolReq);

    const plan: Plan = {
      requestId,
      description: goal,
      steps: [
        '分析现有认证逻辑',
        '设计 OAuth 2.0 适配器接口',
        '实现 Token 刷新机制',
        '添加向后兼容层',
        '编写集成测试',
      ],
      status: 'pending',
    };
    plans.set(requestId, plan);

    console.log(`[RequestPlan] requestId=${requestId} → "${goal}"`);
    console.log(`  协议注册: ${requestId} (pending)`);
    console.log(`  生成计划 (${plan.steps.length} 步):`);
    plan.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    return plan;
  },

  ReviewPlan: async (effect: ReviewPlanEffect): Promise<{ approved: boolean; feedback: string; revisedPlan?: Plan }> => {
    const { plan, reviewerId } = effect.input;
    const requestId = plan.requestId;

    // 通过 requestId 关联响应，防止孤立审查
    const matched = matchResponse(requestId, 'plan');
    if (!matched) {
      console.log(`[ReviewPlan] 警告: requestId=${requestId} 无对应待审 plan，拒绝`);
      return { approved: false, feedback: '未找到对应的计划请求' };
    }

    const storedPlan = plans.get(requestId);
    if (!storedPlan) throw new Error(`计划不存在: ${requestId}`);

    const approved = true;
    const feedback = '计划合理，步骤清晰，批准执行';
    storedPlan.status = approved ? 'approved' : 'rejected';
    storedPlan.reviewer = reviewerId;
    storedPlan.feedback = feedback;

    console.log(`[ReviewPlan] requestId=${requestId} reviewerId=${reviewerId}`);
    console.log(`  协议匹配: pending → fulfilled`);
    console.log(`  决定: ${approved ? '✓ 批准' : '✗ 拒绝'} — ${feedback}`);
    return { approved, feedback };
  },

  RequestShutdown: async (effect: RequestShutdownEffect): Promise<{ acknowledged: boolean; gracePeriodMs: number }> => {
    const { agentId, reason } = effect.input;
    const requestId = `shutdown_${crypto.randomUUID().slice(0, 8)}`;

    // 注册关闭协议请求
    pendingRequests.set(requestId, {
      requestId,
      type: 'shutdown',
      sender: agentId,
      target: 'coordinator',
      status: 'fulfilled', // 立即确认（无需二次审查）
      createdAt: Date.now(),
    });

    const gracePeriodMs = 500;
    console.log(`[RequestShutdown] agentId=${agentId} requestId=${requestId}`);
    console.log(`  原因: ${reason}`);
    console.log(`  确认关闭，宽限期: ${gracePeriodMs}ms`);
    return { acknowledged: true, gracePeriodMs };
  },
};

// ============================================================
// Part 3: Agent Generator
// ============================================================

function* agentLoop(perform: PerformFn<S16Effect>) {
  const messages: Message[] = [
    { role: 'user', content: '使用协议流程完成认证模块重构：请求计划、审查、执行、关闭。' },
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
        case 'request_plan': {
          const plan = yield* perform({
            type: 'RequestPlan',
            input: {
              requestId: block.input['requestId'] as string,
              goal: block.input['goal'] as string,
              context: block.input['context'] as string,
            },
          });
          output = `计划已生成 requestId=${plan.requestId} (${plan.steps.length} 步): ${plan.description}`;
          break;
        }
        case 'review_plan': {
          // 从 plans Map 取出对应计划（通过 requestId 关联）
          const requestId = block.input['requestId'] as string;
          const plan = plans.get(requestId);
          if (!plan) { output = `无 requestId=${requestId} 的待审计划`; break; }
          const review = yield* perform({
            type: 'ReviewPlan',
            input: { plan, reviewerId: block.input['reviewerId'] as string },
          });
          output = `审查结果 (${requestId}): ${review.approved ? '批准' : '拒绝'} — ${review.feedback}`;
          break;
        }
        case 'request_shutdown': {
          const shutdown = yield* perform({
            type: 'RequestShutdown',
            input: { agentId: block.input['agentId'] as string, reason: block.input['reason'] as string },
          });
          output = `关闭确认: ${shutdown.acknowledged} (宽限期 ${shutdown.gracePeriodMs}ms)`;
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

console.log('[S16] Team Protocols 启动\n');

const result = await runAgent<S16Effect, string>(agentLoop, s16Handlers);

// 显示协议状态汇总
console.log('\n[Protocol] 协议请求汇总:');
for (const [id, req] of pendingRequests) {
  console.log(`  ${id}: type=${req.type} ${req.sender}→${req.target} [${req.status}]`);
}

console.log('\n[S16] 完成:', result);
