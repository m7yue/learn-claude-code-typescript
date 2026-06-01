/**
 * s11: Error Recovery — 错误是效应的另一种输出
 *
 * 本章新增 2 个 Effect：
 *   RetryWithBackoff — 指数退避重试（429/529 错误）
 *   SwitchModel      — 切换到备用模型
 *
 * 三条恢复路径（对应 Python 版 RecoveryState）：
 *   Path 1: max_tokens 超限 → 升级 token 限制 → 续接输出
 *   Path 2: prompt_too_long → 应急压缩 → 重试
 *   Path 3: 429/529 过载   → 指数退避 → 可选模型切换
 */

import { runAgent } from '../runtime/core.ts';
import type { BaseEffect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolUseBlock } from '../runtime/types.ts';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

// 扩展 ChatEffect，包含模型和 token 参数
interface ChatEffect extends BaseEffect {
  type: 'Chat';
  input: {
    messages: Message[];
    model?: string;
    maxTokens?: number;
  };
  output: LLMResponse;
}

interface BashExecEffect extends BaseEffect {
  type: 'BashExec';
  input: { command: string };
  output: string;
}

// s11 新增：带退避的重试
interface RetryWithBackoffEffect extends BaseEffect {
  type: 'RetryWithBackoff';
  input: {
    attempt: number;
    errorType: '429' | '529';
    retryAfterMs?: number;
  };
  output: void;
}

// s11 新增：模型切换
interface SwitchModelEffect extends BaseEffect {
  type: 'SwitchModel';
  input: { reason: string; fromModel: string };
  output: string; // 新模型名称
}

type S11Effect = ChatEffect | BashExecEffect | RetryWithBackoffEffect | SwitchModelEffect;

// ============================================================
// Part 2: 错误类型定义
// ============================================================

class RateLimitError extends Error {
  constructor(public retryAfterMs?: number) {
    super('Rate limit exceeded (429)');
  }
}

class OverloadedError extends Error {
  constructor() { super('Service overloaded (529)'); }
}

class PromptTooLongError extends Error {
  constructor() { super('Prompt too long'); }
}

class MaxTokensError extends Error {
  constructor(public partialContent: string) {
    super('Max tokens reached');
  }
}

// ============================================================
// Part 2b: Handler 实现
// ============================================================

const DEFAULT_MODEL = 'claude-opus-4-5';
const FALLBACK_MODEL = 'claude-haiku-4-5';
const DEFAULT_MAX_TOKENS = 8000;
const ESCALATED_MAX_TOKENS = 64000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 200; // 教学演示用较短延迟

function extractText(response: LLMResponse): string {
  return response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text).join('');
}

function getToolUseBlocks(response: LLMResponse): ToolUseBlock[] {
  return response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

// Mock LLM：模拟不同类型的错误
let callCount = 0;
function mockLLM(messages: Message[], model: string): LLMResponse {
  callCount++;
  const round = messages.filter(m => m.role === 'assistant').length;
  console.log(`  [mockLLM] call #${callCount}, round=${round}`);

  // 前两次调用模拟 429 错误
  if (callCount <= 2 && round === 0) {
    throw new RateLimitError(100);
  }
  // 第三次调用模拟 max_tokens
  if (callCount === 3 && round === 0) {
    throw new MaxTokensError('部分输出...');
  }

  if (round === 0) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: `（使用模型: ${model}）执行命令。` },
        { type: 'tool_use', id: 'tool_001', name: 'bash', input: { command: 'ls' } },
      ],
    };
  }
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '任务完成，经过错误恢复后成功执行。' }],
  };
}

const s11Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages, model = DEFAULT_MODEL, maxTokens = DEFAULT_MAX_TOKENS } = effect.input;
    const round = messages.filter(m => m.role === 'assistant').length;
    console.log(`\n[Chat] → 轮次 ${round + 1} (model: ${model}, maxTokens: ${maxTokens})`);
    await new Promise(r => setTimeout(r, 30));
    return mockLLM(messages, model);
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    console.log(`[BashExec] → ${effect.input.command}`);
    return `(执行: ${effect.input.command})`;
  },

  RetryWithBackoff: async (effect: RetryWithBackoffEffect): Promise<void> => {
    const { attempt, errorType, retryAfterMs } = effect.input;
    const delay = retryAfterMs ?? Math.min(BASE_DELAY_MS * Math.pow(2, attempt), 5000);
    const jitter = Math.random() * delay * 0.25;
    const total = Math.round(delay + jitter);
    console.log(`[Retry] ${errorType} 错误，第 ${attempt + 1} 次重试，等待 ${total}ms...`);
    await new Promise(r => setTimeout(r, total));
  },

  SwitchModel: async (effect: SwitchModelEffect): Promise<string> => {
    console.log(`[SwitchModel] ${effect.input.fromModel} → ${FALLBACK_MODEL} (原因: ${effect.input.reason})`);
    return FALLBACK_MODEL;
  },
};

