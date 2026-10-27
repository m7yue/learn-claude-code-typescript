/**
 * 模型调用的错误恢复策略 —— 全仓单一实现（s11 / s20 共用）。
 *
 * 三条路径：
 *   429 限流       → 指数退避
 *   529 过载       → 退避；连续超限且有备用模型时切换
 *   max_tokens     → 先升级输出上限，再续接；达到上限后失败
 *   prompt_too_long→ 由调用方做一次应急压缩
 *
 * 这里只放状态与决策，不 yield Effect；RetryWithBackoff / SwitchModel / Compact
 * 仍由各章 generator 自己执行，因此共享模块不依赖 runAgent。
 */

import { resolveMode } from './env.ts';

export const DEFAULT_MAX_TOKENS = 8000;
export const ESCALATED_MAX_TOKENS = 64_000;
export const MAX_RECOVERY_RETRIES = 3;
/** 同一次模型调用最多尝试几次（含首次）；429/529 的重试也受它限制。 */
export const MAX_RETRIES = 10;
export const MAX_CONSECUTIVE_529 = 3;
export const BASE_DELAY_MS = 500;
export const MAX_BACKOFF_MS = 32_000;
/** mock 模式下把退避时长压缩一个量级，让整轮演示 <3s。 */
export const MOCK_DELAY_SCALE = 0.01;
export const MOCK_FALLBACK_MODEL = 'claude-haiku-4-5';

/** 截断续接提示：贴回被截断的输出后发给模型，要求直接接着写。 */
export const CONTINUATION_PROMPT =
  'Output token limit hit. Resume directly — no apology, no recap. Pick up mid-thought.';

/** 应急压缩后插入的合成 user 消息：告诉模型上文已被裁掉，从当前进度继续。 */
export const REACTIVE_COMPACT_PROMPT =
  '[Reactive compact] Earlier conversation trimmed. Continue from where you left off.';

/**
 * 备用模型：严格读取 FALLBACK_MODEL_ID；mock 模式未配置时给一个演示默认值，
 * 否则「连续 529 → SwitchModel」在离线演示中不可达。real 模式不注入默认值。
 */
export function configuredFallbackModel(): string {
  const fromEnv = (process.env.FALLBACK_MODEL_ID || '').trim();
  if (fromEnv) return fromEnv;
  return resolveMode() === 'mock' ? MOCK_FALLBACK_MODEL : '';
}

/** 指数退避 + 随机延时；Retry-After（服务端指定的等待时间）优先。 */
export function retryDelayMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs) return retryAfterMs;
  const baseMs = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
  const jitter = Math.random() * baseMs * 0.25;
  const full = baseMs + jitter;
  return Math.round(resolveMode() === 'mock' ? full * MOCK_DELAY_SCALE : full);
}

export function readRetryAfterMs(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof value === 'number') return value;
  }
  return undefined;
}

export interface RecoveryOptions {
  primaryModel: string;
  maxTokens?: number;
  escalatedMaxTokens?: number;
  maxRecoveryRetries?: number;
  maxConsecutive529?: number;
}

export type OverloadDecision =
  | { action: 'retry' }
  | { action: 'switch-model' }
  | { action: 'retry-no-fallback' };

export type MaxTokensDecision =
  | { action: 'escalate' }
  | { action: 'continue' }
  | { action: 'fail' };

/** 跨轮次保存的恢复状态。 */
export class RecoveryState {
  readonly primaryModel: string;
  readonly escalatedMaxTokens: number;
  readonly maxRecoveryRetries: number;
  readonly maxConsecutive529: number;

  /** 是否已升级过 token 上限（每次运行只升级一次）。 */
  hasEscalated = false;
  /** max_tokens 已续接的次数。 */
  recoveryCount = 0;
  /** 连续 529 过载的次数；请求成功一次就清零。 */
  consecutive529 = 0;
  /** 是否已应急压缩过。 */
  hasAttemptedReactiveCompact = false;
  /** 当前输出上限。 */
  maxTokens: number;
  /** 当前使用的模型；连续 529 触发 SwitchModel 后换成备用模型。 */
  currentModel: string;

  constructor(options: RecoveryOptions) {
    this.primaryModel = options.primaryModel;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.escalatedMaxTokens = options.escalatedMaxTokens ?? ESCALATED_MAX_TOKENS;
    this.maxRecoveryRetries = options.maxRecoveryRetries ?? MAX_RECOVERY_RETRIES;
    this.maxConsecutive529 = options.maxConsecutive529 ?? MAX_CONSECUTIVE_529;
    this.currentModel = options.primaryModel;
  }

  onSuccess(): void {
    this.consecutive529 = 0;
  }

  /** 529：返回下一步动作；调用方负责 yield SwitchModel / RetryWithBackoff。 */
  onOverloaded(hasFallback: boolean): OverloadDecision {
    this.consecutive529 += 1;
    if (this.consecutive529 >= this.maxConsecutive529) {
      this.consecutive529 = 0;
      return hasFallback ? { action: 'switch-model' } : { action: 'retry-no-fallback' };
    }
    return { action: 'retry' };
  }

  /** max_tokens：升级一次，之后最多续接 maxRecoveryRetries 次。 */
  onMaxTokens(): MaxTokensDecision {
    if (!this.hasEscalated) {
      this.hasEscalated = true;
      this.maxTokens = this.escalatedMaxTokens;
      return { action: 'escalate' };
    }
    if (this.recoveryCount < this.maxRecoveryRetries) {
      this.recoveryCount += 1;
      return { action: 'continue' };
    }
    return { action: 'fail' };
  }
}
