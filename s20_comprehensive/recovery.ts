/**
 * s20 的错误恢复适配层。
 *
 * 状态机、退避公式、fallback 判定都在 runtime/recovery.ts（s11/s20 共用）；
 * 这里只把 s20 的模型与演示用的上限接进去。
 */

import {
  RecoveryState as SharedRecoveryState,
  readRetryAfterMs,
  retryDelayMs,
} from '../runtime/recovery.ts';
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  ESCALATED_MAX_TOKENS,
  MAX_CONSECUTIVE_529,
} from './config.ts';

export { readRetryAfterMs, retryDelayMs };

export class RecoveryState extends SharedRecoveryState {
  constructor() {
    super({
      primaryModel: DEFAULT_MODEL,
      maxTokens: DEFAULT_MAX_TOKENS,
      escalatedMaxTokens: ESCALATED_MAX_TOKENS,
      maxConsecutive529: MAX_CONSECUTIVE_529,
    });
  }
}
