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
/** mock 模式的演示备用模型：让「连续 529 → SwitchModel」这条路径离线也能走到。 */
const MOCK_FALLBACK_MODEL = 'claude-haiku-4-5';

/** 首次请求的输出上限。 */
const DEFAULT_MAX_TOKENS = 8000;
/** 遇到 max_tokens 截断后升级到的输出上限。 */
const ESCALATED_MAX_TOKENS = 64000;
/** max_tokens 截断后最多续接几次；用满即结束本轮。 */
const MAX_RECOVERY_RETRIES = 3;
/** 同一次模型调用最多尝试几次（含首次）；429/529 的重试也受它限制。 */
const MAX_RETRIES = 10;
/** 连续这么多次 529 过载就切换备用模型；未配置 FALLBACK_MODEL_ID 时只打印日志、继续重试。 */
const MAX_CONSECUTIVE_529 = 3;
/** 退避起点时长。 */
const BASE_DELAY_MS = 500;
/** 退避时长上限：按 2 的幂增长到它就不再涨。 */
const MAX_BACKOFF_MS = 32000;

/** 截断续接提示：贴回被截断的输出后发给模型，要求直接接着写、不要道歉或复述。 */
const CONTINUATION_PROMPT =
  'Output token limit hit. Resume directly — no apology, no recap. Pick up mid-thought.';

/** 应急压缩后插入的合成 user 消息：告诉模型上文已被裁掉，从当前进度继续。 */
const REACTIVE_COMPACT_PROMPT =
  '[Reactive compact] Earlier conversation trimmed. Continue from where you left off.';

// 主模型：real 模式取 MODEL_ID；mock 无 .env 时退回默认值，保证离线可跑。
const PRIMARY_MODEL = (process.env.MODEL_ID || '').trim() || DEFAULT_MODEL;

// 备用模型：严格读取 FALLBACK_MODEL_ID。mock 模式若未配置，给一个演示默认值，
// 否则「连续 529 → SwitchModel」这条路径在离线演示中不可达。
// real 模式不注入默认值：未配置时继续重试并打印日志。
function configuredFallbackModel(): string {
  const fromEnv = (process.env.FALLBACK_MODEL_ID || '').trim();
  if (fromEnv) return fromEnv;
  return resolveMode() === 'mock' ? MOCK_FALLBACK_MODEL : '';
}
const FALLBACK_MODEL = configuredFallbackModel();

// mock 模式下把退避时长压缩一个量级，让整轮演示 <3s；真实公式与上限不变。
const MOCK_DELAY_SCALE = 0.01;

/** 跨轮次保存的恢复状态：三条恢复路径各自的进度都存在这里。 */
class RecoveryState {
  /** 是否已升级过 token 上限（每次运行只升级一次，之后不再复位）。 */
  hasEscalated = false;
  /** max_tokens 已续接的次数，与 MAX_RECOVERY_RETRIES 比较。 */
  recoveryCount = 0;
  /** 连续 529 过载的次数；请求成功一次就清零。 */
  consecutive529 = 0;
  /** 是否已应急压缩过（Path 2 只压缩一次）。 */
  hasAttemptedReactiveCompact = false;
  /** 当前使用的模型；连续 529 触发 SwitchModel 后换成备用模型。 */
  currentModel = PRIMARY_MODEL;
}

/** 指数退避 + 随机延时；Retry-After（服务端指定的等待时间）优先。 */
function retryDelayMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs) return retryAfterMs;
  const baseMs = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
  const jitter = Math.random() * baseMs * 0.25;
  const full = baseMs + jitter;
  return Math.round(resolveMode() === 'mock' ? full * MOCK_DELAY_SCALE : full);
}

/** 应急压缩：教学版保留最近 5 条消息，前面插入一条合成 user 消息。 */
function reactiveCompact(messages: Message[]): Message[] {
  console.log('  [reactive compact] 保留最近 5 条消息');
  const tail = messages.slice(-5);
  return [{ role: 'user', content: REACTIVE_COMPACT_PROMPT }, ...tail];
}

/** 提取错误携带的 retryAfterMs（若 provider 提供）。 */
function readRetryAfterMs(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof value === 'number') return value;
  }
  return undefined;
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

  const state = new RecoveryState();
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
          state.consecutive529 = 0; // 成功即重置
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
            state.consecutive529 += 1;
            if (state.consecutive529 >= MAX_CONSECUTIVE_529) {
              if (FALLBACK_MODEL) {
                state.currentModel = yield* perform({
                  type: 'SwitchModel',
                  input: { reason: `连续 ${MAX_CONSECUTIVE_529} 次 529 过载`, fromModel: state.currentModel },
                });
                state.consecutive529 = 0;
              } else {
                state.consecutive529 = 0;
                console.log(`  [529 x${MAX_CONSECUTIVE_529}] 未配置 FALLBACK_MODEL_ID，继续重试`);
              }
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
      // 首次：只升级 token 上限，不追加被截断的输出，重试同一请求
      if (!state.hasEscalated) {
        maxTokens = ESCALATED_MAX_TOKENS;
        state.hasEscalated = true;
        console.log(`  [max_tokens] 升级 ${DEFAULT_MAX_TOKENS} -> ${ESCALATED_MAX_TOKENS}`);
        continue;
      }
      // 升级后仍被截断：保存截断输出 + 续接提示（最多 MAX_RECOVERY_RETRIES 次）
      messages.push({ role: 'assistant', content: response.content });
      if (state.recoveryCount < MAX_RECOVERY_RETRIES) {
        messages.push({ role: 'user', content: CONTINUATION_PROMPT });
        state.recoveryCount += 1;
        console.log(`  [max_tokens] 续接 ${state.recoveryCount}/${MAX_RECOVERY_RETRIES}`);
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
