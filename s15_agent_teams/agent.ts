/**
 * s15: Agent Teams — 消息总线 + 真实的队友子循环
 *
 * 本章新增 3 个 Effect：
 *   SpawnTeammate — 拉起一个真实的队友 Agent（自带 generator + runAgent 子循环）
 *   SendMessage   — 向目标信箱追加一条 JSONL 消息（真实文件 I/O）
 *   CheckInbox    — 读取并清空自己的信箱（读后即消费）
 *
 * 队友是真正跑自己循环的独立 Agent：独立 messages、独立 generator，由同一个 runAgent 驱动：
 *   - 队友从 `.mailboxes/<agentId>.jsonl` 读自己的任务
 *   - 调用工具（bash / read_file / write_file / send_message）干活
 *   - 把结果写回 lead 的信箱，然后子循环结束
 *
 * 教学版：队友最多跑 MAX_TURNS(=10) 个「工作轮」，空闲时轮询信箱直到收到任务
 * （本仓 spawn_teammate 的 schema 只有 agentId/role，任务只能经信箱下达，
 * 于是用有界空闲轮询承接）。
 *
 * Mock 只替换「模型调用」这一件事：teammate loop、信箱读写、任务分发全部是真实代码。
 */

import { runAgent } from '../runtime/core.ts';
import type { Effect, EffectHandlers, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolResultBlock } from '../runtime/types.ts';
import { extractText, getToolUseBlocks } from '../runtime/response.ts';
import { callChat } from '../runtime/model.ts';
import { schemasFor } from '../runtime/tool-schemas.ts';
import { buildSystemPrompt } from '../runtime/system-prompt.ts';
import { MAILBOXES_DIR } from '../runtime/workspace.ts';
import { Mutex } from '../runtime/locks.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// Part 0: 常量
// ============================================================

const LEAD_ID = 'main';      // 主 Agent 的 mailbox 名
const MAX_TURNS = 10;        // 教学版：队友最多 10 个"工作轮"
const MAX_IDLE = 400;        // 空闲轮询上限（400 × 5ms ≈ 2s 后会主动放弃）
const POLL_MS = 5;           // 空闲轮询间隔

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

interface ChatEffect extends Effect<'Chat', { messages: Message[]; agentId: string }, LLMResponse> {}

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
interface SpawnTeammateEffect extends Effect<'SpawnTeammate', { agentId: string; role: string }, { agentId: string; status: 'spawned' }> {}

interface SendMessageEffect extends Effect<'SendMessage', { from: string; to: string; body: string; kind?: string }, { messageId: string }> {}

interface CheckInboxEffect extends Effect<'CheckInbox', { agentId: string }, AgentMessage[]> {}

/** 队友空闲等待信箱（只在队友子循环里用）。 */
interface IdleEffect extends Effect<'Idle', { agentId: string; ms: number }, void> {}

type S15Effect =
  | ChatEffect
  | BashExecEffect
  | ReadFileEffect
  | WriteFileEffect
  | SpawnTeammateEffect
  | SendMessageEffect
  | CheckInboxEffect
  | IdleEffect;

// ============================================================
// Part 2: MessageBus —— 真实的 JSONL 信箱（.mailboxes/*.jsonl）
// ============================================================

