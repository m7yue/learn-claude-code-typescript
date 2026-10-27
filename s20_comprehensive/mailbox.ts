/**
 * s20 的文件信箱 —— 每个 Agent 一个 `.mailboxes/s20/<agentId>.jsonl`。
 *
 * 保留在章内而不是抽到 runtime：信箱是 s15 的教学主体，s20 只是复用同一套实现。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { truncate } from '../runtime/text.ts';
import { LEAD_ID, S20_MAILBOX_DIR, WORKER_ID } from './config.ts';

/** 一条信箱消息的结构：from / to / body / type / timestamp / metadata。 */
export interface AgentMessage {
  from: string;
  to: string;
  body: string;
  type: string;
  timestamp: number;
  metadata: Record<string, unknown>;
}

// 队友名会拼进信箱文件名，先按白名单校验字符。
const VALID_AGENT_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function validateAgentId(agentId: string): void {
  if (agentId === '.' || agentId === '..' || !VALID_AGENT_ID.test(agentId)) {
    throw new Error(`非法队友名: '${agentId}'（只允许字母、数字、点、下划线、短横线，1-64 字符）`);
  }
}

function resetS20MailboxDir(): void {
  fs.rmSync(S20_MAILBOX_DIR, { recursive: true, force: true });
  fs.mkdirSync(S20_MAILBOX_DIR, { recursive: true });
}

/** 解析一行信箱 JSON；字段不全或损坏时告警并跳过，避免一条坏行打断整轮协议。 */
function parseInboxLine(line: string): AgentMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    console.warn(`[bus] 忽略损坏的信箱行: ${truncate(line, 80)}`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    console.warn(`[bus] 忽略非对象的信箱行: ${truncate(line, 80)}`);
    return null;
  }
  const raw = parsed as Record<string, unknown>;
  if (
    typeof raw['from'] !== 'string' ||
    typeof raw['to'] !== 'string' ||
    typeof raw['body'] !== 'string' ||
    typeof raw['type'] !== 'string'
  ) {
    console.warn(`[bus] 忽略字段不完整的信箱行: ${truncate(line, 80)}`);
    return null;
  }
  const metadata = raw['metadata'];
  return {
    from: raw['from'],
    to: raw['to'],
    body: raw['body'],
    type: raw['type'],
    timestamp: Number(raw['timestamp']) || 0,
    metadata:
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : {},
  };
}

/**
 * 文件消息总线：每个 Agent 一个 `.jsonl` 信箱，一行一条 JSON 消息。
 *   send()            —— append 一行（真实追加写，可带 metadata），并让等待者立即返回
 *   readInbox()       —— 读出全部行并清空（消费式读取）
 *   requeue()         —— 把暂不处理的消息原样写回（等待协议响应时不丢其它消息）
 *   waitForMessage()  —— 等待新消息或超时
 *   completeWait()    —— 结束该 Agent 正在进行的等待
 */
class MessageBus {
  private seq = 0;
  /** agentId → 结束这次等待的函数；每个 Agent 最多一个等待。 */
  private pendingWaits = new Map<string, () => void>();

  constructor() {
    resetS20MailboxDir();
  }

  private inboxPath(agentId: string): string {
    validateAgentId(agentId);
    return path.join(S20_MAILBOX_DIR, `${agentId}.jsonl`);
  }

  /** 预先创建空信箱文件，方便在目录里看到完整布局。 */
  ensureInbox(agentId: string): void {
    const p = this.inboxPath(agentId);
    if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf8');
  }

  /** 重 spawn 同名队友时清掉上一轮残留的消息。 */
  clearInbox(agentId: string): void {
    fs.writeFileSync(this.inboxPath(agentId), '', 'utf8');
  }

  /** 等待该 Agent 的信箱出现新消息，或超时；同一个 Agent 只保留一个等待。 */
  waitForMessage(agentId: string, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        this.pendingWaits.delete(agentId);
        resolve();
      };
      const timer = setTimeout(settle, ms);
      this.pendingWaits.set(agentId, () => {
        clearTimeout(timer);
        settle();
      });
    });
  }

  /** 结束该 Agent 正在进行的等待；没有等待时直接返回。 */
  completeWait(agentId: string): void {
    const finishWait = this.pendingWaits.get(agentId);
    if (!finishWait) return;
    this.pendingWaits.delete(agentId);
    finishWait();
  }

  async send(
    from: string,
    to: string,
    body: string,
    type = 'message',
    metadata: Record<string, unknown> = {},
  ): Promise<string> {
    fs.mkdirSync(S20_MAILBOX_DIR, { recursive: true });
    const msg: AgentMessage = { from, to, body, type, timestamp: Date.now(), metadata };
    fs.appendFileSync(this.inboxPath(to), JSON.stringify(msg) + '\n', 'utf8');
    console.log(`  \x1b[33m[bus] ${from} → ${to}: (${type}) ${truncate(body, 50)}\x1b[0m`);
    // 写入后让正在等这个信箱的循环立即返回；没人等就忽略，消息仍在文件里。
    this.completeWait(to);
    return `msg_${Date.now()}_${++this.seq}`;
  }

  async readInbox(agentId: string): Promise<AgentMessage[]> {
    const p = this.inboxPath(agentId);
    if (!fs.existsSync(p)) return [];
    const msgs: AgentMessage[] = [];
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const msg = parseInboxLine(line);
      if (msg) msgs.push(msg);
    }
    fs.writeFileSync(p, '', 'utf8');
    return msgs;
  }

  async requeue(agentId: string, msgs: AgentMessage[]): Promise<void> {
    if (msgs.length === 0) return;
    fs.mkdirSync(S20_MAILBOX_DIR, { recursive: true });
    fs.appendFileSync(this.inboxPath(agentId), msgs.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');
  }
}

export const BUS = new MessageBus();
BUS.ensureInbox(LEAD_ID);
BUS.ensureInbox(WORKER_ID);
