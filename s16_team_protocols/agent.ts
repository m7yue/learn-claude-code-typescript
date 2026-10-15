/**
 * s16: Team Protocols — 协议是 Agent 间协作的效应约定
 *
 * 本章机制：
 *   - ProtocolState：一次协议请求的状态（requestId / type / sender / target / status / payload / createdAt）
 *   - pendingRequests：在途协议请求注册表（requestId → ProtocolState）
 *   - matchResponse：按 requestId + 类型双校验，把响应关联回请求
 *   - request_plan / review_plan / request_shutdown：Lead 侧的协议工具（三个 Effect）
 *   - 队友空闲循环：从信箱收发协议消息（shutdown_request / plan_request）
 *   - consumeLeadInbox：统一消费 Lead 信箱，协议响应先路由再回灌历史
 *
 * 本章要点：
 *   - 计划内容由【队友的一次真实 Chat 回合】产生，经 plan_approval_response 信箱消息回流给 Lead；
 *   - review_plan 会校验 request_id 是否为待处理的 plan_approval，并按计划步骤数做真实判定；
 *   - request_shutdown 先登记为待处理，直到收到同 request_id 的 shutdown_response 才落为 approved；
 *   - 队友是 s15 那套真实的 generator + runAgent 子循环，靠 .mailboxes/<agentId>.jsonl 收发，空闲时真轮询。
 *
 * Mock 只替换「模型调用」这一件事：协议状态机、信箱 I/O、request_id 关联全部是真实代码。
 *
 * 路径来自 runtime/workspace.ts（.mailboxes/），锁来自 runtime/locks.ts。
 */

import { runAgent } from '../runtime/core.ts';
import type { Effect, EffectHandlers, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolResultBlock } from '../runtime/types.ts';
import { extractText, getToolUseBlocks } from '../runtime/response.ts';
import { callChat } from '../runtime/model.ts';
import { schemasFor } from '../runtime/tool-schemas.ts';
import { buildSystemPrompt } from '../runtime/system-prompt.ts';
import { MAILBOXES_DIR, WORKSPACE_ROOT } from '../runtime/workspace.ts';
import { Mutex } from '../runtime/locks.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// Part 0: 常量
// ============================================================

const LEAD_ID = 'main';         // 主 Agent 的 mailbox 名
const REVIEWER_ID = 'reviewer'; // 计划审查队友（本仓 spawn_teammate schema 只有 agentId/role）
const MAX_TURNS = 10;           // 队友最多 10 个"工作轮"
const MAX_IDLE = 3000;          // 队友空闲轮询上限（3000 × 5ms ≈ 15s 后主动放弃）
const POLL_MS = 5;              // 空闲/等待轮询间隔
const RESPONSE_TIMEOUT_POLLS = 3000; // 请求方等待协议响应的轮询上限（≈15s）

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

interface ChatEffect extends Effect<'Chat', { messages: Message[]; agentId: string }, LLMResponse> {}

interface BashExecEffect extends Effect<'BashExec', { command: string }, string> {}

interface ReadFileEffect extends Effect<'ReadFile', { path: string; limit?: number }, string> {}

interface WriteFileEffect extends Effect<'WriteFile', { path: string; content: string }, string> {}

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

interface SendMessageEffect
  extends Effect<'SendMessage', { from: string; to: string; body: string; type?: string; metadata?: Record<string, unknown> }, { messageId: string }> {}

interface CheckInboxEffect extends Effect<'CheckInbox', { agentId: string }, AgentMessage[]> {}

// s16 新增：三个协议 Effect
interface RequestPlanEffect
  extends Effect<'RequestPlan', { goal: string; requestId?: string; context?: string }, Plan> {}

interface ReviewPlanEffect
  extends Effect<'ReviewPlan', { requestId: string; reviewerId: string; planText: string }, { approved: boolean; feedback: string }> {}

