/**
 * s15: Agent Teams — 消息总线 + 真实的队友子循环
 *
 * 本章新增 3 个团队 Effect + 1 个内部等待 Effect：
 *   SpawnTeammate    — 拉起一个真实队友，并把任务写进它的第一条用户消息
 *   SendMessage      — 向目标信箱追加一条 JSONL 消息（真实文件 I/O）
 *   CheckInbox       — 读取并清空自己的信箱（非阻塞，读后即消费）
 *   WaitForTeammates — lead 在回合结束时等待活跃队友（内部用，不暴露给模型）
 *
 * 队友是真正跑自己循环的独立 Agent：独立 messages、独立 generator，由同一个 runAgent 驱动：
 *   - spawn 时任务作为第一条 user message，队友立即开工
 *   - 工作期间每轮读一次自己的信箱，接收 lead 的后续消息
 *   - 最多跑 MAX_TURNS(=10) 个工作轮
 *   - 结束后把最终摘要写回 lead 的信箱，然后退出
 *
 * lead 的收信方式：
 *   - check_inbox 工具只读当前信箱，不等待
 *   - 每轮 end_turn 后，宿主等待活跃队友（有超时），把新结果作为 [Inbox] 注入对话
 *
 * Mock 只替换「模型调用」这一件事：teammate loop、信箱读写、任务分发全部是真实代码。
 * bash 在本章仍是模拟执行（全仓约定）。
 */

import { runAgent } from '../runtime/core.ts';
import type { Effect, EffectHandlers, PerformFn } from '../runtime/core.ts';
import { callChat } from '../runtime/model.ts';
import type { ToolSchema } from '../runtime/model.ts';
import type { Message, LLMResponse, ToolResultBlock } from '../runtime/types.ts';
import { extractText, getToolUseBlocks, toolErrorResult } from '../runtime/response.ts';
import { schemasFor } from '../runtime/tool-schemas.ts';
import { buildSystemPrompt } from '../runtime/system-prompt.ts';
import { MAILBOXES_DIR, WORKSPACE_ROOT } from '../runtime/workspace.ts';
import { describeMode, loadEnvOnce, resolveMode } from '../runtime/env.ts';
import { settleActiveWithin } from '../runtime/wait.ts';
import { resolveWithin } from '../runtime/paths.ts';
import { truncate } from '../runtime/text.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// Part 0: 常量
// ============================================================

const LEAD_ID = 'main';               // 主 Agent 的 mailbox 名
const MAX_TURNS = 10;                 // 教学版：队友最多 10 个「工作轮」
const MAX_END_TURN_DRAINS = 3;        // end_turn 后最多再注入几轮队友结果

// 先加载 .env：--real/--mock 时 resolveMode 会提前返回，不会代为加载。
loadEnvOnce();

const MODE = resolveMode();
const MAX_TOKENS = Number(process.env.S15_MAX_TOKENS) || 4096;
const JOIN_TIMEOUT_MS =
  Number(process.env.S15_JOIN_TIMEOUT_MS) || (MODE === 'real' ? 90_000 : 5_000);
// 演示脚本退出前的收尾等待：runAgent 返回后，最多再等这么久，
// 让仍在运行的队友有机会把结果写完；这不是 CC 的关机协议。
const CLEANUP_WAIT_MS =
  Number(process.env.S15_CLEANUP_WAIT_MS) || (MODE === 'real' ? 3_000 : 1_000);

// 本章自己的信箱目录：不和 s16/s17/s20 共享同一层。
const S15_MAILBOX_DIR = path.join(MAILBOXES_DIR, 's15');

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

interface ChatEffect
  extends Effect<'Chat', { messages: Message[]; agentId: string; role?: string }, LLMResponse> {}

interface BashExecEffect extends Effect<'BashExec', { command: string }, string> {}

interface ReadFileEffect extends Effect<'ReadFile', { path: string; limit?: number }, string> {}

interface WriteFileEffect extends Effect<'WriteFile', { path: string; content: string }, string> {}