// ============================================================
// Part 3: Agent Generator（内含三条恢复路径）
// ============================================================

function* agentLoop(perform: PerformFn<S11Effect>) {
  const messages: Message[] = [
    { role: 'user', content: '执行一个命令，即使遇到错误也要坚持完成。' },
  ];

  let currentModel = DEFAULT_MODEL;
  let maxTokens = DEFAULT_MAX_TOKENS;
  let hasEscalated = false;
  let recoveryCount = 0;
  let consecutive529 = 0;
  const MAX_RECOVERY_RETRIES = 3;

  outer: while (true) {
    let response: LLMResponse | undefined;

    // 带重试的 LLM 调用
    for (let attempt = 0; attempt < MAX_RETRIES + 10; attempt++) {
      try {
        response = yield* perform({ type: 'Chat', input: { messages, model: currentModel, maxTokens } });
        consecutive529 = 0;
        break; // 成功，退出重试循环

      } catch (error: unknown) {
        if (error instanceof RateLimitError) {
          // Path 3a: 429 → 指数退避
          yield* perform({
            type: 'RetryWithBackoff',
            input: { attempt, errorType: '429', retryAfterMs: error.retryAfterMs },
          });

        } else if (error instanceof OverloadedError) {
          // Path 3b: 529 → 退避 + 可选模型切换
          consecutive529++;
          if (consecutive529 >= 3) {
            currentModel = yield* perform({
              type: 'SwitchModel',
              input: { reason: '连续 529 错误', fromModel: currentModel },
            });
            consecutive529 = 0;
          }
          yield* perform({ type: 'RetryWithBackoff', input: { attempt, errorType: '529' } });

        } else if (error instanceof MaxTokensError) {
          // Path 1: max_tokens 超限
          if (!hasEscalated) {
            console.log(`[Recovery Path 1] max_tokens 升级: ${maxTokens} → ${ESCALATED_MAX_TOKENS}`);
            maxTokens = ESCALATED_MAX_TOKENS;
            hasEscalated = true;
            // 继续循环（用新 maxTokens 重试）
          } else if (recoveryCount < MAX_RECOVERY_RETRIES) {
            console.log(`[Recovery Path 1] 续接输出 (第 ${recoveryCount + 1} 次)`);
            messages.push({ role: 'assistant', content: error.partialContent });
            messages.push({ role: 'user', content: 'Output token limit hit. Resume directly.' });
            recoveryCount++;
          } else {
            return '错误：达到最大恢复次数';
          }

        } else if (error instanceof PromptTooLongError) {
          // Path 2: prompt 过长 → 应急压缩（保留最后5条）
          console.log(`[Recovery Path 2] prompt 过长，应急压缩`);
          const recent = messages.slice(-5);
          messages.length = 0;
          messages.push(
            { role: 'user', content: '[已压缩] 继续之前的任务。' },
            ...recent
          );

        } else {
          throw error;
        }
      }
    }

    if (response === undefined) {
      return '错误：超出最大重试次数';
    }

    messages.push({ role: 'assistant', content: extractText(response) });

    if (response.stop_reason !== 'tool_use') {
      return extractText(response);
    }

    const toolResults: Array<{ tool_use_id: string; content: string }> = [];
    for (const block of getToolUseBlocks(response)) {
      const output = yield* perform({ type: 'BashExec', input: { command: block.input['command'] as string } });
      toolResults.push({ tool_use_id: block.id, content: output });
    }
    messages.push({ role: 'user', content: JSON.stringify(toolResults) });
  }
}

// ============================================================
// Part 4: 启动入口
// ============================================================

console.log('[S11] Error Recovery 启动\n');
console.log('（模拟：前2次调用触发 429，第3次触发 max_tokens 升级）\n');

const result = await runAgent<S11Effect, string>(agentLoop, s11Handlers);

console.log('\n[S11] 完成:', result);