interface RequestShutdownEffect
  extends Effect<'RequestShutdown', { agentId: string; reason?: string }, { acknowledged: boolean; requestId: string; responder: string }> {}

/** 队友空闲等待信箱（只在队友子循环里用）。 */
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
  | ReviewPlanEffect
  | RequestShutdownEffect
  | IdleEffect;

type PlanStatus = 'pending' | 'approved' | 'rejected';

interface Plan {
  requestId: string;
  goal: string;
  context: string;
  steps: string[];
  status: PlanStatus;
  reviewer?: string;
  feedback?: string;
}

// ============================================================
// Part 2: MessageBus —— 真实的 JSONL 信箱（.mailboxes/*.jsonl）
// ============================================================

// 队友名会拼进信箱文件名，先按白名单校验字符。
const VALID_AGENT_ID = /^[A-Za-z0-9._-]{1,64}$/;

function validateAgentId(agentId: string): void {
  if (agentId === '.' || agentId === '..' || !VALID_AGENT_ID.test(agentId)) {
    throw new Error(`非法队友名: '${agentId}'（只允许字母、数字、点、下划线、短横线，1-64 字符）`);
  }
}

/**
 * 文件消息总线：每个 Agent 一个 `.jsonl` 信箱，一行一条 JSON 消息。
 *   send()       —— 追加一行（真实写文件，可带 metadata）
 *   readInbox()  —— 读出全部消息，然后把文件清空（读完即取走）
 *   requeue()    —— 把这次没处理的消息原样写回（等待协议响应时不丢别的消息）
 *
 * 多个队友会同时读写，因此用 runtime/locks.ts 的 Mutex 加锁：同一时刻只允许一个
 * 操作在追加或读出清空，避免两次写叠在一起把文件写坏。
 */
class MessageBus {
  private readonly mutex = new Mutex();
  private seq = 0;

  constructor() {
    fs.mkdirSync(MAILBOXES_DIR, { recursive: true });
  }

  private inboxPath(agentId: string): string {
    validateAgentId(agentId);
    return path.join(MAILBOXES_DIR, `${agentId}.jsonl`);
  }

  async send(
    from: string,
    to: string,
    body: string,
    type = 'message',
    metadata: Record<string, unknown> = {},
  ): Promise<string> {
    return this.mutex.withLock(() => {
      fs.mkdirSync(MAILBOXES_DIR, { recursive: true });
      const msg: AgentMessage = { from, to, body, type, timestamp: Date.now(), metadata };
      fs.appendFileSync(this.inboxPath(to), JSON.stringify(msg) + '\n', 'utf8');
      const messageId = `msg_${Date.now()}_${++this.seq}`;
      console.log(`  \x1b[33m[bus] ${from} → ${to}: (${type}) ${truncate(body, 50)}\x1b[0m`);
      // 唤醒正在空闲等待的收件队友（没有在等的就忽略；队友那边还会自己轮询）
      signalMailbox(to);
      return messageId;
    });
  }

  async readInbox(agentId: string): Promise<AgentMessage[]> {
    return this.mutex.withLock(() => {
      const p = this.inboxPath(agentId);
      if (!fs.existsSync(p)) return [];
      const msgs = fs
        .readFileSync(p, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as AgentMessage);
      // 读完即取走：读出全部消息后把文件清空为 0 字节，保留目录和文件名（便于看到信箱布局）。
      fs.writeFileSync(p, '', 'utf8');
      return msgs;
    });
  }

  /** 把这次没处理的消息原样写回信箱，保持它们原来的先后顺序。 */
  async requeue(agentId: string, msgs: AgentMessage[]): Promise<void> {
    if (msgs.length === 0) return;
    return this.mutex.withLock(() => {
      fs.mkdirSync(MAILBOXES_DIR, { recursive: true });
      const data = msgs.map((m) => JSON.stringify(m)).join('\n') + '\n';
      fs.appendFileSync(this.inboxPath(agentId), data, 'utf8');
    });
  }
}

