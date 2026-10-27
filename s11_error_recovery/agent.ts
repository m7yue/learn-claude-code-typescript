/**
 * s11: Error Recovery — 错误是效应的另一种输出
 *
 * 本章新增 2 个 Effect：
 *   RetryWithBackoff — 指数退避重试（429/529 错误）
 *   SwitchModel      — 切换到备用模型
 *
 * 三条恢复路径（由 RecoveryState 跨轮次记录恢复进度）：
 *   Path 1: stop_reason == "max_tokens" → 升级 token 限制 → 续接输出
 *   Path 2: prompt_too_long（字符串分类） → 应急压缩 → 重试一次
 *   Path 3: 429/529 过载 → 指数退避 → 连续 529 切换备用模型
 *
 * 关键点（与真实 SDK 保持一致）：
 *   - 错误分类走 runtime/errors.ts 的 classifyError()（按 name/message/status 字符串匹配），
 *     而不是 instanceof —— 真实 Anthropic SDK 抛出的类型名与教学自定义类并不一致。
 *   - max_tokens 是 response.stop_reason，不是异常，必须在响应成功后判断。
 *   - 每次 Chat 调用都把当前 model / maxTokens 传给 callChat，
 *     这样 real 模式才真的会用上升级后的 maxTokens 与切换后的备用模型。
 */

import { runAgent } from '../runtime/core.ts';
import type { Effect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolResultBlock } from '../runtime/types.ts';
import { extractText, getToolUseBlocks } from '../runtime/response.ts';
import { callChat } from '../runtime/model.ts';
import { schemasFor } from '../runtime/tool-schemas.ts';
import { buildSystemPrompt } from '../runtime/system-prompt.ts';
import { classifyError } from '../runtime/errors.ts';
import { loadEnvOnce, resolveMode } from '../runtime/env.ts';
import {
  CONTINUATION_PROMPT,
  DEFAULT_MAX_TOKENS,
  MAX_RETRIES,
  REACTIVE_COMPACT_PROMPT,
  RecoveryState,
  configuredFallbackModel,
  readRetryAfterMs,
  retryDelayMs,
} from '../runtime/recovery.ts';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

// 扩展 ChatEffect，携带本次请求的模型与 token 上限（透传给 callChat）
interface ChatEffect extends Effect<'Chat', { messages: Message[]; model?: string; maxTokens?: number }, LLMResponse> {}

// 执行 bash 命令（本章是模拟的：handler 只回显命令文本）
interface BashExecEffect extends Effect<'BashExec', { command: string }, string> {}

// s11 新增：带退避的重试（等待时长由 handler 决定）
interface RetryWithBackoffEffect extends Effect<'RetryWithBackoff', { attempt: number; errorType: '429' | '529'; retryAfterMs?: number }, void> {}

// s11 新增：模型切换（返回切换后的模型名）
interface SwitchModelEffect extends Effect<'SwitchModel', { reason: string; fromModel: string }, string> {}

type S11Effect = ChatEffect | BashExecEffect | RetryWithBackoffEffect | SwitchModelEffect;

// ============================================================
// Part 2: 常量 / 配置 / 恢复状态
// ============================================================

loadEnvOnce();

/** MODEL_ID 缺失时（离线 mock）使用的模型名。 */
const DEFAULT_MODEL = 'claude-opus-4-5';

// 主模型：real 模式取 MODEL_ID；mock 无 .env 时退回默认值，保证离线可跑。
const PRIMARY_MODEL = (process.env.MODEL_ID || '').trim() || DEFAULT_MODEL;

// 备用模型：严格读取 FALLBACK_MODEL_ID；mock 未配置时给一个演示默认值。
const FALLBACK_MODEL = configuredFallbackModel();

/** 应急压缩：教学版保留最近 5 条消息，前面插入一条合成 user 消息。 */
function reactiveCompact(messages: Message[]): Message[] {
  console.log('  [reactive compact] 保留最近 5 条消息');
  const tail = messages.slice(-5);
  return [{ role: 'user', content: REACTIVE_COMPACT_PROMPT }, ...tail];
}

function errorName(error: unknown): string {
  if (error && typeof error === 'object') {
    const ctor = (error as { constructor?: { name?: string } }).constructor;
    if (ctor?.name) return ctor.name;
  }
  return typeof error;
}

function errorText(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}

// ============================================================
// Part 2b: Mock LLM（只替换「模型调用」这一步）
//
// 错误分类 / 退避 / 模型切换 / max_tokens 处理全部走真实代码路径：
// mock 只负责「按调用序号」抛出真实形状的错误或返回真实形状的响应。
// ============================================================

