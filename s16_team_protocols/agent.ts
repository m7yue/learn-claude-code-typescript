/**
 * s16: Team Protocols — 协议是 Agent 间协作的效应约定
 *
 * 本章机制：
 *   - ProtocolState：一次协议请求的状态（requestId / type / sender / target / status / payload / createdAt）
 *   - pendingRequests：在途协议请求注册表（requestId → ProtocolState）
 *   - settleResponse：按 requestId + 类型双校验，把响应关联回请求
 *   - 计划审批：队友 submit_plan 提交 → Lead review_plan 审批；关闭：Lead request_shutdown → 队友 shutdown_response
 *   - 队友空闲循环：从信箱收发协议消息（plan_request / shutdown_request）
 *   - consumeLeadInbox：统一消费 Lead 信箱，协议响应先路由再回灌历史
 *
 * 本章要点：
 *   - 计划内容由【队友的一次真实 Chat 回合】产生，经 plan_approval_request 送到 Lead；
 *     Lead 的 review_plan 校验 request_id 与 pending 状态、按计划步骤数判定，再回 plan_approval_response；
 *   - 计划审批的 request_id 由队友的 SubmitPlan Handler 生成；关闭请求的 request_id 由 Lead 的 RequestShutdown Handler 生成；
 *   - request_shutdown 先登记为待处理，直到收到同 request_id 的 shutdown_response 才落为 approved；
 *   - 队友是 s15 那套真实的 generator + runAgent 子循环，靠 .mailboxes/s16/<agentId>.jsonl 收发，空闲时真轮询。
 *
 * Mock 只替换「模型调用」这一件事：协议状态机、信箱 I/O、request_id 关联全部是真实代码。
 *
 * 信箱落在本章自己的 .mailboxes/s16/，启动时只清理这个子目录；real 模式使用更长的
 * 空闲/响应超时，收尾时宿主会通知仍在空闲等待的队友停止，保证 lead 失败后进程能退出。
 *
 * 路径来自 runtime/workspace.ts（.mailboxes/）。
 */

import { runAgent } from '../runtime/core.ts';
import type { Effect, EffectHandlers, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolResultBlock } from '../runtime/types.ts';
import { extractText, getToolUseBlocks, messageText, toolErrorResult } from '../runtime/response.ts';
import { callChat } from '../runtime/model.ts';
import type { ToolSchema } from '../runtime/model.ts';
import { schemasFor, specFor } from '../runtime/tool-schemas.ts';
import { buildSystemPrompt } from '../runtime/system-prompt.ts';
import { describeMode, loadEnvOnce, resolveMode } from '../runtime/env.ts';
import { settleActiveWithin } from '../runtime/wait.ts';
import { resolveWithin } from '../runtime/paths.ts';
import { truncate } from '../runtime/text.ts';
import { MAILBOXES_DIR, WORKSPACE_ROOT } from '../runtime/workspace.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// Part 0: 常量
// ============================================================

// 先加载 .env，下面按模式读取的超时/env 覆盖才会生效（--real/--mock 时 resolveMode 不会代为加载）。
loadEnvOnce();

const LEAD_ID = 'main';         // 主 Agent 的 mailbox 名
const PLANNER_ID = 'planner';   // 计划队友（本仓 spawn_teammate schema 只有 agentId/role）
const PLANNER_ROLE = '计划拟定者'; // spawn_teammate 的默认角色
const MAX_TURNS = 10;           // 队友最多 10 个"工作轮"

// 本章自己的信箱目录：不和 s15/s17/s20 共享同一层。
const S16_MAILBOX_DIR = path.join(MAILBOXES_DIR, 's16');

// 运行模式只在这里读一次；下面的超时和轮询间隔按 mock/real 取默认值，均可用 S16_* 覆盖。
const MODE = resolveMode();
const MAX_TOKENS = Number(process.env.S16_MAX_TOKENS) || 4096;
const POLL_MS = Number(process.env.S16_POLL_MS) || (MODE === 'real' ? 100 : 5);
const IDLE_TIMEOUT_MS =
  Number(process.env.S16_IDLE_TIMEOUT_MS) || (MODE === 'real' ? 10 * 60_000 : 15_000);
const RESPONSE_TIMEOUT_MS =
  Number(process.env.S16_RESPONSE_TIMEOUT_MS) || (MODE === 'real' ? 5 * 60_000 : 15_000);
const CLEANUP_WAIT_MS =
  Number(process.env.S16_CLEANUP_WAIT_MS) || (MODE === 'real' ? 3_000 : 1_000);

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

interface ChatEffect extends Effect<'Chat', { messages: Message[]; agentId: string }, LLMResponse> {}

interface BashExecEffect extends Effect<'BashExec', { command: string }, string> {}

interface ReadFileEffect extends Effect<'ReadFile', { path: string; limit?: number }, string> {}

interface WriteFileEffect extends Effect<'WriteFile', { path: string; content: string }, string> {}

/** 拉起一个队友子循环。 */
interface SpawnTeammateEffect extends Effect<'SpawnTeammate', { agentId: string; role: string }, { agentId: string; status: 'spawned' }> {}

/** 一条信箱消息的结构：from / to / body / type / timestamp / metadata。 */
interface AgentMessage {
  from: string;
  to: string;
  body: string;
  type: string;
  timestamp: number;
  metadata: Record<string, unknown>;
}

/** 通过信箱发送消息。 */
interface SendMessageEffect
  extends Effect<'SendMessage', { from: string; to: string; body: string; type?: string; metadata?: Record<string, unknown> }, { messageId: string }> {}

/** 读取并清空某个 Agent 的信箱。 */
interface CheckInboxEffect extends Effect<'CheckInbox', { agentId: string; waitMs?: number }, AgentMessage[]> {}

// s16 新增：计划审批与关闭协议 Effect

/** Lead 请求计划；返回队友提交的 pending 计划。 */
interface RequestPlanEffect
  extends Effect<'RequestPlan', { goal: string; context?: string }, Plan> {}

/** 队友提交计划并阻塞等待 Lead 审批（Lead 的 review_plan 落定后返回）。 */
interface SubmitPlanEffect
  extends Effect<
    'SubmitPlan',
    { from: string; plan: string; parentRequestId?: string },
    { requestId: string; outcome: 'approved' | 'rejected' | 'shutdown'; feedback?: string }
  > {}

/** Lead 审批队友提交的计划；计划文本来自 pendingRequests 里的 payload。 */
interface ReviewPlanEffect
  extends Effect<'ReviewPlan', { requestId: string; reviewerId: string }, { approved: boolean; feedback: string }> {}

/** Lead 请求关闭；返回是否收到 shutdown_response。 */
interface RequestShutdownEffect
  extends Effect<'RequestShutdown', { agentId: string; reason?: string }, { acknowledged: boolean; requestId: string; responder: string }> {}

/** 队友空闲等待：信箱有新消息或超时后返回（只在队友子循环里用）。 */
interface IdleEffect extends Effect<'Idle', { agentId: string; ms: number }, void> {}

type S16Effect =
  | ChatEffect
  | BashExecEffect
  | ReadFileEffect
  | WriteFileEffect
  | SpawnTeammateEffect
  | SendMessageEffect
  | CheckInboxEffect
  | RequestPlanEffect
  | SubmitPlanEffect
  | ReviewPlanEffect
  | RequestShutdownEffect
  | IdleEffect;

/** 协议请求的状态：pending → approved / rejected。 */
type ProtocolStatus = 'pending' | 'approved' | 'rejected';