const BUS = new MessageBus();

// 空闲队友的唤醒信号：agentId → resolver
const mailboxWaiters = new Map<string, () => void>();

function signalMailbox(agentId: string): void {
  const wake = mailboxWaiters.get(agentId);
  if (wake) {
    mailboxWaiters.delete(agentId);
    wake();
  }
}

function waitForMailbox(agentId: string, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      mailboxWaiters.delete(agentId);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    mailboxWaiters.set(agentId, () => {
      clearTimeout(timer);
      finish();
    });
  });
}

function truncate(text: string, n: number): string {
  return text.length > n ? text.slice(0, n) + '…' : text;
}

// ============================================================
// Part 3: 协议状态机
// ============================================================

type ProtocolType = 'plan_approval' | 'shutdown';
type ProtocolStatus = 'pending' | 'approved' | 'rejected';

interface ProtocolState {
  requestId: string;
  type: ProtocolType; // "shutdown" | "plan_approval"
  sender: string;
  target: string;
  status: ProtocolStatus; // pending | approved | rejected
  payload: string; // plan goal 或 shutdown reason
  createdAt: number;
}

/** 活跃协议请求注册表：requestId → ProtocolState。 */
const pendingRequests = new Map<string, ProtocolState>();

let reqSeq = 0;
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
 * 关联与校验规则：
 *   - 未知 request_id：拒绝并记日志
 *   - 类型不匹配：拒绝并记日志
 *   - 已非 pending（重复响应）：忽略并记日志
 *   - 通过：置 approved / rejected
 */
function matchResponse(responseType: string, requestId: string, approve: boolean): ProtocolState | null {
  const state = pendingRequests.get(requestId);
  if (!state) {
    console.log(`  \x1b[31m[protocol] unknown request_id: ${requestId}\x1b[0m`);
    return null;
  }
  const expected = expectedResponseType(state.type);
  if (responseType !== expected) {
    console.log(`  \x1b[31m[protocol] type mismatch: expected ${expected}, got ${responseType}\x1b[0m`);
    return null;
  }
  if (state.status !== 'pending') {
    console.log(`  \x1b[33m[protocol] ${requestId} already ${state.status}, ignoring duplicate\x1b[0m`);
    return null;
  }
  state.status = approve ? 'approved' : 'rejected';
  const icon = approve ? '✓' : '✗';
  const color = approve ? '32' : '31';
  console.log(`  \x1b[${color}m[protocol] ${state.type} ${icon} (${requestId}: ${state.status})\x1b[0m`);
  return state;
}

// ============================================================
// Part 4: 统一消费 Lead 信箱
// ============================================================

/**
 * 读取 Lead 信箱。协议响应先经 matchResponse 路由，再返回全部消息。
 * check_inbox 工具与主循环共用它，避免消息被消费却没走协议关联。
 */
async function consumeLeadInbox(routeProtocol = true): Promise<AgentMessage[]> {
  const msgs = await BUS.readInbox(LEAD_ID);
  if (msgs.length === 0) return [];
  if (routeProtocol) {
    for (const msg of msgs) {
      const reqId = String(msg.metadata['request_id'] ?? '');
      if (reqId && msg.type.endsWith('_response')) {
        matchResponse(msg.type, reqId, Boolean(msg.metadata['approve']));
      }
    }
  }
  return msgs;
}

/**
 * 请求方（Lead）在限定次数内反复查看自己的信箱，等待与 requestId 完全匹配的响应。
 * 不是目标的消息会原样写回，不会被悄悄丢掉。
 */