/** 一条信箱消息的结构：from / to / body / type / timestamp。 */
export interface AgentMessage {
  from: string;
  to: string;
  body: string;
  type: string;
  timestamp: number;
}

// s15 新增：团队消息总线
interface SpawnTeammateEffect
  extends Effect<'SpawnTeammate', { agentId: string; role: string; prompt: string }, { agentId: string; status: 'spawned' }> {}

interface SendMessageEffect
  extends Effect<'SendMessage', { from: string; to: string; body: string; kind?: string }, { messageId: string }> {}

interface CheckInboxEffect extends Effect<'CheckInbox', { agentId: string }, AgentMessage[]> {}

/** lead 在 end_turn 后等活跃队友；返回超时后仍在运行的 agentId。 */
interface WaitForTeammatesEffect
  extends Effect<'WaitForTeammates', { timeoutMs: number }, string[]> {}

type S15Effect =
  | ChatEffect
  | BashExecEffect
  | ReadFileEffect
  | WriteFileEffect
  | SpawnTeammateEffect
  | SendMessageEffect
  | CheckInboxEffect
  | WaitForTeammatesEffect;

// ============================================================
// Part 2: MessageBus —— 真实的 JSONL 信箱（.mailboxes/s15/*.jsonl）
// ============================================================

// 队友名会拼进信箱文件名，先按白名单校验字符。
const VALID_AGENT_ID = /^[A-Za-z0-9._-]{1,64}$/;

function validateAgentId(agentId: string): void {
  if (agentId === '.' || agentId === '..' || !VALID_AGENT_ID.test(agentId)) {
    throw new Error(`非法队友名: '${agentId}'（只允许字母、数字、点、下划线、短横线，1-64 字符）`);
  }
}

function resetS15MailboxDir(): void {
  fs.rmSync(S15_MAILBOX_DIR, { recursive: true, force: true });
  fs.mkdirSync(S15_MAILBOX_DIR, { recursive: true });
}

/**
 * 文件消息总线：每个 Agent 一个 `.jsonl` 信箱，一行一条 JSON 消息。
 *   send()       —— 追加一行（真实写文件）
 *   readInbox()  —— 读出全部消息，然后把文件清空（读完即取走）
 */
class MessageBus {
  private seq = 0;

  constructor() {
    resetS15MailboxDir();
  }

  private inboxPath(agentId: string): string {
    validateAgentId(agentId);
    return path.join(S15_MAILBOX_DIR, `${agentId}.jsonl`);
  }

  /** 预先创建空信箱文件，方便在目录里看到完整布局。 */
  ensureInbox(agentId: string): void {
    const p = this.inboxPath(agentId);
    if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf8');
  }

  /** 清空信箱；同名队友重新 spawn 时丢弃上一次运行留下的消息。 */
  clearInbox(agentId: string): void {
    fs.mkdirSync(S15_MAILBOX_DIR, { recursive: true });
    fs.writeFileSync(this.inboxPath(agentId), '', 'utf8');
  }

  async send(from: string, to: string, body: string, type = 'message'): Promise<string> {
    validateAgentId(from);
    const inbox = this.inboxPath(to);
    fs.mkdirSync(S15_MAILBOX_DIR, { recursive: true });
    const msg: AgentMessage = { from, to, body, type, timestamp: Date.now() };
    fs.appendFileSync(inbox, JSON.stringify(msg) + '\n', 'utf8');
    const messageId = `msg_${Date.now()}_${++this.seq}`;
    console.log(`  \x1b[33m[bus] ${from} → ${to}: ${truncate(body, 50)}\x1b[0m`);
    return messageId;
  }

  async readInbox(agentId: string): Promise<AgentMessage[]> {
    const p = this.inboxPath(agentId);
    if (!fs.existsSync(p)) return [];
    const msgs: AgentMessage[] = [];
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        msgs.push(JSON.parse(line) as AgentMessage);
      } catch {
        console.warn(`[bus] 忽略损坏的信箱行: ${truncate(line, 80)}`);
      }
    }
    // 消费式读取：读出全部消息后把文件清空为 0 字节。
    fs.writeFileSync(p, '', 'utf8');
    return msgs;
  }
}