/** mock 的调用序号：第几次调用决定抛什么错、返回什么响应。 */
let callCount = 0;

function mockLLM(_messages: Message[]): LLMResponse {
  callCount += 1;
  console.log(`  [mockLLM] call #${callCount}`);

  switch (callCount) {
    case 1:
      // Path 3a: 429 限流（带 status，classifyError 命中 rate_limit）→ 指数退避
      throw Object.assign(new Error('429 rate limit exceeded'), { status: 429 });

    case 2:
    case 3:
    case 4:
      // Path 3b: 连续 3 次 529 过载 → 第 3 次触发 SwitchModel → 退避
      throw Object.assign(new Error('529 overloaded_error: service overloaded'), { status: 529 });

    case 5:
      // Path 1: max_tokens 是 stop_reason，不是异常 → 升级 maxTokens 后重试同一请求
      return {
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: '（被 max_tokens 截断的部分输出...）' }],
      };

    case 6:
      // Path 2: 普通 Error，消息含 "prompt is too long" —— 证明按字符串分类
      throw new Error('prompt is too long: 250000 tokens > 200000 maximum');

    case 7:
      // 恢复正常：请求 bash 工具（stop_reason == tool_use）
      return {
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: '（错误恢复后）执行 bash 命令。' },
          { type: 'tool_use', id: 'tool_001', name: 'bash', input: { command: 'echo recovered' } },
        ],
      };

    default:
      // 最终完成（stop_reason == end_turn）
      return {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '任务完成：经过 429/529/max_tokens/prompt_too_long 恢复后成功执行。' }],
      };
  }
}

// ============================================================
// Part 2c: Handler 实现（所有副作用在此）
// ============================================================

const SYSTEM_PROMPT = buildSystemPrompt(
  '使用 bash 工具解决任务。遇到限流或过载错误时，按指数退避重试，必要时切换到备用模型；不要因为暂时性错误而放弃任务。' +
    '本教学演示中 bash 是模拟的：只回显命令文本、不会真正执行，请不要依赖它的输出。',
);

const s11Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages, model = PRIMARY_MODEL, maxTokens = DEFAULT_MAX_TOKENS } = effect.input;
    const round = messages.filter((m) => m.role === 'assistant').length;
    console.log(`\n[Chat] → 轮次 ${round + 1} (model: ${model}, maxTokens: ${maxTokens})`);

    const response = await callChat((m) => mockLLM(m), messages, {
      tools: schemasFor('bash'),
      system: SYSTEM_PROMPT,
      model,
      maxTokens,
    });
    console.log(`[Chat] ← stop_reason: ${response.stop_reason} (model: ${model}, maxTokens: ${maxTokens})`);
    return response;
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    console.log(`[BashExec] → ${effect.input.command}`);
    return `(执行: ${effect.input.command})`;
  },

  RetryWithBackoff: async (effect: RetryWithBackoffEffect): Promise<void> => {
    const { attempt, errorType, retryAfterMs } = effect.input;
    const delayMs = retryDelayMs(attempt, retryAfterMs);
    console.log(`  [Retry] ${errorType} 错误，第 ${attempt + 1}/${MAX_RETRIES} 次重试，等待 ${delayMs}ms...`);
    await new Promise((r) => setTimeout(r, delayMs));
  },

  SwitchModel: async (effect: SwitchModelEffect): Promise<string> => {
    const newModel = FALLBACK_MODEL || effect.input.fromModel;
    console.log(`  [SwitchModel] ${effect.input.fromModel} → ${newModel} (原因: ${effect.input.reason})`);
    return newModel;
  },
};

// ============================================================
// Part 3: Agent Generator（内含三条恢复路径）
// ============================================================