/** Lead 视角的一次计划请求；pending 时等待 review_plan。 */
interface Plan {
  requestId: string;
  goal: string;
  context: string;
  planText: string; // 队友提交的完整计划文本
  steps: string[]; // 从 planText 里提取的编号步骤
  status: ProtocolStatus; // pending | approved | rejected
  reviewer?: string;
  feedback?: string;
}

// ============================================================
// Part 2: MessageBus —— 真实的 JSONL 信箱（.mailboxes/*.jsonl）
// ============================================================

// 队友名会拼进信箱文件名，先按白名单校验字符。
const VALID_AGENT_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** 校验队友名，避免拼出越界的信箱路径。 */
function validateAgentId(agentId: string): void {
  if (agentId === '.' || agentId === '..' || !VALID_AGENT_ID.test(agentId)) {
    throw new Error(`非法队友名: '${agentId}'（只允许字母、数字、点、下划线、短横线，1-64 字符）`);
  }
}

/** 启动时只清空本章自己的信箱目录。 */
function resetS16MailboxDir(): void {
  fs.rmSync(S16_MAILBOX_DIR, { recursive: true, force: true });
  fs.mkdirSync(S16_MAILBOX_DIR, { recursive: true });
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
 *   send()            —— 追加一行（真实写文件，可带 metadata），并让等待者立即返回
 *   readInbox()       —— 读出全部消息，然后把文件清空（读完即取走）
 *   requeue()         —— 把这次没处理的消息原样写回（等待协议响应时不丢别的消息）
 *   waitForMessage()  —— 等待新消息或超时
 *   completeWait()    —— 结束该 Agent 正在进行的等待
 */
class MessageBus {
  /** 进程内递增序号，保证 messageId 不重复。 */
  private seq = 0;
  /** agentId → 结束这次等待的函数；每个 Agent 最多一个等待。 */
  private pendingWaits = new Map<string, () => void>();

  constructor() {
    resetS16MailboxDir();
  }

  /** agentId → 本章信箱文件路径；先做白名单校验。 */
  private inboxPath(agentId: string): string {
    validateAgentId(agentId);
    return path.join(S16_MAILBOX_DIR, `${agentId}.jsonl`);
  }

  /** 预先创建空信箱文件，方便在目录里看到完整布局。 */
  ensureInbox(agentId: string): void {
    const p = this.inboxPath(agentId);
    if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf8');
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
    fs.mkdirSync(S16_MAILBOX_DIR, { recursive: true });
    const msg: AgentMessage = { from, to, body, type, timestamp: Date.now(), metadata };
    fs.appendFileSync(this.inboxPath(to), JSON.stringify(msg) + '\n', 'utf8');
    const messageId = `msg_${Date.now()}_${++this.seq}`;
    console.log(`  \x1b[33m[bus] ${from} → ${to}: (${type}) ${truncate(body, 50)}\x1b[0m`);
    // 写入后让正在等这个信箱的循环立即返回；没人等就忽略，消息仍在文件里。
    this.completeWait(to);
    return messageId;
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
    // 读完即取走：读出全部消息后把文件清空为 0 字节，保留目录和文件名（便于看到信箱布局）。
    fs.writeFileSync(p, '', 'utf8');
    return msgs;
  }

  /** 把这次没处理的消息原样写回信箱，保持它们原来的先后顺序。 */
  async requeue(agentId: string, msgs: AgentMessage[]): Promise<void> {
    if (msgs.length === 0) return;
    fs.mkdirSync(S16_MAILBOX_DIR, { recursive: true });
    const data = msgs.map((m) => JSON.stringify(m)).join('\n') + '\n';
    fs.appendFileSync(this.inboxPath(agentId), data, 'utf8');
  }
}

/** 全章共用的消息总线。 */
const BUS = new MessageBus();
BUS.ensureInbox(LEAD_ID);

// ============================================================
// Part 3: 协议状态机
// ============================================================

/** 本章的两种协议请求。 */
type ProtocolType = 'plan_approval' | 'shutdown';

/** 一条在途协议请求：requestId 关联请求与响应，status 记录生命周期。 */
interface ProtocolState {
  requestId: string;
  type: ProtocolType; // "shutdown" | "plan_approval"
  sender: string;
  target: string;
  status: ProtocolStatus; // pending | approved | rejected
  payload: string; // 计划文本或 shutdown reason
  createdAt: number;
  /** 计划审批请求对应的 plan_request id；用于把迟到/旧计划与当前请求区分开。 */
  parentRequestId?: string;
}

/** 活跃协议请求注册表：requestId → ProtocolState。 */
const pendingRequests = new Map<string, ProtocolState>();

// 进程内递增序号，避免同一毫秒内生成重复 id。
let reqSeq = 0;

/** 生成带类型前缀、随机段和递增序号的 request_id。 */
function newRequestId(prefix = 'req'): string {
  reqSeq += 1;
  return `${prefix}_${Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, '0')}_${reqSeq}`;
}

/** request type → 它唯一合法的 response type。 */
function expectedResponseType(type: ProtocolType): string {
  return type === 'shutdown' ? 'shutdown_response' : 'plan_approval_response';
}

/**
 * 通过 request_id 关联响应，并校验响应类型与请求类型一致。
 * 这个函数只有副作用：更新 pendingRequests 中的状态、打印校验结果；调用方不使用返回值。
 * 关联与校验规则：
 *   - 未知 request_id：拒绝并记日志
 *   - 类型不匹配：拒绝并记日志
 *   - 已非 pending（重复响应）：忽略并记日志
 *   - 通过：置 approved / rejected
 */
function settleResponse(responseType: string, requestId: string, approve: boolean): void {
  const state = pendingRequests.get(requestId);
  if (!state) {
    console.log(`  \x1b[31m[protocol] unknown request_id: ${requestId}\x1b[0m`);
    return;
  }
  const expected = expectedResponseType(state.type);
  if (responseType !== expected) {
    console.log(`  \x1b[31m[protocol] type mismatch: expected ${expected}, got ${responseType}\x1b[0m`);
    return;
  }
  if (state.status !== 'pending') {
    console.log(`  \x1b[33m[protocol] ${requestId} already ${state.status}, ignoring duplicate\x1b[0m`);
    return;
  }
  state.status = approve ? 'approved' : 'rejected';
  const icon = approve ? '✓' : '✗';
  const color = approve ? '32' : '31';
  console.log(`  \x1b[${color}m[protocol] ${state.type} ${icon} (${requestId}: ${state.status})\x1b[0m`);
}

/** 仅当请求仍处于 pending 时落定；用于超时/宿主收尾，避免覆盖已经到达的响应。 */
function settleResponseIfPending(responseType: string, requestId: string, approve: boolean): void {
  const state = pendingRequests.get(requestId);
  if (state?.status === 'pending') settleResponse(responseType, requestId, approve);
}

// ============================================================
// Part 4: 统一消费 Lead 信箱
// ============================================================

/**
 * 读取 Lead 信箱。协议响应先经 settleResponse 路由，再返回全部消息。
 * check_inbox 工具与主循环共用它，避免消息被消费却没走协议关联。
 */
async function consumeLeadInbox(routeProtocol = true): Promise<AgentMessage[]> {
  const msgs = await BUS.readInbox(LEAD_ID);
  if (msgs.length === 0) return [];
  if (routeProtocol) {
    for (const msg of msgs) {
      const reqId = String(msg.metadata['request_id'] ?? '');
      if (reqId && msg.type.endsWith('_response')) {
        settleResponse(msg.type, reqId, Boolean(msg.metadata['approve']));
      }
    }
  }
  return msgs;
}

/**
 * 请求方（Lead）在限定时间内反复查看自己的信箱，等待与 requestId 完全匹配的响应。
 * 是否命中以 pendingRequests 中的状态为准：重复响应可以被读到，但不会覆盖第一次落定的结果。
 * 仅 RequestShutdown 使用；RequestPlan 等的是 plan_approval_request，用 pollForMessage。
 */
async function pollForResponse(
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
        // 落定 pendingRequests；重复/错类型/未知只记日志，不改变已有状态。
        settleResponse(msg.type, reqId, Boolean(msg.metadata['approve']));
      }
      const state = pendingRequests.get(reqId);
      const typeMatches = !!state && expectedResponseType(state.type) === msg.type;
      if (!matched && isResponse && typeMatches && reqId === expectedRequestId && msg.type === expectedType) {
        matched = msg;
      } else {
        keep.push(msg);
      }
    }
    if (keep.length > 0) await BUS.requeue(LEAD_ID, keep);
    if (matched) return matched;
    // 先读后判：响应可能刚写回、队友随即退出；确认没读到匹配响应再判目标是否还活着。
    if (!activeTeammates.has(targetId)) {
      console.log(`  \x1b[31m[protocol] teammate '${targetId}' is no longer running\x1b[0m`);
      return null;
    }
    await BUS.waitForMessage(LEAD_ID, POLL_MS);
  }
  console.log(`  \x1b[31m[protocol] timeout waiting for ${expectedType} (${expectedRequestId})\x1b[0m`);
  return null;
}