const BUS = new MessageBus();
BUS.ensureInbox(LEAD_ID);

function formatInbox(messages: AgentMessage[]): string {
  return messages.map((m) => `From ${m.from}: ${m.body}`).join('\n');
}

/** 从对话里找最后一次宿主注入的 [Inbox] 内容（mock lead 汇总用）。 */
function lastInboxText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i].content;
    if (typeof content === 'string' && content.startsWith('[Inbox]')) return content;
  }
  return '';
}

// ============================================================
// Part 3: 本章模型看到的工具 schema
// ============================================================

// 只在本章收紧共享 schema，不修改 runtime/tool-schemas.ts。
const BASH_SCHEMA: ToolSchema = (() => {
  const base = schemasFor('bash')[0];
  return {
    ...base,
    description: '模拟执行一条 shell 命令；只回显命令文本，不会真正执行。',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string', description: '要执行的命令' } },
      required: ['command'],
    },
  };
})();

const SPAWN_TEAMMATE_SCHEMA: ToolSchema = (() => {
  const base = schemasFor('spawn_teammate')[0];
  return {
    ...base,
    description: '创建并立即启动一个队友；prompt 是它要执行的任务。队友完成一个任务后退出。',
    input_schema: {
      ...base.input_schema,
      properties: {
        ...(base.input_schema.properties ?? {}),
        prompt: { type: 'string', description: '队友立即执行的任务' },
      },
      required: [...(base.input_schema.required ?? []), 'prompt'],
    },
  };
})();

const CHECK_INBOX_SCHEMA: ToolSchema = (() => {
  const base = schemasFor('check_inbox')[0];
  return {
    ...base,
    description: '查看 lead 自己的信箱；不等待。队友结果也会在回合结束时自动注入。',
    input_schema: { type: 'object', properties: {}, required: [] },
  };
})();

const LEAD_TOOLS: ToolSchema[] = [
  SPAWN_TEAMMATE_SCHEMA,
  BASH_SCHEMA,
  ...schemasFor('read_file', 'send_message'),
  CHECK_INBOX_SCHEMA,
];

const TEAMMATE_TOOLS: ToolSchema[] = [
  BASH_SCHEMA,
  ...schemasFor('read_file', 'write_file', 'send_message'),
];

// ============================================================
// Part 4: 演示样例 + Mock LLM
// ============================================================

// 队友读自己的小样例，而不是把 runtime/ 或本章 agent.ts 塞进上下文。
const DEMO_OUTPUT_DIR = path.join(WORKSPACE_ROOT, 's15_agent_teams', '.output');
const ANALYZER_SAMPLE = 's15_agent_teams/.output/analyzer_sample.ts';
const REVIEWER_SAMPLE = 's15_agent_teams/.output/reviewer_sample.ts';

const ANALYZER_SAMPLE_CONTENT = `interface OrderItem {
  price: number;
  quantity: number;
}

interface Order {
  status: 'paid' | 'refunded' | 'pending';
  items: OrderItem[];
}

interface Summary {
  total: number;
  flagged: number;
}

export function summarizeOrders(orders: Order[]): Summary {
  let total = 0;
  let flagged = 0;
  for (const order of orders) {
    if (order.status === 'paid') {
      for (const item of order.items) {
        if (item.quantity > 0) {
          total += item.price * item.quantity;
          if (item.price > 100) flagged += 1;
        }
      }
    } else if (order.status === 'refunded') {
      total -= order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    }
  }
  return { total, flagged };
}

export function countLargeOrders(orders: Order[], threshold: number): number {
  let count = 0;
  for (const order of orders) {
    let amount = 0;
    for (const item of order.items) {
      amount += item.price * item.quantity;
    }
    if (amount > threshold) count += 1;
  }
  return count;
}

export function topStatus(orders: Order[]): string {
  const counts: Record<string, number> = {};
  for (const order of orders) {
    counts[order.status] = (counts[order.status] ?? 0) + 1;
  }
  let best = 'none';
  let bestCount = -1;
  for (const [status, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = status;
      bestCount = count;
    }
  }
  return best;
}
`;

