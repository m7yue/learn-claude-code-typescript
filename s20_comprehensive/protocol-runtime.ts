/**
 * s20 的协议运行时 —— request id 生成、协议 store 实例、响应轮询。
 * 状态机本身在 protocol.ts，这里只把 mailbox / teammates / 超时配置接起来。
 */

import { LEAD_ID, POLL_MS, RESPONSE_TIMEOUT_MS } from './config.ts';
import { BUS, type AgentMessage } from './mailbox.ts';
import { createProtocolStore } from './protocol.ts';
import { activeTeammates } from './team.ts';

let reqSeq = 0;
export function newRequestId(prefix = 'req'): string {
  reqSeq += 1;
  return `${prefix}_${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}_${reqSeq}`;
}

export const protocol = createProtocolStore();
export const protocolInboxDeps = {
  leadId: LEAD_ID,
  send: (from: string, to: string, body: string, type: string, metadata: Record<string, unknown>) =>
    BUS.send(from, to, body, type, metadata),
  settle: protocol.settle,
};

export async function pollForResponse(
  expectedRequestId: string,
  expectedType: string,
  targetId: string,
  timeoutMs = RESPONSE_TIMEOUT_MS,
): Promise<AgentMessage | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = await BUS.readInbox(LEAD_ID);
    let matched: AgentMessage | null = null;
    const keep: AgentMessage[] = [];
    for (const msg of msgs) {
      const reqId = String(msg.metadata['request_id'] ?? '');
      const isResponse = reqId.length > 0 && msg.type.endsWith('_response');
      if (isResponse) {
        // 不看返回值：这里要的是副作用——落定协议状态，并记录未知/错类型/重复响应。
        protocol.settle(msg.type, reqId, Boolean(msg.metadata['approve']));
      }
      if (!matched && isResponse && reqId === expectedRequestId && msg.type === expectedType) matched = msg;
      else keep.push(msg);
    }
    if (keep.length > 0) await BUS.requeue(LEAD_ID, keep);
    if (matched) return matched;
    // 先读后判：响应可能刚写回、队友随即退出。
    if (!activeTeammates.has(targetId)) {
      console.log(`  \x1b[31m[protocol] teammate '${targetId}' is no longer running\x1b[0m`);
      return null;
    }
    await BUS.waitForMessage(LEAD_ID, POLL_MS);
  }
  console.log(`  \x1b[31m[protocol] timeout waiting for ${expectedType} (${expectedRequestId})\x1b[0m`);
  return null;
}