/**
 * 文件消息总线：每个 Agent 一个 `.jsonl` 信箱，一行一条 JSON 消息。
 *   send()       —— 追加一行（真实写文件）
 *   readInbox()  —— 读出全部消息，然后把文件清空（读完即取走）
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
    return path.join(MAILBOXES_DIR, `${agentId}.jsonl`);
  }

  async send(from: string, to: string, body: string, type = 'message'): Promise<string> {
    return this.mutex.withLock(() => {
      fs.mkdirSync(MAILBOXES_DIR, { recursive: true });
      const msg: AgentMessage = { from, to, body, type, timestamp: Date.now() };
      fs.appendFileSync(this.inboxPath(to), JSON.stringify(msg) + '\n', 'utf8');
      const messageId = `msg_${Date.now()}_${++this.seq}`;
      console.log(`  \x1b[33m[bus] ${from} → ${to}: ${truncate(body, 50)}\x1b[0m`);
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
      // 消费式读取：读出全部消息后把文件清空为 0 字节，
      // 便于学习者在 .mailboxes/ 里看到信箱布局（目录/文件名都是真实的）。
      fs.writeFileSync(p, '', 'utf8');
      return msgs;
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
// Part 3: Mock LLM —— 只替换模型调用
// ============================================================

const TEAMMATE_REPLIES: Record<string, string> = {
  analyzer: '分析完成：代码复杂度适中，建议关注 3 个高复杂函数',
  reviewer: '审查完成：发现 2 处潜在问题，已标记',
};

/** lead 的剧本：spawn → 派活 → 查信箱 → 收尾。 */
function mockLead(messages: Message[]): LLMResponse {
  const turn = messages.filter((m) => m.role === 'assistant').length;
  if (turn === 0) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '组建分析团队。' },
        { type: 'tool_use', id: 'm1', name: 'spawn_teammate', input: { agentId: 'analyzer', role: '代码分析专家' } },
        { type: 'tool_use', id: 'm2', name: 'spawn_teammate', input: { agentId: 'reviewer', role: '代码审查专家' } },
      ],
    };
  }
  if (turn === 1) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '把任务派给队友。' },
        { type: 'tool_use', id: 'm3', name: 'send_message', input: { to: 'analyzer', body: '请分析 src/ 目录的代码复杂度' } },
        { type: 'tool_use', id: 'm4', name: 'send_message', input: { to: 'reviewer', body: '请审查 src/ 目录的代码质量' } },
      ],
    };
  }
  if (turn === 2) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '检查队友回复。' },
        { type: 'tool_use', id: 'm5', name: 'check_inbox', input: {} },
      ],
    };
  }
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '团队协作完成：消息总线成功协调多个 Agent。' }],
  };
}

/** 队友剧本：第 1 轮调工具干活，第 2 轮给出结果文本。 */
function mockTeammate(agentId: string, messages: Message[]): LLMResponse {
  const turn = messages.filter((m) => m.role === 'assistant').length;
  if (turn === 0) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: `${agentId} 收到任务，开始处理。` },
        { type: 'tool_use', id: `${agentId}_t1`, name: 'bash', input: { command: `echo "${agentId}: scanning src/ ..."` } },
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
// Part 4: 队友子循环 —— 真实 generator + runAgent
// ============================================================

// 活跃队友：agentId → 它那一轮运行的 Promise（稍后用来等它结束，避免进程提前退出）
const activeTeammates = new Map<string, Promise<string>>();

/** 等所有队友运行结束（为了演示结果稳定：等它们结束后再查信箱、再退出）。 */
async function awaitTeammates(): Promise<void> {
  const pending = [...activeTeammates.values()];
  if (pending.length === 0) return;
  await Promise.allSettled(pending);
  activeTeammates.clear();
}

/**
 * 队友 Agent 循环（独立 messages / 独立 generator，由 runAgent 驱动）。
 * 空闲时轮询自己的信箱，收到任务后调用工具，并把最终结果写回 lead 信箱。
 */
