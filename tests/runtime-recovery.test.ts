import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_RECOVERY_RETRIES,
  RecoveryState,
  readRetryAfterMs,
  retryDelayMs,
} from '../runtime/recovery.ts';

function makeState() {
  return new RecoveryState({
    primaryModel: 'primary',
    maxTokens: 100,
    escalatedMaxTokens: 200,
    maxConsecutive529: 3,
    maxRecoveryRetries: 2,
  });
}

test('max_tokens 先升级一次，再续接固定次数，最后失败', () => {
  const state = makeState();
  assert.deepEqual(state.onMaxTokens(), { action: 'escalate' });
  assert.equal(state.maxTokens, 200);
  assert.deepEqual(state.onMaxTokens(), { action: 'continue' });
  assert.deepEqual(state.onMaxTokens(), { action: 'continue' });
  assert.deepEqual(state.onMaxTokens(), { action: 'fail' });
});

test('529 连续超限：有备用模型切换，没有则继续重试', () => {
  const withFallback = makeState();
  assert.deepEqual(withFallback.onOverloaded(true), { action: 'retry' });
  assert.deepEqual(withFallback.onOverloaded(true), { action: 'retry' });
  assert.deepEqual(withFallback.onOverloaded(true), { action: 'switch-model' });

  const noFallback = makeState();
  noFallback.onOverloaded(false);
  noFallback.onOverloaded(false);
  assert.deepEqual(noFallback.onOverloaded(false), { action: 'retry-no-fallback' });
});

test('成功一次会清零连续 529 计数', () => {
  const state = makeState();
  state.onOverloaded(true);
  state.onOverloaded(true);
  state.onSuccess();
  assert.deepEqual(state.onOverloaded(true), { action: 'retry' });
});

test('retryAfterMs 优先，退避结果为正数', () => {
  assert.equal(readRetryAfterMs({ retryAfterMs: 123 }), 123);
  assert.equal(readRetryAfterMs(new Error('no field')), undefined);
  assert.equal(retryDelayMs(0, 250), 250);
  assert.ok(retryDelayMs(0) > 0);
  assert.ok(MAX_RECOVERY_RETRIES >= 1);
});