async function pollForResponse(
  expectedRequestId: string,
  expectedType: string,
  maxPolls = RESPONSE_TIMEOUT_POLLS,
): Promise<AgentMessage | null> {
  for (let i = 0; i < maxPolls; i += 1) {
    const msgs = await BUS.readInbox(LEAD_ID);
    let matched: AgentMessage | null = null;
    const keep: AgentMessage[] = [];
    for (const msg of msgs) {
      const reqId = String(msg.metadata['request_id'] ?? '');
      const isResponse = reqId.length > 0 && msg.type.endsWith('_response');
      if (isResponse) {
        // 所有响应都过一遍状态机（未知/错类型/重复都会被记录并拒绝）
        matchResponse(msg.type, reqId, Boolean(msg.metadata['approve']));
      }
      if (!matched && isResponse && reqId === expectedRequestId && msg.type === expectedType) {
        matched = msg;
      } else {
        keep.push(msg);
      }
    }
    if (keep.length > 0) await BUS.requeue(LEAD_ID, keep);
    if (matched) return matched;
    await sleep(POLL_MS);
  }
  console.log(`  \x1b[31m[protocol] timeout waiting for ${expectedType} (${expectedRequestId})\x1b[0m`);
  return null;
}

// ============================================================
// Part 5: Mock LLM —— 只替换模型调用
// ============================================================

/** 从已注入的 inbox 消息里提取 request_id —— 证明 id 是经消息真实传递的。 */
function findRequestId(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i].content;
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const m = text.match(/"request_id"\s*:\s*"([^"]+)"/);
    if (m) return m[1];
  }
  return '';
}

/** Lead 剧本：组建团队 → 请求计划（等待审批响应）→ 执行 → 请求关闭（等待确认）→ 查信箱。 */
function mockLead(messages: Message[]): LLMResponse {
  const turn = messages.filter((m) => m.role === 'assistant').length;
  if (turn === 0) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '组建一个计划团队。' },
        { type: 'tool_use', id: 'm1', name: 'spawn_teammate', input: { agentId: REVIEWER_ID, role: '计划审查专家' } },
      ],
    };
  }
  if (turn === 1) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '请求一份执行计划，并等待审批响应（response 必须带同一 request_id）。' },
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
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '执行已批准计划的第一步。' },
        { type: 'tool_use', id: 'm3', name: 'bash', input: { command: 'echo "步骤1: 创建 OAuth 适配器"' } },
      ],
    };
  }
  if (turn === 3) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '任务完成，请求队友关闭并等待其 shutdown_response。' },
        { type: 'tool_use', id: 'm4', name: 'request_shutdown', input: { agentId: REVIEWER_ID, reason: '重构任务已完成' } },
      ],
    };
  }
  if (turn === 4) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '检查收件箱，收尾。' },
        { type: 'tool_use', id: 'm5', name: 'check_inbox', input: {} },
      ],
    };
  }
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '协议流程演示完成：请求计划 → 审批响应 → 执行 → 关闭确认。' }],
  };
}

/**
 * 队友（审查者）剧本：收到 plan_request 后生成计划文本并调用 review_plan 回传；
 * request_id 从注入的 inbox 里真实提取，而不是写死。
 */
function mockReviewer(agentId: string, messages: Message[]): LLMResponse {
  const turn = messages.filter((m) => m.role === 'assistant').length;
  if (turn === 0) {
    const requestId = findRequestId(messages) || 'missing';
    return {
      stop_reason: 'tool_use',
      content: [
        {
          type: 'text',
          text: '拟定执行计划：\n1. 分析现有认证逻辑\n2. 设计 OAuth 2.0 适配器接口\n3. 实现 Token 刷新机制\n4. 添加向后兼容层\n5. 编写集成测试',
        },
        { type: 'tool_use', id: `${agentId}_r1`, name: 'review_plan', input: { requestId, reviewerId: agentId } },
      ],
    };
  }
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '计划审批响应已发送，等待 lead 后续指令。' }],
  };
}

function mockModel(agentId: string, messages: Message[]): LLMResponse {
  return agentId === LEAD_ID ? mockLead(messages) : mockReviewer(agentId, messages);
}