const REVIEWER_SAMPLE_CONTENT = `export function average(values: number[]): number {
  let sum = 0;
  for (let i = 0; i <= values.length; i += 1) {
    sum += values[i];
  }
  return sum / values.length;
}

export function parseLimit(raw: string): number {
  return Number(raw);
}

export function formatUser(name: string, age: number) {
  const label = age >= 18 ? 'adult' : 'minor';
  return { name, label };
}
`;

function ensureDemoSamples(): void {
  fs.mkdirSync(DEMO_OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE_ROOT, ANALYZER_SAMPLE), ANALYZER_SAMPLE_CONTENT, 'utf8');
  fs.writeFileSync(path.join(WORKSPACE_ROOT, REVIEWER_SAMPLE), REVIEWER_SAMPLE_CONTENT, 'utf8');
  console.log(`[准备] 已生成样例: ${ANALYZER_SAMPLE}, ${REVIEWER_SAMPLE}`);
}

const TEAMMATE_REPLIES: Record<string, string> = {
  analyzer: '分析完成：analyzer_sample.ts 结构清晰，建议关注 3 个高复杂函数',
  reviewer: '审查完成：reviewer_sample.ts 发现 2 处潜在问题，已标记',
};

const TEAMMATE_TARGETS: Record<string, string> = {
  analyzer: ANALYZER_SAMPLE,
  reviewer: REVIEWER_SAMPLE,
};

/** lead 的剧本：spawn（带任务）→ 等队友结果自动注入 → 汇总。 */
function mockLead(messages: Message[]): LLMResponse {
  const turn = messages.filter((m) => m.role === 'assistant').length;
  if (turn === 0) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '组建分析团队，并把任务直接写进 spawn 的 prompt。' },
        {
          type: 'tool_use',
          id: 'm1',
          name: 'spawn_teammate',
          input: {
            agentId: 'analyzer',
            role: '代码分析专家',
            prompt: `阅读 ${ANALYZER_SAMPLE}，分析代码复杂度，给出 3 个高复杂函数。`,
          },
        },
        {
          type: 'tool_use',
          id: 'm2',
          name: 'spawn_teammate',
          input: {
            agentId: 'reviewer',
            role: '代码审查专家',
            prompt: `审查 ${REVIEWER_SAMPLE} 的代码质量，列出 2 个潜在问题。`,
          },
        },
      ],
    };
  }

  const inboxText = lastInboxText(messages);
  if (inboxText) {
    return {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: `团队协作完成：\n${inboxText}` }],
    };
  }
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '等待队友结果。' }],
  };
}

/** 队友剧本：第 1 轮调工具干活，第 2 轮给出结果文本。 */
function mockTeammate(agentId: string, messages: Message[]): LLMResponse {
  const turn = messages.filter((m) => m.role === 'assistant').length;
  const target = TEAMMATE_TARGETS[agentId] ?? '工作区';
  if (turn === 0) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: `${agentId} 收到任务，开始处理。` },
        {
          type: 'tool_use',
          id: `${agentId}_t1`,
          name: 'read_file',
          input: { path: target, limit: 80 },
        },
      ],
    };
  }
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: TEAMMATE_REPLIES[agentId] ?? '任务完成' }],
  };
}

function mockModel(agentId: string, messages: Message[]): LLMResponse {
  return agentId === LEAD_ID ? mockLead(messages) : mockTeammate(agentId, messages);
}

// ============================================================
// Part 5: 队友子循环 —— 真实 generator + runAgent
// ============================================================

// 活跃队友：agentId → 它那一轮运行的 Promise。promise 结束时按身份移除。
const activeTeammates = new Map<string, Promise<string>>();
// 队友失败会影响退出码；不要让 lead 的最终文本掩盖队友异常。
const teammateFailures = new Set<string>();