function* agentLoop(perform: PerformFn<S11Effect>) {
  const messages: Message[] = [
    { role: 'user', content: '执行一个命令，即使遇到错误也要坚持完成。' },
  ];

  const state = new RecoveryState({ primaryModel: PRIMARY_MODEL });
  // 本次请求发出的输出上限：被截断时升级，之后的请求都带着升级后的值。
  let maxTokens = DEFAULT_MAX_TOKENS;

  while (true) {
    let response: LLMResponse | undefined;

    // ── LLM 调用：with_retry 处理 429/529，外层处理其余错误 ──
    try {
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          // 每次都透传当前 model / maxTokens（real 模式据此升级/切换）
          response = yield* perform({
            type: 'Chat',
            input: { messages, model: state.currentModel, maxTokens },
          });
          state.onSuccess(); // 成功即重置
          break;
        } catch (error: unknown) {
          const kind = classifyError(error);

          // Path 3a: 429 限流 → 指数退避
          if (kind === 'rate_limit') {
            yield* perform({
              type: 'RetryWithBackoff',
              input: { attempt, errorType: '429', retryAfterMs: readRetryAfterMs(error) },
            });
            continue;
          }

          // Path 3b: 529 过载 → 指数退避 + 连续超限切换备用模型
          if (kind === 'overloaded') {
            const decision = state.onOverloaded(Boolean(FALLBACK_MODEL));
            if (decision.action === 'switch-model') {
              state.currentModel = yield* perform({
                type: 'SwitchModel',
                input: {
                  reason: `连续 ${state.maxConsecutive529} 次 529 过载`,
                  fromModel: state.currentModel,
                },
              });
            } else if (decision.action === 'retry-no-fallback') {
              console.log(`  [529 x${state.maxConsecutive529}] 未配置 FALLBACK_MODEL_ID，继续重试`);
            }
            yield* perform({
              type: 'RetryWithBackoff',
              input: { attempt, errorType: '529', retryAfterMs: readRetryAfterMs(error) },
            });
            continue;
          }

          // 非临时错误 → 抛给外层恢复逻辑（prompt_too_long / unrecoverable）
          throw error;
        }
      }

      // 重试耗尽：抛出错误，交给外层 catch 处理。
      if (response === undefined) {
        throw new Error(`Max retries (${MAX_RETRIES}) exceeded`);
      }
    } catch (error: unknown) {
      // Path 2: prompt_too_long → 应急压缩（仅一次）
      if (classifyError(error) === 'prompt_too_long') {
        if (!state.hasAttemptedReactiveCompact) {
          const compacted = reactiveCompact(messages);
          messages.length = 0;
          messages.push(...compacted);
          state.hasAttemptedReactiveCompact = true;
          continue;
        }
        console.log('  [unrecoverable] 压缩后仍然过长');
        messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: '[Error] Context too large, cannot continue.' }],
        });
        return '[Error] Context too large, cannot continue.';
      }

      // 不可恢复：记录并退出
      const name = errorName(error);
      const text = errorText(error);
      console.log(`  [unrecoverable] ${name}: ${text.slice(0, 100)}`);
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: `[Error] ${name}: ${text.slice(0, 200)}` }],
      });
      return `[Error] ${name}: ${text.slice(0, 200)}`;
    }

    if (response === undefined) {
      // 理论不可达：重试耗尽会在 try 内抛出并进入上面的 catch
      return '[Error] no response after retries';
    }

    // ── Path 1: max_tokens → 升级或续接 ──
    if (response.stop_reason === 'max_tokens') {
      const decision = state.onMaxTokens();
      // 首次：只升级 token 上限，不追加被截断的输出，重试同一请求
      if (decision.action === 'escalate') {
        maxTokens = state.maxTokens;
        console.log(`  [max_tokens] 升级 ${DEFAULT_MAX_TOKENS} -> ${state.escalatedMaxTokens}`);
        continue;
      }
      // 升级后仍被截断：保存截断输出 + 续接提示（最多 maxRecoveryRetries 次）
      messages.push({ role: 'assistant', content: response.content });
      if (decision.action === 'continue') {
        messages.push({ role: 'user', content: CONTINUATION_PROMPT });
        console.log(`  [max_tokens] 续接 ${state.recoveryCount}/${state.maxRecoveryRetries}`);
        continue;
      }
      console.log('  [max_tokens] 达到恢复上限');
      return '[Error] max_tokens recovery limit reached';
    }

    // 正常完成：追加 assistant 响应
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      return extractText(response);
    }

    // ── 工具执行 ──
    const toolResults: ToolResultBlock[] = [];
    for (const block of getToolUseBlocks(response)) {
      try {
        const output = yield* perform({
          type: 'BashExec',
          input: { command: block.input['command'] as string },
        });
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
// Part 4: 启动入口
// ============================================================

console.log('[S11] Error Recovery 启动\n');

// real 模式由真实模型驱动，1..8 的脚本化调用序列不适用。
if (resolveMode() !== 'real') {
  console.log(
    '（mock 脚本：1=429 退避，2-4=连续 529 触发切换模型，5=max_tokens 升级，6=prompt_too_long 压缩，7=工具调用，8=完成）\n',
  );
}

const result = await runAgent<S11Effect, string>(agentLoop, s11Handlers);

console.log(`\n[S11] result: ${result}`);
console.log('[S11] 完成');