/** real 模式注入的 system prompt；mock 模式不读取，故零配置运行行为不变。 */
const LEAD_SYSTEM_PROMPT = buildSystemPrompt(
  '用 spawn_teammate 组建计划团队；用 request_plan 请求计划并等待带同一 request_id 的审批响应；用 request_shutdown 申请关闭并等待 shutdown_response。每一步都等响应到达再继续，不要跳过协议。' +
    '本教学演示中 bash 是模拟的：只回显命令文本、不会真正执行，请不要依赖它的输出。',
);

function teammateSystemPrompt(agentId: string, role: string): string {
  return `你是 '${agentId}'，一名${role}。收到信箱里的 plan_request 后生成执行计划并调用 review_plan（带上消息里的 request_id）把审批结果回传 lead（它的信箱是 '${LEAD_ID}'）；收到 shutdown_request 后发送 shutdown_response 再退出。本教学演示中 bash 是模拟的：只回显命令文本、不会真正执行，请不要依赖它的输出。`;
}

// ============================================================
// Part 6: 队友子循环 —— 真实 generator + runAgent（复用 s15 模式）
// ============================================================

const activeTeammates = new Map<string, Promise<string>>();
const teammateRoles = new Map<string, string>();

/** 等所有队友运行结束（为了演示结果稳定：等它们结束后再查信箱、再退出）。 */
async function awaitTeammates(): Promise<void> {
  const pending = [...activeTeammates.values()];
  if (pending.length === 0) return;
  await Promise.allSettled(pending);
  activeTeammates.clear();
}

/** 有界等待队友结束，避免队友未收到 shutdown 时把主流程拖死。 */
async function settleTeammatesWithin(ms: number): Promise<void> {
  await Promise.race([awaitTeammates(), sleep(ms)]);
}

/**
 * 队友 Agent 循环：空闲时轮询自己的信箱；收到协议消息后分发：
 *   - shutdown_request  → 回复 shutdown_response（带同一 request_id）并停止
 *   - plan_request      → 注入历史 → 一次真实 Chat 回合 → review_plan 工具 → 审批响应
 */
