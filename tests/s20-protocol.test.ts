import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyInboxMessage,
  createProtocolStore,
  expectedResponseType,
  handleProtocolInbox,
  type ProtocolState,
} from '../s20_comprehensive/protocol.ts';

function makeInboxHarness() {
  const sent: Array<{
    from: string;
    to: string;
    body: string;
    type: string;
    metadata: Record<string, unknown>;
  }> = [];
  const settled: Array<{ type: string; requestId: string; approve: boolean }> = [];

  return {
    sent,
    settled,
    deps: {
      leadId: 'lead',
      send: async (
        from: string,
        to: string,
        body: string,
        type: string,
        metadata: Record<string, unknown>,
      ) => {
        sent.push({ from, to, body, type, metadata });
        return 'msg_1';
      },
      settle: (type: string, requestId: string, approve: boolean) => {
        settled.push({ type, requestId, approve });
        return 'settled' as const;
      },
    },
  };
}

function planState(requestId = 'plan_1'): ProtocolState {
  return {
    requestId,
    type: 'plan_approval',
    sender: 'worker',
    target: 'lead',
    status: 'pending',
    payload: '1. a\n2. b\n3. c',
    createdAt: 1,
  };
}

test('expectedResponseType 把请求类型映射到唯一响应类型', () => {
  assert.equal(expectedResponseType('plan_approval'), 'plan_approval_response');
  assert.equal(expectedResponseType('shutdown'), 'shutdown_response');
});

test('register + settle 落定 pending 请求', () => {
  const store = createProtocolStore();
  store.register(planState());

  assert.equal(store.settle('plan_approval_response', 'plan_1', true), 'settled');
  assert.equal(store.get('plan_1')?.status, 'approved');
});

test('未知 id、类型不匹配、重复响应都被拒绝', () => {
  const store = createProtocolStore();
  store.register(planState());

  assert.equal(store.settle('plan_approval_response', 'missing', true), 'unknown');
  assert.equal(store.settle('shutdown_response', 'plan_1', true), 'type_mismatch');
  assert.equal(store.get('plan_1')?.status, 'pending');

  assert.equal(store.settle('plan_approval_response', 'plan_1', false), 'settled');
  assert.equal(store.settle('plan_approval_response', 'plan_1', true), 'duplicate');
  assert.equal(store.get('plan_1')?.status, 'rejected');
});

test('settleIfPending 不覆盖已经落定的状态', () => {
  const store = createProtocolStore();
  store.register(planState());

  store.settleIfPending('plan_approval_response', 'plan_1', true);
  assert.equal(store.get('plan_1')?.status, 'approved');

  store.settleIfPending('plan_approval_response', 'plan_1', false);
  assert.equal(store.get('plan_1')?.status, 'approved');
});

test('超时兜底把仍 pending 的请求落为 rejected', () => {
  const store = createProtocolStore();
  store.register(planState());

  store.settleIfPending('plan_approval_response', 'plan_1', false);
  assert.equal(store.get('plan_1')?.status, 'rejected');
});

test('all 返回全部请求，供结束汇总使用', () => {
  const store = createProtocolStore();
  store.register(planState('plan_1'));
  store.register({ ...planState('shutdown_1'), type: 'shutdown', sender: 'lead', target: 'worker' });

  assert.deepEqual(store.all().map((s) => s.requestId), ['plan_1', 'shutdown_1']);
});

test('classifyInboxMessage 区分协议消息与普通消息', () => {
  const metadata = { request_id: 'req_1' };
  assert.equal(classifyInboxMessage({ type: 'shutdown_request', metadata }), 'shutdown_request');
  assert.equal(classifyInboxMessage({ type: 'shutdown_response', metadata }), 'shutdown_response');
  assert.equal(classifyInboxMessage({ type: 'plan_approval_request', metadata }), 'plan_approval_request');
  assert.equal(classifyInboxMessage({ type: 'plan_approval_response', metadata }), 'plan_approval_response');
  assert.equal(classifyInboxMessage({ type: 'result', metadata }), 'other');
});

test('handleProtocolInbox 回复 shutdown_request 并标记 shutdown', async () => {
  const { sent, settled, deps } = makeInboxHarness();

  const result = await handleProtocolInbox(
    'worker',
    [{ type: 'shutdown_request', from: 'lead', metadata: { request_id: 's1' } }],
    deps,
  );

  assert.equal(result.shutdown, true);
  assert.deepEqual(result.messages, []);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'lead');
  assert.equal(sent[0].type, 'shutdown_response');
  assert.deepEqual(sent[0].metadata, {
    request_id: 's1',
    approve: true,
    responder: 'worker',
  });
  assert.equal(settled.length, 0);
});

test('handleProtocolInbox 落定 plan_approval_response，不交给模型', async () => {
  const { sent, settled, deps } = makeInboxHarness();

  const result = await handleProtocolInbox(
    'worker',
    [{ type: 'plan_approval_response', from: 'lead', metadata: { request_id: 'p1', approve: true } }],
    deps,
  );

  assert.equal(result.shutdown, false);
  assert.deepEqual(result.messages, []);
  assert.equal(sent.length, 0);
  assert.deepEqual(settled, [{ type: 'plan_approval_response', requestId: 'p1', approve: true }]);
});

test('handleProtocolInbox 落定迟到的 shutdown_response，不交给模型', async () => {
  const { settled, deps } = makeInboxHarness();
  const result = await handleProtocolInbox(
    'lead',
    [{ type: 'shutdown_response', from: 'worker', metadata: { request_id: 's1', approve: true } }],
    deps,
  );

  assert.equal(result.shutdown, false);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(settled, [{ type: 'shutdown_response', requestId: 's1', approve: true }]);
});

test('handleProtocolInbox 保留普通消息', async () => {
  const { sent, settled, deps } = makeInboxHarness();
  const ordinary = { type: 'message', from: 'lead', body: '继续', metadata: {} };

  const result = await handleProtocolInbox('worker', [ordinary], deps);

  assert.equal(result.shutdown, false);
  assert.deepEqual(result.messages, [ordinary]);
  assert.equal(sent.length, 0);
  assert.equal(settled.length, 0);
});

test('handleProtocolInbox 混合输入：普通消息保留，协议消息处理', async () => {
  const { sent, settled, deps } = makeInboxHarness();
  const ordinary = { type: 'message', from: 'lead', body: '继续', metadata: {} };

  const result = await handleProtocolInbox(
    'worker',
    [
      { type: 'plan_approval_response', from: 'lead', metadata: { request_id: 'p1', approve: false } },
      ordinary,
      { type: 'shutdown_request', from: 'lead', metadata: { request_id: 's1' } },
    ],
    deps,
  );

  assert.equal(result.shutdown, true);
  assert.deepEqual(result.messages, [ordinary]);
  assert.equal(settled.length, 1);
  assert.equal(sent.length, 1);
});