/** 拉起一个队友：启动子循环，再把真实 promise 登记到 activeTeammates。 */
function startTeammate(agentId: string, role: string, prompt: string): Promise<string> {
  const promise = runAgent<S15Effect, string>(
    (perform) => teammateLoop(perform, agentId, role, prompt),
    s15Handlers,
  )
    .catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      teammateFailures.add(agentId);
      // 立刻设置退出码：cleanup 超时之后才失败的队友，可能赶不上最后的统一检查。
      process.exitCode = 1;
      console.log(`  \x1b[31m[teammate] ${agentId} 异常: ${message}\x1b[0m`);
      if (err instanceof Error && err.stack) console.log(err.stack);
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
      }
    });

  activeTeammates.set(agentId, promise);
  return promise;
}

/**
 * 队友 Agent 循环（独立 messages / 独立 generator，由 runAgent 驱动）。
 * 任务在 spawn 时已经放在第一条 user message 里，队友立即开工；
 * 工作期间每轮读一次自己的信箱，接收 lead 的后续消息。
 */
function* teammateLoop(
  perform: PerformFn<S15Effect>,
  agentId: string,
  role: string,
  prompt: string,
) {
  const messages: Message[] = [{ role: 'user', content: prompt }];
  let workTurns = 0;
  let finalText = '';
  let hitMaxTurns = true;

  while (workTurns < MAX_TURNS) {
    const inbox = yield* perform({ type: 'CheckInbox', input: { agentId } });
    if (inbox.length > 0) {
      messages.push({ role: 'user', content: `<inbox>${JSON.stringify(inbox)}</inbox>` });
    }

    workTurns += 1;
    const response = yield* perform({ type: 'Chat', input: { messages, agentId, role } });
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      finalText = extractText(response);
      hitMaxTurns = false;
      break;
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
            output = yield* perform({
              type: 'ReadFile',
              input: { path: String(block.input['path'] ?? ''), ...(limit ? { limit: Number(limit) } : {}) },
            });
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

  // 子循环结束前把最终摘要作为 'result' 消息发给 lead
  const summary = finalText || (hitMaxTurns
    ? `(${agentId}) 达到最大轮次 ${MAX_TURNS}，任务可能未完成`
    : 'Done.');
  yield* perform({ type: 'SendMessage', input: { from: agentId, to: LEAD_ID, body: summary, kind: 'result' } });
  console.log(`  \x1b[32m[teammate] ${agentId} finished\x1b[0m`);
  return summary;
}

// ============================================================
// Part 6: System prompts
// ============================================================

const LEAD_SYSTEM_PROMPT = buildSystemPrompt(
  '使用 spawn_teammate / send_message / check_inbox / read_file 与队友协作。' +
    'spawn_teammate 时必须把任务写进 prompt，队友会立即开工；每名队友完成一个任务后退出，需要后续工作请重新 spawn。' +
    '队友退出后不能再收到 send_message；如果结果不完整或需要继续追问，请重新 spawn 一个新队友。' +
    '队友结果会在回合结束时自动注入；也可以用 check_inbox 主动查看，但它不等待。' +
    '目标必须是运行中的队友；main 是保留名。需要自己核对文件时用 read_file。' +
    '本教学演示中 bash 是模拟的：只回显命令文本、不会真正执行，请不要依赖它的输出。',
);

function teammateSystemPrompt(agentId: string, role: string): string {
  return `你是 '${agentId}'，一名${role}。第一条用户消息就是你的任务。用 read_file 等工具完成任务；需要中途同步进展时用 send_message 发给 '${LEAD_ID}'。最终结果由运行时在任务结束时回传，不要再用 send_message 重复发送最终结果。本教学演示中 bash 是模拟的：只回显命令文本、不会真正执行，请不要依赖它的输出。`;
}

// 安全路径校验：把参数解析到工作区内；越界（含同前缀的兄弟目录）即抛错。
function safePath(p: string): string {
  return resolveWithin(WORKSPACE_ROOT, p);
}

// ============================================================
// Part 7: Handler 实现（主 Agent 与队友共用）
// ============================================================

const s15Handlers: EffectHandlers<S15Effect> = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages, agentId } = effect.input;
    const round = messages.filter((m) => m.role === 'assistant').length + 1;
    console.log(`\n[Chat:${agentId}] → 轮次 ${round}`);
    const isLead = agentId === LEAD_ID;
    const system = isLead
      ? LEAD_SYSTEM_PROMPT
      : teammateSystemPrompt(agentId, effect.input.role ?? '队友');
    return callChat((m) => mockModel(agentId, m), messages, {
      tools: isLead ? LEAD_TOOLS : TEAMMATE_TOOLS,
      system,
      maxTokens: MAX_TOKENS,
    });
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    console.log(`[BashExec] → ${effect.input.command}`);
    // 教学演示：只模拟执行，不真正 fork 进程（与其余章节一致）
    return `(执行: ${effect.input.command})`;
  },

  ReadFile: async (effect: ReadFileEffect): Promise<string> => {
    // 错误交给外层派发统一转成 is_error 的 tool_result；不要在 handler 内吞掉。
    const lines = fs.readFileSync(safePath(effect.input.path), 'utf8').split('\n');
    if (effect.input.limit && effect.input.limit < lines.length) {
      return [...lines.slice(0, effect.input.limit), `... (${lines.length - effect.input.limit} more lines)`].join('\n');
    }
    return lines.join('\n');
  },

  WriteFile: async (effect: WriteFileEffect): Promise<string> => {
    const target = safePath(effect.input.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, effect.input.content, 'utf8');
    return `Wrote ${effect.input.content.length} bytes to ${effect.input.path}`;
  },

  SpawnTeammate: async (effect: SpawnTeammateEffect): Promise<{ agentId: string; status: 'spawned' }> => {
    const { agentId, role, prompt } = effect.input;
    validateAgentId(agentId);
    if (agentId === LEAD_ID) throw new Error(`'${LEAD_ID}' 是主 Agent 的保留名`);
    if (!role.trim()) throw new Error('role 不能为空');
    if (!prompt.trim()) throw new Error('prompt 不能为空');
    if (activeTeammates.has(agentId)) throw new Error(`队友 '${agentId}' 仍在运行`);

    BUS.ensureInbox(agentId);
    // 同名队友可能是重新 spawn：上一条 result/后续消息不该被新实例读到。
    BUS.clearInbox(agentId);
    console.log(`\x1b[36m[SpawnTeammate] 生成: ${agentId} (${role})\x1b[0m`);
    startTeammate(agentId, role, prompt);
    return { agentId, status: 'spawned' };
  },

  SendMessage: async (effect: SendMessageEffect): Promise<{ messageId: string }> => {
    const { from, to, body, kind } = effect.input;
    if (from === LEAD_ID && to === LEAD_ID) throw new Error('lead 不能给自己发消息');
    if (to !== LEAD_ID && !activeTeammates.has(to)) {
      throw new Error(`没有运行中的队友 '${to}'，请先 spawn_teammate`);
    }
    const messageId = await BUS.send(from, to, body, kind ?? 'message');
    return { messageId };
  },

  CheckInbox: async (effect: CheckInboxEffect): Promise<AgentMessage[]> => {
    const { agentId } = effect.input;
    const msgs = await BUS.readInbox(agentId);
    // 队友空闲时每轮都会读一次；只打印 lead 或真有消息的读取，避免刷屏。
    if (agentId === LEAD_ID || msgs.length > 0) {
      console.log(`[CheckInbox:${agentId}] 收到 ${msgs.length} 条消息`);
      msgs.forEach((m) => console.log(`  ✉ from ${m.from}: ${truncate(m.body, 80)}`));
    }
    return msgs;
  },

  WaitForTeammates: async (effect: WaitForTeammatesEffect): Promise<string[]> => {
    return settleActiveWithin(activeTeammates, effect.input.timeoutMs);
  },
};