function* teammateLoop(perform: PerformFn<S16Effect>, agentId: string, role: string) {
  const messages: Message[] = [
    {
      role: 'user',
      content: `你是团队成员 '${agentId}'（${role}）。等待 lead 经信箱发来的 plan_request；收到后生成执行计划并调用 review_plan 回传审批结果。收到 shutdown_request 时发送 shutdown_response 后退出。`,
    },
  ];

  let workTurns = 0;
  let idle = 0;
  let finalText = '';

  while (workTurns < MAX_TURNS) {
    const inbox = yield* perform({ type: 'CheckInbox', input: { agentId } });

    if (inbox.length === 0) {
      idle += 1;
      if (idle > MAX_IDLE) {
        finalText = `(${agentId}) 空闲超时，未收到更多消息`;
        break;
      }
      yield* perform({ type: 'Idle', input: { agentId, ms: POLL_MS } });
      continue;
    }
    idle = 0;

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
      deliverable.push(msg);
    }
    if (shutdown) break;

    if (deliverable.length > 0) {
      messages.push({ role: 'user', content: `<inbox>${JSON.stringify(deliverable)}</inbox>` });
    }

    workTurns += 1;
    const response = yield* perform({ type: 'Chat', input: { messages, agentId } });
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      finalText = extractText(response);
      continue; // 不退出：回到循环空闲等待后续协议消息
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
          case 'review_plan': {
            // 计划内容来自本次真实 Chat 回合的文本；request_id 来自信箱消息。
            const requestId = String(block.input['requestId'] ?? '');
            const reviewerId = String(block.input['reviewerId'] ?? agentId);
            const planText = extractText(response);
            const review = yield* perform({
              type: 'ReviewPlan',
              input: { requestId, reviewerId, planText },
            });
            output = `审查结果 (${requestId}): ${review.approved ? '批准' : '拒绝'} — ${review.feedback}`;
            break;
          }
          default:
            output = `[未知工具] ${block.name}`;
        }
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
  ).catch((err: unknown) => {
    console.log(`  \x1b[31m[teammate] ${agentId} 异常: ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
    return '[teammate error]';
  });
  activeTeammates.set(agentId, promise);
  return promise;
}

// ============================================================
// Part 7: Handler 实现（协议状态机 + 信箱 I/O）
// ============================================================

// 安全路径校验：把参数解析到工作区内；越界（含同前缀的兄弟目录）即抛错。
function safePath(p: string): string {
  const resolved = path.resolve(WORKSPACE_ROOT, p);
  const rel = path.relative(WORKSPACE_ROOT, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`路径越界: ${p}`);
  return resolved;
}

const s16Handlers: EffectHandlers<S16Effect> = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages, agentId } = effect.input;
    const isLead = agentId === LEAD_ID;
    const round = messages.filter((m) => m.role === 'assistant').length + 1;
    console.log(`\n[Chat:${agentId}] → 轮次 ${round}`);
    return callChat((m) => mockModel(agentId, m), messages, {
      tools: isLead
        ? schemasFor('bash', 'spawn_teammate', 'send_message', 'check_inbox', 'request_plan', 'request_shutdown')
        : schemasFor('bash', 'read_file', 'write_file', 'send_message', 'review_plan'),
      system: isLead
        ? LEAD_SYSTEM_PROMPT
        : teammateSystemPrompt(agentId, teammateRoles.get(agentId) ?? '计划审查专家'),
    });
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    console.log(`[BashExec] → ${effect.input.command}`);
    return `(执行: ${effect.input.command})`;
  },

  ReadFile: async (effect: ReadFileEffect): Promise<string> => {
    try {
      const lines = fs.readFileSync(safePath(effect.input.path), 'utf8').split('\n');
      if (effect.input.limit && effect.input.limit < lines.length) {
        return [...lines.slice(0, effect.input.limit), `... (${lines.length - effect.input.limit} more lines)`].join('\n');
      }
      return lines.join('\n');
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  WriteFile: async (effect: WriteFileEffect): Promise<string> => {
    try {
      const target = safePath(effect.input.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, effect.input.content, 'utf8');
      return `Wrote ${effect.input.content.length} bytes to ${effect.input.path}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  SpawnTeammate: async (effect: SpawnTeammateEffect): Promise<{ agentId: string; status: 'spawned' }> => {
    const { agentId, role } = effect.input;
    if (activeTeammates.has(agentId)) {
      console.log(`[SpawnTeammate] ${agentId} 已存在`);
      return { agentId, status: 'spawned' };
    }
    teammateRoles.set(agentId, role);
    console.log(`\x1b[36m[SpawnTeammate] 生成: ${agentId} (${role})\x1b[0m`);
    startTeammate(agentId, role);
    // 让队友先跑到第一个 Idle await（注册唤醒信号），主流程再继续派协议请求。
    await new Promise((r) => setTimeout(r, 0));
    return { agentId, status: 'spawned' };
  },

  SendMessage: async (effect: SendMessageEffect): Promise<{ messageId: string }> => {
    const { from, to, body, type, metadata } = effect.input;
    const messageId = await BUS.send(from, to, body, type ?? 'message', metadata ?? {});
    return { messageId };
  },

  CheckInbox: async (effect: CheckInboxEffect): Promise<AgentMessage[]> => {
    const { agentId } = effect.input;
    let msgs: AgentMessage[];
    if (agentId === LEAD_ID) {
      // 在限定时间内等队友结束，保证他们的回信已经写进信箱（演示结果才稳定），又不会一直拖住主流程。
      await settleTeammatesWithin(500);
      msgs = await consumeLeadInbox(true);
    } else {
      msgs = await BUS.readInbox(agentId);
    }
    console.log(`[CheckInbox:${agentId}] 收到 ${msgs.length} 条消息`);
    msgs.forEach((m) => console.log(`  ✉ [${m.type}] ${m.from}: ${truncate(m.body, 80)}`));
    return msgs;
  },

  RequestPlan: async (effect: RequestPlanEffect): Promise<Plan> => {
    const requestId = (effect.input.requestId ?? '').trim() || newRequestId('plan');
    const { goal } = effect.input;
    const context = effect.input.context ?? '';

    // 注册 pending 协议请求（等待与 requestId 匹配的 plan_approval_response）
    pendingRequests.set(requestId, {
      requestId,
      type: 'plan_approval',
      sender: LEAD_ID,
      target: REVIEWER_ID,
      status: 'pending',
      payload: goal,
      createdAt: Date.now(),
    });
    console.log(`[RequestPlan] requestId=${requestId} → "${goal}"`);
    console.log(`  协议注册: ${requestId} (type=plan_approval, pending)`);

    const ask = context ? `请为下列目标提交一份执行计划：${goal}\n背景：${context}` : `请为下列目标提交一份执行计划：${goal}`;
    await BUS.send(LEAD_ID, REVIEWER_ID, ask, 'plan_request', { request_id: requestId });

    const resp = await pollForResponse(requestId, 'plan_approval_response');
    if (!resp) {
      return { requestId, goal, context, steps: [], status: 'rejected', feedback: '等待审批响应超时' };
    }

    const approved = Boolean(resp.metadata['approve']);
    const steps = resp.body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^\d+[.)、]/.test(l));
    const feedback = String(resp.metadata['feedback'] ?? (approved ? '批准' : '拒绝'));
    const plan: Plan = {
      requestId,
      goal,
      context,
      steps,
      status: approved ? 'approved' : 'rejected',
      reviewer: String(resp.metadata['reviewer'] ?? REVIEWER_ID),
      feedback,
    };
    console.log(`  收到 ${resp.type} ← ${resp.from}，已 match_response 关联到 ${requestId} (${plan.status})`);
    if (steps.length > 0) {
      console.log(`  批准的计划 (${steps.length} 步):`);
      steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.replace(/^\d+[.)、]\s*/, '')}`));
    }
    return plan;
  },

  ReviewPlan: async (effect: ReviewPlanEffect): Promise<{ approved: boolean; feedback: string }> => {
    const { requestId, reviewerId, planText } = effect.input;
    const state = pendingRequests.get(requestId);
    if (!state) {
      console.log(`[ReviewPlan] 警告: requestId=${requestId} 无对应待审请求，拒绝`);
      return { approved: false, feedback: '未找到对应的计划请求' };
    }
    if (state.type !== 'plan_approval' || state.status !== 'pending') {
      console.log(`[ReviewPlan] 警告: ${requestId} 当前 type=${state.type} status=${state.status}，拒绝重复/错类型审批`);
      return { approved: false, feedback: `请求不可审 (${state.status})` };
    }

    // 真实判定：按计划文本的有效步骤数决定批准与否（不再「恒批准」）。
    const stepLines = planText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^\d+[.)、]/.test(l));
    const approved = stepLines.length >= 3;
    const feedback = approved
      ? `计划含 ${stepLines.length} 个步骤，步骤清晰，批准执行`
      : `计划仅 ${stepLines.length} 个有效步骤，要求补充后再提交`;

    console.log(`[ReviewPlan] requestId=${requestId} reviewerId=${reviewerId}`);
    console.log(`  校验: 请求存在且 pending (type=${state.type})`);
    console.log(`  决定: ${approved ? '✓ 批准' : '✗ 拒绝'} — ${feedback}`);
    console.log(`  发送 plan_approval_response → ${state.sender}（由其 match_response 关联）`);

    await BUS.send(reviewerId, state.sender, planText, 'plan_approval_response', {
      request_id: requestId,
      approve: approved,
      feedback,
      reviewer: reviewerId,
    });
    // 状态落定由请求方（lead）侧的 match_response 完成，避免双方重复置位。
    return { approved, feedback };
  },

  RequestShutdown: async (effect: RequestShutdownEffect): Promise<{ acknowledged: boolean; requestId: string; responder: string }> => {
    const { agentId } = effect.input;
    const reason = effect.input.reason ?? '';
    const requestId = newRequestId('shutdown');

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

    await BUS.send(LEAD_ID, agentId, reason ? `请优雅关闭：${reason}` : '请优雅关闭。', 'shutdown_request', {
      request_id: requestId,
    });
    console.log(`  协议注册: ${requestId} (type=shutdown, pending)，等待 shutdown_response...`);

    const resp = await pollForResponse(requestId, 'shutdown_response');
    if (!resp) {
      return { acknowledged: false, requestId, responder: agentId };
    }
    return {
      acknowledged: Boolean(resp.metadata['approve']),
      requestId,
      responder: resp.from,
    };
  },

  Idle: async (effect: IdleEffect): Promise<void> => {
    await waitForMailbox(effect.input.agentId, effect.input.ms);
  },
};

// ============================================================
// Part 8: 主 Agent Generator（agentId = 'main'）
// ============================================================

function* agentLoop(perform: PerformFn<S16Effect>) {
  const agentId = LEAD_ID;
  const messages: Message[] = [
    { role: 'user', content: '使用团队协议完成认证模块重构：请求计划、等待审批、执行、请求关闭。' },
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
            const input: { goal: string; requestId?: string; context?: string } = {
              goal: String(block.input['goal'] ?? ''),
            };
            if (block.input['requestId'] !== undefined) input.requestId = String(block.input['requestId']);
            if (block.input['context'] !== undefined) input.context = String(block.input['context']);
            const plan = yield* perform({ type: 'RequestPlan', input });
            output = `计划 ${plan.requestId} [${plan.status}] (${plan.steps.length} 步)${plan.feedback ? ` — ${plan.feedback}` : ''}`;
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
            const msgs = yield* perform({ type: 'CheckInbox', input: { agentId } });
            output = msgs.length ? msgs.map((m) => `[${m.type}] ${m.from}: ${m.body}`).join('\n') : '信箱为空';
            break;
          }
          default:
            output = `[未知工具] ${block.name}`;
        }
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
// Part 9: 启动入口
// ============================================================

fs.mkdirSync(MAILBOXES_DIR, { recursive: true });

console.log('[S16] Team Protocols 启动');
console.log(`  信箱目录: ${MAILBOXES_DIR}\n`);

const result = await runAgent<S16Effect, string>(agentLoop, s16Handlers);

// 收尾：确保所有队友子循环已结束
await awaitTeammates();

console.log('\n[Protocol] 协议请求汇总:');
for (const [id, req] of pendingRequests) {
  console.log(`  ${id}: type=${req.type} ${req.sender}→${req.target} [${req.status}]`);
}

// 负向自检：证明未知 / 类型不匹配 / 重复的响应会被拒绝并记录，而非被静默接受。
console.log('\n[Protocol] 负向自检 (match_response 拒绝孤立/错类型/重复响应):');
matchResponse('plan_approval_response', 'req_does_not_exist', true); // 未知 request_id
const probeId = 'req_probe';
pendingRequests.set(probeId, {
  requestId: probeId,
  type: 'shutdown',
  sender: LEAD_ID,
  target: REVIEWER_ID,
  status: 'pending',
  payload: '',
  createdAt: Date.now(),
});
matchResponse('plan_approval_response', probeId, true); // 类型不匹配（shutdown 请求收到 plan 响应）
matchResponse('shutdown_response', probeId, false); // 匹配 → rejected
matchResponse('shutdown_response', probeId, true); // 重复 → 忽略
pendingRequests.delete(probeId);

console.log(`\n[S16] 协议演示结果: ${result}`);
console.log('[S16] 完成');