/**
 * Lead 等待队友主动发来的协议请求（计划审批）。
 * 不是目标的消息会原样写回，不会被悄悄丢掉。
 */
async function pollForMessage(
  expectedType: string,
  fromId: string,
  parentRequestId: string | undefined,
  timeoutMs = RESPONSE_TIMEOUT_MS,
): Promise<AgentMessage | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = await BUS.readInbox(LEAD_ID);
    let matched: AgentMessage | null = null;
    const keep: AgentMessage[] = [];
    for (const msg of msgs) {
      const reqId = String(msg.metadata['request_id'] ?? '');
      if (reqId && msg.type.endsWith('_response')) {
        settleResponse(msg.type, reqId, Boolean(msg.metadata['approve']));
      }

      // 计划审批请求必须和本次 plan_request 关联；旧请求的迟到计划直接拒绝，
      // 不能让它冒充当前请求的计划，也不能一直留在信箱里被下一次读到。
      if (msg.type === 'plan_approval_request' && parentRequestId) {
        const parentId = String(msg.metadata['parent_request_id'] ?? '');
        if (parentId !== parentRequestId) {
          const staleId = String(msg.metadata['request_id'] ?? '');
          if (staleId) {
            settleResponseIfPending('plan_approval_response', staleId, false);
            try {
              await BUS.send(LEAD_ID, msg.from, '该计划对应的请求已过期，请重新提交。', 'plan_approval_response', {
                request_id: staleId,
                approve: false,
                feedback: '请求已过期',
              });
            } catch (error) {
              // 伪造/损坏的 from 不应该让 lead 崩溃；拒绝消息写不进去就只记日志。
              console.warn(
                `  [RequestPlan] 无法回绝旧计划 ${staleId}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
          console.log(
            `  \x1b[33m[RequestPlan] 丢弃与当前请求不匹配的旧计划 ${staleId || '(缺少 request_id)'}\x1b[0m`,
          );
          continue;
        }
      }

      const parentMatches =
        !parentRequestId ||
        msg.type !== 'plan_approval_request' ||
        String(msg.metadata['parent_request_id'] ?? '') === parentRequestId;
      if (!matched && msg.type === expectedType && msg.from === fromId && parentMatches) {
        matched = msg;
      } else {
        keep.push(msg);
      }
    }
    if (keep.length > 0) await BUS.requeue(LEAD_ID, keep);
    if (matched) return matched;
    if (!activeTeammates.has(fromId)) {
      console.log(`  \x1b[31m[protocol] teammate '${fromId}' is no longer running\x1b[0m`);
      return null;
    }
    await BUS.waitForMessage(LEAD_ID, POLL_MS);
  }
  console.log(`  \x1b[31m[protocol] timeout waiting for ${expectedType} from ${fromId}\x1b[0m`);
  return null;
}

// ============================================================
// Part 5: Mock LLM —— 只替换模型调用
// ============================================================

/** 从最近的工具结果/消息里提取 requestId —— 证明 id 是经工具结果真实传递的。 */
function findRequestId(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = messageText(messages[i].content);
    const m = text.match(/"request_?[iI]d"\s*:\s*"([^"]+)"/);
    if (m) return m[1];
  }
  return '';
}

/** 最后一条 user 消息的文本；用于判断这次 Chat 是否由 plan_request 触发。 */
function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messageText(messages[i].content);
  }
  return '';
}

/** 历史里已经提交过几次指定工具。 */
function countToolUses(messages: Message[], name: string): number {
  let count = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.name === name) count += 1;
    }
  }
  return count;
}

/** Lead 剧本：组建团队 → 请求计划 → 首次审批（拒绝）→ 重新请求 → 二次审批（批准）→ 执行 → 请求关闭 → 查信箱。 */
function mockLead(messages: Message[]): LLMResponse {
  const turn = messages.filter((m) => m.role === 'assistant').length;
  if (turn === 0) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '组建一个计划团队。' },
        { type: 'tool_use', id: 'm1', name: 'spawn_teammate', input: { agentId: PLANNER_ID, role: PLANNER_ROLE } },
      ],
    };
  }
  if (turn === 1) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '请求一份执行计划，等队友提交 plan_approval_request。' },
        {
          type: 'tool_use',
          id: 'm2',
          name: 'request_plan',
          input: { goal: '重构认证模块', context: '升级到 OAuth 2.0，保持向后兼容' },
        },
      ],
    };
  }
  if (turn === 2) {
    const requestId = findRequestId(messages);
    if (!requestId) {
      return {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '计划请求未到达，无法审批。' }],
      };
    }
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '审批第一次提交的计划（预期因步骤不足被拒绝）。' },
        { type: 'tool_use', id: 'm3', name: 'review_plan', input: { requestId, reviewerId: LEAD_ID } },
      ],
    };
  }
  if (turn === 3) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '计划被拒绝，请求队友补充步骤后重新提交。' },
        {
          type: 'tool_use',
          id: 'm4',
          name: 'request_plan',
          input: { goal: '重构认证模块', context: '上一次计划只有 2 步，请补充到至少 3 步' },
        },
      ],
    };
  }
  if (turn === 4) {
    const requestId = findRequestId(messages);
    if (!requestId) {
      return {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '修订计划未到达，无法审批。' }],
      };
    }
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '审批补充后的计划（预期批准）。' },
        { type: 'tool_use', id: 'm5', name: 'review_plan', input: { requestId, reviewerId: LEAD_ID } },
      ],
    };
  }
  if (turn === 5) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '执行已批准计划的第一步。' },
        { type: 'tool_use', id: 'm6', name: 'bash', input: { command: 'echo "步骤1: 创建 OAuth 适配器"' } },
      ],
    };
  }
  if (turn === 6) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '任务完成，请求队友关闭并等待其 shutdown_response。' },
        { type: 'tool_use', id: 'm7', name: 'request_shutdown', input: { agentId: PLANNER_ID, reason: '重构任务已完成' } },
      ],
    };
  }
  if (turn === 7) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '检查收件箱，收尾。' },
        { type: 'tool_use', id: 'm8', name: 'check_inbox', input: {} },
      ],
    };
  }
  return {
    stop_reason: 'end_turn',
    content: [
      {
        type: 'text',
        text: '协议流程演示完成：请求计划 → 队友提交 → Lead 拒绝 → 重新提交 → Lead 审批 → 执行 → 关闭确认。',
      },
    ],
  };
}

// 第一次提交只有 2 步，ReviewPlan 会拒绝；收到第二次 plan_request 后提交修订版。
const INITIAL_PLAN = '执行计划：\n1. 分析现有认证逻辑\n2. 设计 OAuth 2.0 适配器接口';
const REVISED_PLAN =
  '执行计划：\n1. 分析现有认证逻辑\n2. 设计 OAuth 2.0 适配器接口\n3. 实现 Token 刷新机制\n4. 添加向后兼容层\n5. 编写集成测试';

/**
 * 队友（计划拟定者）剧本：收到 plan_request 后生成计划文本并调用 submit_plan；
 * 第一次提交步骤不足的计划，被拒绝后等待新的 plan_request 再提交修订版。
 */
function mockPlanner(agentId: string, messages: Message[]): LLMResponse {
  const submitted = countToolUses(messages, 'submit_plan');
  const hasPlanRequest = lastUserText(messages).includes('"type":"plan_request"');

  if (hasPlanRequest) {
    const plan = submitted === 0 ? INITIAL_PLAN : REVISED_PLAN;
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: plan },
        { type: 'tool_use', id: `${agentId}_s${submitted + 1}`, name: 'submit_plan', input: { plan } },
      ],
    };
  }

  return {
    stop_reason: 'end_turn',
    content: [
      {
        type: 'text',
        text:
          submitted === 0
            ? '等待 lead 的 plan_request。'
            : submitted === 1
              ? '计划被拒绝，等待 lead 重新请求。'
              : '计划已批准，等待 lead 后续指令。',
      },
    ],
  };
}

/** 按 agentId 选择 mock 剧本：main 用 Lead 剧本，其余用 planner 剧本。 */
function mockModel(agentId: string, messages: Message[]): LLMResponse {
  return agentId === LEAD_ID ? mockLead(messages) : mockPlanner(agentId, messages);
}

/** real 模式注入的 system prompt；mock 模式不读取，故零配置运行行为不变。 */
const LEAD_SYSTEM_PROMPT = buildSystemPrompt(
  `用 spawn_teammate 组建计划团队（本章固定 agentId='${PLANNER_ID}'）；用 request_plan 请求计划。request_plan 会在返回前接收 plan_approval_request，并在工具结果里给出 requestId；拿到 requestId 后立即调用 review_plan 审批（只有 lead 能审批），不要用 check_inbox 等待 plan_approval_request。review_plan 返回拒绝时，再次 request_plan 请队友补充计划并 review 新计划；批准后只调用一次 bash 演示执行，然后立即 request_shutdown 并等待 shutdown_response。不要探索工作区，也不要反复 check_inbox。每一步都等协议消息到达再继续，不要跳过审批。` +
    '本教学演示中 bash 是模拟的：只回显命令文本、不会真正执行，请不要依赖它的输出。',
);

/** 队友的 system prompt：只负责提交计划、等待审批和响应关闭。 */
function teammateSystemPrompt(agentId: string, role: string): string {
  return `你是 '${agentId}'，一名${role}。收到信箱里的 plan_request 后，直接把完整执行计划（编号步骤）写进 submit_plan 的 plan 参数；submit_plan 会把计划作为 plan_approval_request 发给 lead（信箱 '${LEAD_ID}'），并一直等待 lead 的 plan_approval_response。批准后简短确认并结束当前回合，等待 lead 的 shutdown_request；如果计划被拒绝，等待 lead 的下一次 plan_request，提交修订后的完整计划。不要执行计划里的工作，也不要用 bash 或 read_file 探索工作区。收到 shutdown_request 后发送 shutdown_response 再退出。本教学演示中 bash 是模拟的：只回显命令文本、不会真正执行，请不要依赖它的输出。`;
}

// 只在本章收紧共享 schema，不修改 runtime/tool-schemas.ts。
const BASH_SCHEMA: ToolSchema = {
  ...specFor('bash'),
  description: '模拟执行一条 shell 命令；只回显命令文本，不会真正执行。',
  input_schema: {
    type: 'object',
    properties: { command: { type: 'string', description: '要执行的命令' } },
    required: ['command'],
  },
};

// 本章只允许创建 planner。
const SPAWN_SCHEMA: ToolSchema = {
  ...specFor('spawn_teammate'),
  description: `创建一个常驻队友；本章协议固定使用 agentId='${PLANNER_ID}'，role 描述其职责。`,
};

// Lead 用：查看信箱；默认短暂等待活跃队友，可用 waitMs 覆盖。
const CHECK_INBOX_SCHEMA: ToolSchema = {
  ...specFor('check_inbox'),
  description: '查看 lead 自己的信箱；默认先等活跃队友最多 500ms，可用 waitMs 覆盖。计划审批请求已由 request_plan 接收，不要用它等待 plan_approval_request。',
  input_schema: {
    type: 'object',
    properties: {
      waitMs: { type: 'integer', description: '（可选）收信前等待活跃队友的上限（毫秒），默认 500' },
    },
    required: [],
  },
};

// 计划审批由 Lead 受理：requestId 来自 request_plan 的返回，
// 计划文本已经在队友提交的 pending 请求里。
const REVIEW_PLAN_SCHEMA: ToolSchema = {
  ...specFor('review_plan'),
  description: '审批队友提交的计划（只有 lead 能审批）；requestId 从 request_plan 的返回里取，收到 request_plan 结果后立即调用。',
  input_schema: {
    type: 'object',
    properties: {
      requestId: { type: 'string', description: '待审计划请求的 requestId（来自 request_plan 返回）' },
      reviewerId: { type: 'string', description: `审批者标识（固定为 '${LEAD_ID}'）` },
    },
    required: ['requestId', 'reviewerId'],
  },
};

// request_id 由队友的 SubmitPlan Handler 生成，不暴露给模型（避免模型自己挑 id、跨请求复用）。
const REQUEST_PLAN_SCHEMA: ToolSchema = {
  ...specFor('request_plan'),
  description: '请队友提交执行计划；本工具会等到 plan_approval_request 到达并把 requestId 返回给你，随后立即调用 review_plan。',
  input_schema: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: '计划目标' },
      context: { type: 'string', description: '（可选）背景说明' },
    },
    required: ['goal'],
  },
};

// 队友提交计划；submit_plan 会在 Handler 里阻塞等待 Lead 的审批响应。
const SUBMIT_PLAN_SCHEMA: ToolSchema = {
  ...specFor('submit_plan'),
  description: '向 lead 提交执行计划并等待审批；plan 写成编号步骤（1. 2. 3. ...）。',
};

// Lead 的工具集：只有 Lead 侧暴露 review_plan。
const LEAD_TOOLS: ToolSchema[] = [
  BASH_SCHEMA,
  SPAWN_SCHEMA,
  ...schemasFor('send_message', 'request_shutdown'),
  REQUEST_PLAN_SCHEMA,
  REVIEW_PLAN_SCHEMA,
  CHECK_INBOX_SCHEMA,
];

// 队友的工具集：只有队友侧暴露 submit_plan。
const TEAMMATE_TOOLS: ToolSchema[] = [
  BASH_SCHEMA,
  ...schemasFor('read_file', 'write_file', 'send_message'),
  SUBMIT_PLAN_SCHEMA,
];

// ============================================================
// Part 6: 队友子循环 —— 真实 generator + runAgent（复用 s15 模式）
// ============================================================

// 运行中的队友：agentId → 子循环 Promise。
const activeTeammates = new Map<string, Promise<string>>();
// 队友失败会影响退出码；不要让 lead 的最终文本掩盖队友异常。
const teammateFailures = new Set<string>();
// agentId → role；拼队友 system prompt 时用。
const teammateRoles = new Map<string, string>();
// 宿主是否正在收尾；用于让空闲队友尽快退出。
let hostStopping = false;

/** 标记宿主收尾，并让仍在等待的队友立即返回；正常路径由 shutdown 协议结束。 */
function stopTeammates(): void {
  hostStopping = true;
  for (const agentId of activeTeammates.keys()) BUS.completeWait(agentId);
}

/** 队友提交计划后阻塞等待 Lead 的响应；期间遇到 shutdown_request 就地应答并返回。 */
async function waitForPlanDecision(
  agentId: string,
  requestId: string,
  timeoutMs = RESPONSE_TIMEOUT_MS,
): Promise<{ outcome: 'approved' | 'rejected' | 'shutdown'; feedback?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = await BUS.readInbox(agentId);
    const keep: AgentMessage[] = [];
    let matched: AgentMessage | null = null;
    let shutdownMsg: AgentMessage | null = null;
    for (const msg of msgs) {
      const reqId = String(msg.metadata['request_id'] ?? '');
      if (!matched && msg.type === 'plan_approval_response' && reqId === requestId) {
        matched = msg;
        continue;
      }
      if (!shutdownMsg && msg.type === 'shutdown_request') {
        shutdownMsg = msg;
        continue;
      }
      keep.push(msg);
    }
    if (keep.length > 0) await BUS.requeue(agentId, keep);
    if (matched) {
      // 同批到达的 shutdown_request 放回信箱，由外层循环处理，不能吞掉。
      if (shutdownMsg) await BUS.requeue(agentId, [shutdownMsg]);
      const state = pendingRequests.get(requestId);
      if (state?.status === 'pending') {
        // 正常路径由 Lead 的 ReviewPlan 先落定；这里只兜底处理响应先到的情况。
        settleResponse(matched.type, requestId, Boolean(matched.metadata['approve']));
      }
      const settled = pendingRequests.get(requestId);
      return {
        outcome: settled?.status === 'approved' ? 'approved' : 'rejected',
        feedback: String(matched.metadata['feedback'] ?? ''),
      };
    }
    if (shutdownMsg) {
      const shutdownId = String(shutdownMsg.metadata['request_id'] ?? '');
      await BUS.send(agentId, LEAD_ID, 'Shutting down gracefully.', 'shutdown_response', {
        request_id: shutdownId,
        approve: true,
        responder: agentId,
      });
      console.log(`  \x1b[35m[protocol] ${agentId} approved shutdown (${shutdownId})\x1b[0m`);
      settleResponseIfPending('plan_approval_response', requestId, false);
      return { outcome: 'shutdown' };
    }
    if (hostStopping) {
      settleResponseIfPending('plan_approval_response', requestId, false);
      return { outcome: 'shutdown' };
    }
    await BUS.waitForMessage(agentId, POLL_MS);
  }
  // 超时只按“没收到响应”处理：即使共享状态已被 ReviewPlan 落成 approved，
  // 也不能在没收到匹配响应时返回 approved，否则就违背了协议闸门。
  settleResponseIfPending('plan_approval_response', requestId, false);
  return { outcome: 'rejected', feedback: '等待审批响应超时' };
}

/**
 * 队友 Agent 循环：空闲时轮询自己的信箱；收到协议消息后分发：
 *   - shutdown_request  → 回复 shutdown_response（带同一 request_id）并停止
 *   - plan_request      → 注入历史 → 真实 Chat 回合（工具结果继续送回模型）→ submit_plan 工具 → 等待 Lead 审批
 */
function* teammateLoop(perform: PerformFn<S16Effect>, agentId: string, role: string) {
  const messages: Message[] = [
    {
      role: 'user',
      content: `你是团队成员 '${agentId}'（${role}）。等待 lead 经信箱发来的 plan_request；收到后把完整执行计划（编号步骤）写进 submit_plan 的 plan 参数，等 lead 审批后再继续。收到 shutdown_request 时发送 shutdown_response 后退出。`,
    },
  ];

  let workTurns = 0;
  let idleSince: number | null = null;
  let pendingToolResults = false;
  let finalText = '';
  // 最近一次 plan_request 的 request_id；submit_plan 把它回填给 plan_approval_request。
  let activePlanRequestId = '';

  while (workTurns < MAX_TURNS) {
    const inbox = yield* perform({ type: 'CheckInbox', input: { agentId } });

    // 上一轮的工具结果还没被模型消化时，带着这些结果直接继续 Chat。
    if (inbox.length === 0 && !pendingToolResults) {
      // 宿主收尾标记：命中后结束空闲等待（正常路径由 shutdown 协议结束）。
      if (hostStopping) {
        finalText = `(${agentId}) 宿主收尾，停止等待`;
        break;
      }
      if (idleSince === null) idleSince = Date.now();
      if (Date.now() - idleSince >= IDLE_TIMEOUT_MS) {
        finalText = `(${agentId}) 空闲超时，未收到更多消息`;
        break;
      }
      yield* perform({ type: 'Idle', input: { agentId, ms: POLL_MS } });
      continue;
    }
    if (inbox.length > 0) idleSince = null;

    const deliverable: AgentMessage[] = [];
    let shutdown = false;
    for (const msg of inbox) {
      if (msg.type === 'shutdown_request') {
        const reqId = String(msg.metadata['request_id'] ?? '');
        yield* perform({
          type: 'SendMessage',
          input: {
            from: agentId,
            to: LEAD_ID,
            body: 'Shutting down gracefully.',
            type: 'shutdown_response',
            metadata: { request_id: reqId, approve: true, responder: agentId },
          },
        });
        console.log(`  \x1b[35m[protocol] ${agentId} approved shutdown (${reqId})\x1b[0m`);
        shutdown = true;
        break;
      }
      if (msg.type === 'plan_request') {
        activePlanRequestId = String(msg.metadata['request_id'] ?? '');
      }
      deliverable.push(msg);
    }
    if (shutdown) break;

    // 先处理真实的 shutdown_request，再处理宿主收尾信号。
    if (hostStopping) {
      finalText = `(${agentId}) 宿主收尾，停止等待`;
      break;
    }

    if (deliverable.length > 0) {
      messages.push({ role: 'user', content: `<inbox>${JSON.stringify(deliverable)}</inbox>` });
    }

    workTurns += 1;
    const response = yield* perform({ type: 'Chat', input: { messages, agentId } });
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      finalText = extractText(response);
      pendingToolResults = false;
      continue; // 不退出：回到循环空闲等待后续协议消息
    }

    const toolResults: ToolResultBlock[] = [];
    let stopAfterTools = false;
    for (const block of getToolUseBlocks(response)) {
      try {
        let output: string;
        switch (block.name) {
          case 'bash':
            output = yield* perform({
              type: 'BashExec',
              input: { command: String(block.input['command'] ?? '') },
            });
            break;
          case 'read_file': {
            const limit = block.input['limit'];
            const input: { path: string; limit?: number } = { path: String(block.input['path'] ?? '') };
            if (limit !== undefined) input.limit = Number(limit);
            output = yield* perform({ type: 'ReadFile', input });
            break;
          }
          case 'write_file':
            output = yield* perform({
              type: 'WriteFile',
              input: { path: String(block.input['path'] ?? ''), content: String(block.input['content'] ?? '') },
            });
            break;
          case 'send_message': {
            const { messageId } = yield* perform({
              type: 'SendMessage',
              input: { from: agentId, to: String(block.input['to'] ?? ''), body: String(block.input['body'] ?? '') },
            });
            output = `已发送 (${messageId})`;
            break;
          }
          case 'submit_plan': {
            // 计划内容来自本次 Chat 回合；SubmitPlan 会阻塞到 Lead 的审批响应到达。
            const planText = String(block.input['plan'] ?? '').trim();
            const result = yield* perform({
              type: 'SubmitPlan',
              input: {
                from: agentId,
                plan: planText,
                ...(activePlanRequestId ? { parentRequestId: activePlanRequestId } : {}),
              },
            });
            if (result.outcome === 'shutdown') {
              stopAfterTools = true;
              output = '收到 shutdown_request，停止';
            } else {
              const label = result.outcome === 'approved' ? '批准' : '拒绝';
              output = `计划审批 (${result.requestId}): ${label}${result.feedback ? ` — ${result.feedback}` : ''}`;
            }
            break;
          }
          default:
            output = `[未知工具] ${block.name}`;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: output });
      } catch (err) {
        toolResults.push(toolErrorResult(block.id, err));
      }
    }
    messages.push({ role: 'user', content: toolResults });
    if (stopAfterTools) {
      finalText = `(${agentId}) 收到关闭请求，停止`;
      break;
    }
    pendingToolResults = true;
  }

  const summary = finalText || 'Done.';
  yield* perform({
    type: 'SendMessage',
    input: { from: agentId, to: LEAD_ID, body: summary, type: 'result', metadata: {} },
  });
  console.log(`  \x1b[32m[teammate] ${agentId} finished\x1b[0m`);
  return summary;
}

/** 拉起一个队友：注册到 activeTeammates，并启动其独立的 runAgent 子循环。 */
function startTeammate(agentId: string, role: string): Promise<string> {
  const promise = runAgent<S16Effect, string>(
    (perform) => teammateLoop(perform, agentId, role),
    s16Handlers,
  )
    .catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      teammateFailures.add(agentId);
      console.log(`  \x1b[31m[teammate] ${agentId} 异常: ${message}\x1b[0m`);
      try {
        await BUS.send(agentId, LEAD_ID, `[teammate error] ${message}`, 'result');
      } catch {
        // 错误结果本身写不进去时只保留上面的日志。
      }
      return '[teammate error]';
    })
    .finally(() => {
      if (activeTeammates.get(agentId) === promise) {
        activeTeammates.delete(agentId);
        teammateRoles.delete(agentId);
      }
    });

  activeTeammates.set(agentId, promise);
  return promise;
}

// ============================================================
// Part 7: Handler 实现（协议状态机 + 信箱 I/O）
// ============================================================

// 安全路径校验：把参数解析到工作区内；越界（含同前缀的兄弟目录）即抛错。
function safePath(p: string): string {
  return resolveWithin(WORKSPACE_ROOT, p);
}

/** 所有 Effect 的 Handler：协议状态机、信箱 I/O 和模型调用都在这里汇合。 */
const s16Handlers: EffectHandlers<S16Effect> = {
  /** 模型调用：mock 模式使用脚本，real 模式走真实端点。 */
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages, agentId } = effect.input;
    const isLead = agentId === LEAD_ID;
    const round = messages.filter((m) => m.role === 'assistant').length + 1;
    console.log(`\n[Chat:${agentId}] → 轮次 ${round}`);
    return callChat((m) => mockModel(agentId, m), messages, {
      tools: isLead ? LEAD_TOOLS : TEAMMATE_TOOLS,
      system: isLead
        ? LEAD_SYSTEM_PROMPT
        : teammateSystemPrompt(agentId, teammateRoles.get(agentId) ?? PLANNER_ROLE),
      maxTokens: MAX_TOKENS,
    });
  },

  /** 模拟 bash：只回显命令，不真正执行。 */
  BashExec: async (effect: BashExecEffect): Promise<string> => {
    console.log(`[BashExec] → ${effect.input.command}`);
    return `(执行: ${effect.input.command})`;
  },

  /** 读取工作区文件；路径由 safePath 限制在工作区内。错误交给外层派发标 is_error。 */
  ReadFile: async (effect: ReadFileEffect): Promise<string> => {
    const lines = fs.readFileSync(safePath(effect.input.path), 'utf8').split('\n');
    if (effect.input.limit && effect.input.limit < lines.length) {
      return [...lines.slice(0, effect.input.limit), `... (${lines.length - effect.input.limit} more lines)`].join('\n');
    }
    return lines.join('\n');
  },

  /** 写入工作区文件；路径由 safePath 限制在工作区内。错误交给外层派发标 is_error。 */
  WriteFile: async (effect: WriteFileEffect): Promise<string> => {
    const target = safePath(effect.input.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, effect.input.content, 'utf8');
    return `Wrote ${effect.input.content.length} bytes to ${effect.input.path}`;
  },

  /** 创建本章唯一的计划队友，并启动其子循环。 */
  SpawnTeammate: async (effect: SpawnTeammateEffect): Promise<{ agentId: string; status: 'spawned' }> => {
    const { agentId, role } = effect.input;
    validateAgentId(agentId);
    if (agentId === LEAD_ID) throw new Error(`'${LEAD_ID}' 是主 Agent 的保留名`);
    if (agentId !== PLANNER_ID) throw new Error(`本章协议固定使用队友 '${PLANNER_ID}'`);
    if (!role.trim()) throw new Error('role 不能为空');
    if (activeTeammates.has(agentId)) throw new Error(`队友 '${agentId}' 仍在运行`);

    BUS.ensureInbox(agentId);
    teammateRoles.set(agentId, role);
    console.log(`\x1b[36m[SpawnTeammate] 生成: ${agentId} (${role})\x1b[0m`);
    startTeammate(agentId, role);
    // 让队友先跑到第一个 Idle await（注册等待），主流程再继续派协议请求。
    await new Promise((r) => setTimeout(r, 0));
    return { agentId, status: 'spawned' };
  },

  /** 通过信箱发送消息；协议消息也走这里。 */
  SendMessage: async (effect: SendMessageEffect): Promise<{ messageId: string }> => {
    const { from, to, body, type, metadata } = effect.input;
    const messageId = await BUS.send(from, to, body, type ?? 'message', metadata ?? {});
    return { messageId };
  },

  /** 读取信箱；Lead 的信箱会先路由协议响应。 */
  CheckInbox: async (effect: CheckInboxEffect): Promise<AgentMessage[]> => {
    const { agentId, waitMs } = effect.input;
    let msgs: AgentMessage[];
    if (agentId === LEAD_ID) {
      // 在限定时间内等队友结束，保证他们的回信已经写进信箱（演示结果才稳定），又不会一直拖住主流程。
      await settleActiveWithin(activeTeammates, waitMs ?? 500);
      msgs = await consumeLeadInbox(true);
    } else {
      msgs = await BUS.readInbox(agentId);
    }
    console.log(`[CheckInbox:${agentId}] 收到 ${msgs.length} 条消息`);
    msgs.forEach((m) => console.log(`  ✉ [${m.type}] ${m.from}: ${truncate(m.body, 80)}`));
    return msgs;
  },

  /** Lead 请求计划：等队友把 plan_approval_request 送过来。 */
  RequestPlan: async (effect: RequestPlanEffect): Promise<Plan> => {
    const { goal } = effect.input;
    const context = effect.input.context ?? '';

    // 没有运行中的计划队友时直接返回 rejected，不进入等待。
    if (!activeTeammates.has(PLANNER_ID)) {
      console.log(`[RequestPlan] 没有运行中的队友 '${PLANNER_ID}'，直接返回 rejected`);
      return {
        requestId: '',
        goal,
        context,
        planText: '',
        steps: [],
        status: 'rejected',
        feedback: `没有运行中的队友 '${PLANNER_ID}'`,
      };
    }

    // 父请求 id：队友的 SubmitPlan 会把它回填到 plan_approval_request 的 metadata，
    // 这样迟到的旧计划不会被当成当前请求的计划。
    const planRequestId = newRequestId('planreq');
    console.log(`[RequestPlan] → "${goal}"，等待 ${PLANNER_ID} 提交计划（父请求 ${planRequestId}）`);
    const ask = context ? `请为下列目标提交一份执行计划：${goal}\n背景：${context}` : `请为下列目标提交一份执行计划：${goal}`;
    await BUS.send(LEAD_ID, PLANNER_ID, ask, 'plan_request', { request_id: planRequestId });

    // 等队友的 SubmitPlan 把带同一个 parent_request_id 的 plan_approval_request 送过来。
    const msg = await pollForMessage('plan_approval_request', PLANNER_ID, planRequestId);
    if (!msg) {
      return {
        requestId: '',
        goal,
        context,
        planText: '',
        steps: [],
        status: 'rejected',
        feedback: '等待队友提交计划超时',
      };
    }

    const requestId = String(msg.metadata['request_id'] ?? '');
    if (!requestId) {
      return {
        requestId: '',
        goal,
        context,
        planText: msg.body,
        steps: [],
        status: 'rejected',
        feedback: 'plan_approval_request 缺少 request_id',
      };
    }

    // 消息里的 id 可能来自旧请求或伪造；必须和 pendingRequests 里的真实状态对得上。
    const state = pendingRequests.get(requestId);
    if (!state || state.type !== 'plan_approval' || state.status !== 'pending') {
      return {
        requestId: '',
        goal,
        context,
        planText: msg.body,
        steps: [],
        status: 'rejected',
        feedback: `plan_approval_request 的状态异常（${state ? `${state.type}/${state.status}` : '不存在'}）`,
      };
    }

    const planText = msg.body;
    const steps = planText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^\d+[.)、]/.test(l));
    const plan: Plan = {
      requestId,
      goal,
      context,
      planText,
      steps,
      status: 'pending',
      reviewer: LEAD_ID,
      feedback: '等待 lead 审批',
    };
    console.log(`  收到 plan_approval_request ← ${msg.from}，requestId=${requestId} (${steps.length} 步)`);
    return plan;
  },

  /** 队友提交计划：注册 pending、发送请求并阻塞等待审批。 */
  SubmitPlan: async (effect: SubmitPlanEffect): Promise<{ requestId: string; outcome: 'approved' | 'rejected' | 'shutdown'; feedback?: string }> => {
    const { from, plan, parentRequestId } = effect.input;
    // request_id 由可信代码生成，不由模型决定。
    const requestId = newRequestId('plan');
    pendingRequests.set(requestId, {
      requestId,
      type: 'plan_approval',
      sender: from,
      target: LEAD_ID,
      status: 'pending',
      payload: plan,
      createdAt: Date.now(),
      parentRequestId,
    });
    console.log(
      `[SubmitPlan] ${from} 注册 ${requestId} (pending, parent=${parentRequestId ?? '(none)'})，发送 plan_approval_request → ${LEAD_ID}`,
    );
    try {
      await BUS.send(from, LEAD_ID, plan, 'plan_approval_request', {
        request_id: requestId,
        ...(parentRequestId ? { parent_request_id: parentRequestId } : {}),
      });
    } catch (error) {
      // 发送失败不能留下永远 pending 的请求。
      pendingRequests.delete(requestId);
      throw error;
    }
    return { requestId, ...(await waitForPlanDecision(from, requestId)) };
  },

  /** Lead 审批计划：校验 pending、落定状态并回发响应。 */
  ReviewPlan: async (effect: ReviewPlanEffect): Promise<{ approved: boolean; feedback: string }> => {
    const { requestId, reviewerId } = effect.input;
    if (reviewerId !== LEAD_ID) {
      console.log(`[ReviewPlan] 警告: reviewerId=${reviewerId} 不是 lead，拒绝`);
      return { approved: false, feedback: `只有 '${LEAD_ID}' 能审批计划` };
    }
    const state = pendingRequests.get(requestId);
    if (!state) {
      console.log(`[ReviewPlan] 警告: requestId=${requestId} 无对应待审请求，拒绝`);
      return { approved: false, feedback: '未找到对应的计划请求' };
    }
    if (state.type !== 'plan_approval' || state.status !== 'pending') {
      console.log(`[ReviewPlan] 警告: ${requestId} 当前 type=${state.type} status=${state.status}，拒绝重复/错类型审批`);
      return { approved: false, feedback: `请求不可审 (${state.status})` };
    }

    // 真实判定：按队友提交的计划文本里的有效步骤数决定批准与否。
    const stepLines = state.payload
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^\d+[.)、]/.test(l));
    const approved = stepLines.length >= 3;
    const feedback = approved
      ? `计划含 ${stepLines.length} 个步骤，步骤清晰，批准执行`
      : `计划仅 ${stepLines.length} 个有效步骤，要求补充后再提交`;

    console.log(`[ReviewPlan] requestId=${requestId} reviewerId=${reviewerId}`);
    console.log(`  校验: 请求存在且 pending (type=${state.type}, payload=${stepLines.length} 步)`);
    console.log(`  决定: ${approved ? '✓ 批准' : '✗ 拒绝'} — ${feedback}`);

    // 先发送响应，再落定状态：发送失败时请求保持 pending，等待方会超时兜底。
    // 发送成功后，planner 也可能先读到响应并自行落定；下面的状态核对允许这种顺序。
    try {
      await BUS.send(reviewerId, state.sender, feedback, 'plan_approval_response', {
        request_id: requestId,
        approve: approved,
        feedback,
        reviewer: reviewerId,
      });
    } catch (error) {
      console.log(
        `  \x1b[31m[ReviewPlan] 发送响应失败，保持 pending: ${
          error instanceof Error ? error.message : String(error)
        }\x1b[0m`,
      );
      throw error;
    }

    settleResponse('plan_approval_response', requestId, approved);
    const settled = pendingRequests.get(requestId);
    const expectedStatus = approved ? 'approved' : 'rejected';
    if (settled?.status !== expectedStatus) {
      console.log(`  \x1b[33m[protocol] ${requestId} 已被落定为 ${settled?.status}，与本次决定不一致\x1b[0m`);
      return { approved: false, feedback: `请求已被其他结果落定 (${settled?.status})` };
    }
    console.log(`  发送 plan_approval_response → ${state.sender}（已 settleResponse 落定）`);
    return { approved, feedback };
  },

  /** Lead 请求关闭：注册 pending，等待 shutdown_response。 */
  RequestShutdown: async (effect: RequestShutdownEffect): Promise<{ acknowledged: boolean; requestId: string; responder: string }> => {
    const { agentId } = effect.input;
    const reason = effect.input.reason ?? '';
    // 先校验目标再登记 pending：非法名字会让 BUS.send 抛错，不能留下永远 pending 的请求。
    validateAgentId(agentId);
    if (agentId === LEAD_ID) throw new Error(`'${LEAD_ID}' 是主 Agent 的保留名`);
    const requestId = newRequestId('shutdown');

    // 目标已经不在了：直接返回，不发出会永久留在信箱里的 shutdown_request。
    if (!activeTeammates.has(agentId)) {
      console.log(`[RequestShutdown] 没有运行中的队友 '${agentId}'，直接返回 acknowledged=false`);
      return { acknowledged: false, requestId, responder: agentId };
    }

    // 注册 pending；绝不在调用时预兑现 acknowledged=true。
    pendingRequests.set(requestId, {
      requestId,
      type: 'shutdown',
      sender: LEAD_ID,
      target: agentId,
      status: 'pending',
      payload: reason,
      createdAt: Date.now(),
    });
    console.log(`[RequestShutdown] agentId=${agentId} requestId=${requestId}`);
    if (reason) console.log(`  原因: ${reason}`);

    try {
      await BUS.send(LEAD_ID, agentId, reason ? `请优雅关闭：${reason}` : '请优雅关闭。', 'shutdown_request', {
        request_id: requestId,
      });
    } catch (error) {
      pendingRequests.delete(requestId);
      throw error;
    }
    console.log(`  协议注册: ${requestId} (type=shutdown, pending)，等待 shutdown_response...`);

    const resp = await pollForResponse(requestId, 'shutdown_response', agentId);
    if (!resp) {
      // 超时/目标退出：把仍处于 pending 的请求落为 rejected，保证汇总与返回值一致。
      settleResponseIfPending('shutdown_response', requestId, false);
    }
    const state = pendingRequests.get(requestId);
    return {
      acknowledged: state?.status === 'approved',
      requestId,
      responder: resp?.from ?? agentId,
    };
  },

  /** 队友空闲等待：信箱有新消息或超时后返回。 */
  Idle: async (effect: IdleEffect): Promise<void> => {
    await BUS.waitForMessage(effect.input.agentId, effect.input.ms);
  },
};

// ============================================================
// Part 8: 主 Agent Generator（agentId = 'main'）
// ============================================================

/** Lead 主循环：调用模型、执行工具，直到模型返回 end_turn。 */
function* agentLoop(perform: PerformFn<S16Effect>) {
  const agentId = LEAD_ID;
  const messages: Message[] = [
    {
      role: 'user',
      content:
        '用团队协议演示一次计划审批与优雅关闭：让 planner 先提交一份步骤不足的认证模块重构计划，review_plan 拒绝后再次 request_plan，让 planner 补充到至少 3 步并批准；然后用 bash 演示执行第一步（模拟），最后请求 planner 关闭。不要探索工作区，也不要追问计划内容。',
    },
  ];

  while (true) {
    const response = yield* perform({ type: 'Chat', input: { messages, agentId } });
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      return extractText(response);
    }

    const toolResults: ToolResultBlock[] = [];
    for (const block of getToolUseBlocks(response)) {
      try {
        let output: string;
        switch (block.name) {
          case 'bash':
            output = yield* perform({
              type: 'BashExec',
              input: { command: String(block.input['command'] ?? '') },
            });
            break;
          case 'spawn_teammate': {
            const { agentId: spawnedId } = yield* perform({
              type: 'SpawnTeammate',
              input: {
                agentId: String(block.input['agentId'] ?? ''),
                role: String(block.input['role'] ?? ''),
              },
            });
            output = `队友已创建: ${spawnedId}`;
            break;
          }
          case 'request_plan': {
            const input: { goal: string; context?: string } = {
              goal: String(block.input['goal'] ?? ''),
            };
            if (block.input['context'] !== undefined) input.context = String(block.input['context']);
            const plan = yield* perform({ type: 'RequestPlan', input });
            // 用 JSON 让 mock 和真实模型都能从工具结果里读到同一个 requestId；
            // 再补一句下一步指令，避免真实模型去 check_inbox 等已经被消费的请求消息。
            output =
              JSON.stringify({
                requestId: plan.requestId,
                status: plan.status,
                steps: plan.steps,
                planText: plan.planText,
                feedback: plan.feedback,
              }) +
              (plan.requestId
                ? `\nplan_approval_request 已被 request_plan 接收并消费；下一步必须调用 review_plan（requestId="${plan.requestId}", reviewerId="${LEAD_ID}"），不要用 check_inbox 等待它。`
                : `\n计划请求失败：${plan.feedback ?? ''}`);
            break;
          }
          case 'review_plan': {
            const requestId = String(block.input['requestId'] ?? '');
            const review = yield* perform({
              type: 'ReviewPlan',
              input: { requestId, reviewerId: String(block.input['reviewerId'] ?? LEAD_ID) },
            });
            output = `审批结果 (${requestId}): ${review.approved ? '批准' : '拒绝'} — ${review.feedback}`;
            break;
          }
          case 'request_shutdown': {
            const input: { agentId: string; reason?: string } = {
              agentId: String(block.input['agentId'] ?? ''),
            };
            if (block.input['reason'] !== undefined) input.reason = String(block.input['reason']);
            const ack = yield* perform({ type: 'RequestShutdown', input });
            output = `关闭确认 (${ack.requestId}): acknowledged=${ack.acknowledged} ← ${ack.responder}`;
            break;
          }
          case 'send_message': {
            const { messageId } = yield* perform({
              type: 'SendMessage',
              input: {
                from: agentId,
                to: String(block.input['to'] ?? ''),
                body: String(block.input['body'] ?? ''),
              },
            });
            output = `消息已发送 (${messageId})`;
            break;
          }
          case 'check_inbox': {
            const input: { agentId: string; waitMs?: number } = { agentId };
            if (block.input['waitMs'] !== undefined) input.waitMs = Number(block.input['waitMs']);
            const msgs = yield* perform({ type: 'CheckInbox', input });
            output = msgs.length
              ? msgs
                  .map((m) => {
                    // 协议响应/请求靠 metadata.request_id 关联，必须让模型看得见。
                    const meta = Object.keys(m.metadata).length > 0 ? ` ${JSON.stringify(m.metadata)}` : '';
                    return `[${m.type}] ${m.from}: ${m.body}${meta}`;
                  })
                  .join('\n')
              : '信箱为空';
            break;
          }
          default:
            output = `[未知工具] ${block.name}`;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: output });
      } catch (err) {
        toolResults.push(toolErrorResult(block.id, err));
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }
}

// ============================================================
// Part 9: 启动入口
// ============================================================

console.log('[S16] Team Protocols 启动');
console.log(`  信箱目录: ${S16_MAILBOX_DIR}`);
console.log(`  模式: ${describeMode()}\n`);

// 顶层运行结果与是否成功；失败也继续做收尾和自检。
let result: string | undefined;
let ok = true;
try {
  result = await runAgent<S16Effect, string>(agentLoop, s16Handlers);
} catch (err) {
  ok = false;
  process.exitCode = 1;
  console.error(
    `[S16] lead 运行失败（${describeMode()}）: ${err instanceof Error ? err.message : String(err)}`,
  );
}

// 收尾：通知仍在空闲等待的队友停止，并给它们一点时间写完结果。
stopTeammates();
// 收尾后仍在运行的队友；只警告，不强制结束。
const remaining = await settleActiveWithin(activeTeammates, CLEANUP_WAIT_MS);
if (remaining.length > 0) {
  console.warn(
    `[S16] 退出前仍有队友在运行: ${remaining.join(', ')}（不会强制结束；如有在途模型请求，进程可能要等它完成）`,
  );
}

console.log('\n[Protocol] 协议请求汇总:');
for (const [id, req] of pendingRequests) {
  console.log(`  ${id}: type=${req.type} ${req.sender}→${req.target} [${req.status}]`);
}

if (teammateFailures.size > 0) {
  ok = false;
  process.exitCode = 1;
  console.error(`[S16] 队友失败: ${[...teammateFailures].join(', ')}`);
}

if (ok && result !== undefined) {
  console.log(`\n[S16] 协议演示结果: ${result}`);
  console.log('[S16] 完成');
} else {
  console.log('[S16] 失败');
}
