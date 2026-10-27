/**
 * s20 协议状态机 —— request_id + 响应类型的双校验。
 *
 * 状态放在 store 实例里，agent.ts 只负责注册请求、落定响应和打印汇总；
 * 这样协议规则可以单独测试，不会被困在 2500 行的章节循环里。
 */

export type ProtocolType = 'plan_approval' | 'shutdown';
export type ProtocolStatus = 'pending' | 'approved' | 'rejected';

export interface ProtocolState {
  requestId: string;
  type: ProtocolType;
  sender: string;
  target: string;
  status: ProtocolStatus;
  payload: string;
  createdAt: number;
}

export type SettleResult = 'settled' | 'unknown' | 'type_mismatch' | 'duplicate';

export type InboxMessageKind =
  | 'shutdown_request'
  | 'shutdown_response'
  | 'plan_approval_request'
  | 'plan_approval_response'
  | 'other';

/** request type → 它唯一合法的 response type。 */
export function expectedResponseType(type: ProtocolType): string {
  return type === 'shutdown' ? 'shutdown_response' : 'plan_approval_response';
}

/** 只按消息类型分类；request_id 是否匹配由调用方或 store 校验。 */
export function classifyInboxMessage(msg: {
  type: string;
  metadata: Record<string, unknown>;
}): InboxMessageKind {
  switch (msg.type) {
    case 'shutdown_request':
      return 'shutdown_request';
    case 'shutdown_response':
      return 'shutdown_response';
    case 'plan_approval_request':
      return 'plan_approval_request';
    case 'plan_approval_response':
      return 'plan_approval_response';
    default:
      return 'other';
  }
}

export interface ProtocolInboxDeps {
  leadId: string;
  send: (
    from: string,
    to: string,
    body: string,
    type: string,
    metadata: Record<string, unknown>,
  ) => Promise<string>;
  settle: (responseType: string, requestId: string, approve: boolean) => SettleResult;
}

/**
 * 统一消费信箱：协议消息在这里被处理，不进入模型可见的普通消息流。
 *
 * shutdown_request 一律先回复 shutdown_response；plan_approval_response 先落定状态。
 * 收发依赖由调用方注入，测试可以用假的 send/settle 验证，不必启动整个章节。
 */
export async function handleProtocolInbox<M extends { type: string; metadata: Record<string, unknown> }>(
  agentId: string,
  msgs: M[],
  deps: ProtocolInboxDeps,
): Promise<{ messages: M[]; shutdown: boolean }> {
  const messages: M[] = [];
  let shutdown = false;

  for (const msg of msgs) {
    const kind = classifyInboxMessage(msg);
    const reqId = String(msg.metadata['request_id'] ?? '');

    if (kind === 'shutdown_request') {
      await deps.send(agentId, deps.leadId, 'Shutting down gracefully.', 'shutdown_response', {
        request_id: reqId,
        approve: true,
        responder: agentId,
      });
      console.log(`  \x1b[35m[protocol] ${agentId} approved shutdown (${reqId})\x1b[0m`);
      shutdown = true;
      continue;
    }

    if (kind === 'plan_approval_response' || kind === 'shutdown_response') {
      // 状态机负责日志；未知/错类型/重复响应都不再交给模型。
      // 迟到的 shutdown_response 也在这里落定，避免它被当成普通消息展示。
      deps.settle(msg.type, reqId, Boolean(msg.metadata['approve']));
      continue;
    }

    messages.push(msg);
  }

  return { messages, shutdown };
}

export function createProtocolStore() {
  const requests = new Map<string, ProtocolState>();

  function register(state: ProtocolState): void {
    requests.set(state.requestId, state);
  }

  function get(requestId: string): ProtocolState | undefined {
    return requests.get(requestId);
  }

  /**
   * 按 request_id + 类型双校验关联响应；未知/错类型/重复都会被拒绝并记录。
   * 返回结果给调用方决定后续动作，状态更新只在这里发生。
   */
  function settle(responseType: string, requestId: string, approve: boolean): SettleResult {
    const state = requests.get(requestId);
    if (!state) {
      console.log(`  \x1b[31m[protocol] unknown request_id: ${requestId}\x1b[0m`);
      return 'unknown';
    }

    const expected = expectedResponseType(state.type);
    if (responseType !== expected) {
      console.log(`  \x1b[31m[protocol] type mismatch: expected ${expected}, got ${responseType}\x1b[0m`);
      return 'type_mismatch';
    }

    if (state.status !== 'pending') {
      console.log(`  \x1b[33m[protocol] ${requestId} already ${state.status}, ignoring duplicate\x1b[0m`);
      return 'duplicate';
    }

    state.status = approve ? 'approved' : 'rejected';
    const icon = approve ? '✓' : '✗';
    const color = approve ? '32' : '31';
    console.log(`  \x1b[${color}m[protocol] ${state.type} ${icon} (${requestId})\x1b[0m`);
    return 'settled';
  }

  /** 仅当请求仍处于 pending 时落定；用于超时/宿主收尾，避免覆盖已经到达的响应。 */
  function settleIfPending(responseType: string, requestId: string, approve: boolean): void {
    const state = requests.get(requestId);
    if (state?.status === 'pending') settle(responseType, requestId, approve);
  }

  function all(): ProtocolState[] {
    return [...requests.values()];
  }

  return { register, get, settle, settleIfPending, all };
}