function* teammateLoop(perform: PerformFn<S15Effect>, agentId: string, role: string) {
  const messages: Message[] = [
    {
      role: 'user',
      content: `你是团队成员 '${agentId}'（${role}）。等待 lead 通过信箱派发任务，用工具完成后把结果通过 send_message 回报给 '${LEAD_ID}'。`,
    },
  ];

  let workTurns = 0;
  let idle = 0;
  let received = false;
  let finalText = '';

  while (workTurns < MAX_TURNS) {
    // 真实读取并清空自己的信箱
    const inbox = yield* perform({ type: 'CheckInbox', input: { agentId } });

    if (inbox.length === 0 && !received) {
      // 还没接到活：有界空闲等待（被 send 唤醒或超时后重试）
      idle += 1;
      if (idle > MAX_IDLE) {
        finalText = `(${agentId}) 空闲超时，未收到任务`;
        break;
      }
      yield* perform({ type: 'Idle', input: { agentId, ms: POLL_MS } });
      continue;
    }

    if (inbox.length > 0) {
      received = true;
      messages.push({ role: 'user', content: `<inbox>${JSON.stringify(inbox)}</inbox>` });
    }

    workTurns += 1;
    const response = yield* perform({ type: 'Chat', input: { messages, agentId } });
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      finalText = extractText(response);
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

  // 子循环结束前把最终摘要作为 'result' 消息发给 lead
  const summary = finalText || 'Done.';
  yield* perform({ type: 'SendMessage', input: { from: agentId, to: LEAD_ID, body: summary, kind: 'result' } });
  console.log(`  \x1b[32m[teammate] ${agentId} finished\x1b[0m`);
  return summary;
}

/** 拉起一个队友：注册到 activeTeammates，并启动其独立的 runAgent 子循环。 */
function startTeammate(agentId: string, role: string): Promise<string> {
  const promise = runAgent<S15Effect, string>(
    (perform) => teammateLoop(perform, agentId, role),
    s15Handlers,
  ).catch((err: unknown) => {
    console.log(`  \x1b[31m[teammate] ${agentId} 异常: ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
    return '[teammate error]';
  });
  activeTeammates.set(agentId, promise);
  return promise;
}

// ============================================================
// Part 5: Handler 实现（主 Agent 与队友共用）
// ============================================================

const LEAD_SYSTEM_PROMPT = buildSystemPrompt(
  '使用 spawn_teammate / send_message / check_inbox 与队友协作。需要并行工作时，先提出职责清晰的小团队，队友要先完成当前任务再认领下一个。',
);

function teammateSystemPrompt(agentId: string, role: string): string {
  return `你是 '${agentId}'，一名${role}。用工具完成任务，并通过 send_message 把结果发给 '${LEAD_ID}'。`;
}

const s15Handlers: EffectHandlers<S15Effect> = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages, agentId } = effect.input;
    const round = messages.filter((m) => m.role === 'assistant').length + 1;
    console.log(`\n[Chat:${agentId}] → 轮次 ${round}`);
    return callChat((m) => mockModel(agentId, m), messages, {
      tools:
        agentId === LEAD_ID
          ? schemasFor('bash', 'spawn_teammate', 'send_message', 'check_inbox')
          : schemasFor('bash', 'read_file', 'write_file', 'send_message'),
      system: agentId === LEAD_ID ? LEAD_SYSTEM_PROMPT : teammateSystemPrompt(agentId, '队友'),
    });
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    console.log(`[BashExec] → ${effect.input.command}`);
    // 教学演示：只模拟执行，不真正 fork 进程（与其余章节一致）
    return `(执行: ${effect.input.command})`;
  },

  ReadFile: async (effect: ReadFileEffect): Promise<string> => {
    try {
      const lines = fs.readFileSync(path.resolve(effect.input.path), 'utf8').split('\n');
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
      const target = path.resolve(effect.input.path);
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
    console.log(`\x1b[36m[SpawnTeammate] 生成: ${agentId} (${role})\x1b[0m`);
    startTeammate(agentId, role);
    // 让队友先跑到第一个 Idle await（注册唤醒信号），主流程再继续派活
    await new Promise((r) => setTimeout(r, 0));
    return { agentId, status: 'spawned' };
  },

  SendMessage: async (effect: SendMessageEffect): Promise<{ messageId: string }> => {
    const { from, to, body, kind } = effect.input;
    const messageId = await BUS.send(from, to, body, kind ?? 'message');
    return { messageId };
  },

  CheckInbox: async (effect: CheckInboxEffect): Promise<AgentMessage[]> => {
    // lead 查信箱前先等队友结束：保证队友已经把「result」写回来（演示结果才稳定）
    if (effect.input.agentId === LEAD_ID) {
      await awaitTeammates();
    }
    const msgs = await BUS.readInbox(effect.input.agentId);
    console.log(`[CheckInbox:${effect.input.agentId}] 收到 ${msgs.length} 条消息`);
    msgs.forEach((m) => console.log(`  ✉ from ${m.from}: ${truncate(m.body, 80)}`));
    return msgs;
  },

  Idle: async (effect: IdleEffect): Promise<void> => {
    await waitForMailbox(effect.input.agentId, effect.input.ms);
  },
};

// ============================================================
// Part 6: 主 Agent Generator（agentId = 'main'）
// ============================================================

function* agentLoop(perform: PerformFn<S15Effect>) {
  const agentId = LEAD_ID;
  const messages: Message[] = [
    { role: 'user', content: '组建分析团队，协调完成代码审查任务。' },
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
            output = msgs.length ? msgs.map((m) => `${m.from}: ${m.body}`).join('\n') : '信箱为空';
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
// Part 7: 启动入口
// ============================================================

fs.mkdirSync(MAILBOXES_DIR, { recursive: true });

console.log('[S15] Agent Teams 启动');
console.log(`  信箱目录: ${MAILBOXES_DIR}\n`);

const result = await runAgent<S15Effect, string>(agentLoop, s15Handlers);

// 收尾：确保所有队友都已结束（正常情况下 CheckInbox 里已经等过，这里再保险一次）
await awaitTeammates();

console.log('\n[S15] 完成:', result);