// ============================================================
// Part 8: 主 Agent Generator（agentId = 'main'）
// ============================================================

function* agentLoop(perform: PerformFn<S15Effect>) {
  const messages: Message[] = [
    {
      role: 'user',
      content: `组建 analyzer 和 reviewer 两名队友：analyzer 阅读 ${ANALYZER_SAMPLE} 并分析代码复杂度，reviewer 审查 ${REVIEWER_SAMPLE} 的代码质量。汇总两份结果。`,
    },
  ];
  let drains = 0;

  while (true) {
    const response = yield* perform({ type: 'Chat', input: { messages, agentId: LEAD_ID } });
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      // 主循环结束后收一次 lead 信箱。单次运行里最多等 JOIN_TIMEOUT_MS，
      // 等活跃队友结束，避免演示还没收到结果就退出。
      if (drains < MAX_END_TURN_DRAINS) {
        const timedOut = yield* perform({
          type: 'WaitForTeammates',
          input: { timeoutMs: JOIN_TIMEOUT_MS },
        });
        const inbox = yield* perform({ type: 'CheckInbox', input: { agentId: LEAD_ID } });
        if (inbox.length > 0) {
          messages.push({ role: 'user', content: `[Inbox]\n${formatInbox(inbox)}` });
          console.log(`[inject inbox] ${inbox.length} 条`);
          drains += 1;
          continue;
        }
        if (timedOut.length > 0) {
          console.log(`[inject inbox] 等待超时，仍在运行: ${timedOut.join(', ')}`);
        }
      }
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
          case 'read_file': {
            const limit = block.input['limit'];
            output = yield* perform({
              type: 'ReadFile',
              input: { path: String(block.input['path'] ?? ''), ...(limit ? { limit: Number(limit) } : {}) },
            });
            break;
          }
          case 'spawn_teammate': {
            const { agentId: spawnedId } = yield* perform({
              type: 'SpawnTeammate',
              input: {
                agentId: String(block.input['agentId'] ?? ''),
                role: String(block.input['role'] ?? ''),
                prompt: String(block.input['prompt'] ?? ''),
              },
            });
            output = `队友已创建并开始执行: ${spawnedId}`;
            break;
          }
          case 'send_message': {
            const { messageId } = yield* perform({
              type: 'SendMessage',
              input: {
                from: LEAD_ID,
                to: String(block.input['to'] ?? ''),
                body: String(block.input['body'] ?? ''),
              },
            });
            output = `消息已发送 (${messageId})`;
            break;
          }
          case 'check_inbox': {
            const msgs = yield* perform({ type: 'CheckInbox', input: { agentId: LEAD_ID } });
            output = msgs.length ? formatInbox(msgs) : '信箱为空';
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

ensureDemoSamples();

console.log('[S15] Agent Teams 启动');
console.log(`  信箱目录: ${S15_MAILBOX_DIR}`);
console.log(`  样例目录: ${DEMO_OUTPUT_DIR}`);
console.log(`  模式: ${describeMode()}\n`);

let result: string | undefined;
try {
  result = await runAgent<S15Effect, string>(agentLoop, s15Handlers);
} catch (err) {
  console.error(
    `[S15] lead 运行失败（${describeMode()}）: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 1;
} finally {
  const remaining = await settleActiveWithin(activeTeammates, CLEANUP_WAIT_MS);
  if (remaining.length > 0) {
    console.warn(
      `[S15] 退出前仍有队友在运行: ${remaining.join(', ')}（不会强制结束；如有在途模型请求，进程可能要等它完成）`,
    );
  }
}

if (teammateFailures.size > 0) {
  process.exitCode = 1;
  console.error(`[S15] 队友失败: ${[...teammateFailures].join(', ')}`);
}

if (result !== undefined && process.exitCode !== 1) {
  console.log('\n[S15] 完成:', result);
}
