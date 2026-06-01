/**
 * s15: Agent Teams — 消息总线是多 Agent 协作的效应基础
 *
 * 本章新增 3 个 Effect：
 *   SpawnTeammate   — 创建团队成员（独立 Agent 实例）
 *   SendMessage     — 向信箱写入消息（JSONL 文件模拟）
 *   CheckInbox      — 读取并清空自己的信箱
 *
 * 核心思想：多 Agent = 多个并发 Generator + 消息总线
 * 每个 Agent 有独立信箱，消息总线解耦发送方和接收方。
 * 主 Agent 不直接调用子 Agent，而是通过消息传递协调。
 */

import { runAgent } from '../runtime/core.ts';
import type { BaseEffect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolUseBlock } from '../runtime/types.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

interface ChatEffect extends BaseEffect {
  type: 'Chat';
  input: { messages: Message[]; agentId: string };
  output: LLMResponse;
}

interface BashExecEffect extends BaseEffect {
  type: 'BashExec';
  input: { command: string };
  output: string;
}

interface AgentMessage {
  from: string;
  to: string;
  body: string;
  timestamp: number;
}

// s15 新增：团队消息总线
interface SpawnTeammateEffect extends BaseEffect {
  type: 'SpawnTeammate';
  input: { agentId: string; role: string };
  output: { agentId: string; status: 'spawned' };
}

interface SendMessageEffect extends BaseEffect {
  type: 'SendMessage';
  input: { from: string; to: string; body: string };
  output: { messageId: string };
}

interface CheckInboxEffect extends BaseEffect {
  type: 'CheckInbox';
  input: { agentId: string };
  output: AgentMessage[];
}

type S15Effect = ChatEffect | BashExecEffect | SpawnTeammateEffect | SendMessageEffect | CheckInboxEffect;

// ============================================================
// Part 2: Handler 实现（消息总线）
// ============================================================

const INBOX_DIR = path.join(os.tmpdir(), 'learn-claude-code-typescript', 's15', 'inbox');

function ensureInboxDir() {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
}

function inboxPath(agentId: string): string {
  return path.join(INBOX_DIR, `${agentId}.jsonl`);
}

function extractText(response: LLMResponse): string {
  return response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text).join('');
}

function getToolUseBlocks(response: LLMResponse): ToolUseBlock[] {
  return response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

// Mock LLM：按 agentId 返回不同响应
const mainResponses = [
  // 主 Agent 轮1：生成团队成员
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '生成分析团队。' },
      { type: 'tool_use' as const, id: 'm1', name: 'spawn_teammate', input: { agentId: 'analyzer', role: '代码分析专家' } },
      { type: 'tool_use' as const, id: 'm2', name: 'spawn_teammate', input: { agentId: 'reviewer', role: '代码审查专家' } },
    ],
  },
  // 主 Agent 轮2：发送任务
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '分配分析任务。' },
      { type: 'tool_use' as const, id: 'm3', name: 'send_message', input: { from: 'main', to: 'analyzer', body: '请分析 src/ 目录的代码复杂度' } },
    ],
  },
  // 主 Agent 轮3：检查信箱
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '检查分析结果。' },
      { type: 'tool_use' as const, id: 'm4', name: 'check_inbox', input: { agentId: 'main' } },
    ],
  },
  // 主 Agent 轮4：结束
  {
    stop_reason: 'end_turn' as const,
    content: [{ type: 'text' as const, text: '团队协作完成！消息总线成功协调多个 Agent。' }],
  },
];

const spawnedAgentReplies: Record<string, string> = {
  analyzer: '分析完成：代码复杂度适中，建议关注 3 个高复杂函数',
  reviewer: '审查完成：发现 2 处潜在问题，已标记',
};

let mainRoundIndex = 0;
function mockLLM(agentId: string, _messages: Message[]): LLMResponse {
  if (agentId === 'main') {
    return mainResponses[Math.min(mainRoundIndex++, mainResponses.length - 1)] as LLMResponse;
  }
  // 子 Agent 固定回复
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: spawnedAgentReplies[agentId] ?? '任务完成' }],
  };
}

const spawned = new Set<string>();

const s15Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages, agentId } = effect.input;
    const round = messages.filter(m => m.role === 'assistant').length;
    console.log(`\n[Chat:${agentId}] → 轮次 ${round + 1}`);
    await new Promise(r => setTimeout(r, 30));
    return mockLLM(agentId, messages);
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    return `(执行: ${effect.input.command})`;
  },

  SpawnTeammate: async (effect: SpawnTeammateEffect): Promise<{ agentId: string; status: 'spawned' }> => {
    const { agentId, role } = effect.input;
    ensureInboxDir();
    spawned.add(agentId);
    console.log(`[SpawnTeammate] 生成: ${agentId} (${role})`);
    return { agentId, status: 'spawned' };
  },

  SendMessage: async (effect: SendMessageEffect): Promise<{ messageId: string }> => {
    const { from, to, body } = effect.input;
    ensureInboxDir();
    const msg: AgentMessage = { from, to, body, timestamp: Date.now() };
    const messageId = `msg_${Date.now()}`;
    fs.appendFileSync(inboxPath(to), JSON.stringify(msg) + '\n', 'utf8');
    console.log(`[SendMessage] ${from} → ${to}: "${body}"`);

    // 如果目标是已生成的子 Agent，立即模拟其回复
    if (spawned.has(to)) {
      const reply: AgentMessage = {
        from: to,
        to: from,
        body: spawnedAgentReplies[to] ?? '已收到，稍后回复',
        timestamp: Date.now() + 50,
      };
      setTimeout(() => {
        fs.appendFileSync(inboxPath(from), JSON.stringify(reply) + '\n', 'utf8');
        console.log(`  [${to} 回复] → ${from}: "${reply.body}"`);
      }, 50);
    }

    return { messageId };
  },

  CheckInbox: async (effect: CheckInboxEffect): Promise<AgentMessage[]> => {
    const { agentId } = effect.input;
    ensureInboxDir();
    // 等待一下让异步回复写入
    await new Promise(r => setTimeout(r, 80));
    const filepath = inboxPath(agentId);
    if (!fs.existsSync(filepath)) {
      console.log(`[CheckInbox:${agentId}] 信箱为空`);
      return [];
    }
    const lines = fs.readFileSync(filepath, 'utf8').trim().split('\n').filter(Boolean);
    const messages = lines.map(l => JSON.parse(l) as AgentMessage);
    fs.writeFileSync(filepath, '', 'utf8'); // 清空信箱
    console.log(`[CheckInbox:${agentId}] 收到 ${messages.length} 条消息:`);
    messages.forEach(m => console.log(`  ✉ from ${m.from}: "${m.body}"`));
    return messages;
  },
};

// ============================================================
// Part 3: Agent Generator（主 Agent，agentId = 'main'）
// ============================================================

function* agentLoop(perform: PerformFn<S15Effect>) {
  const agentId = 'main';
  const messages: Message[] = [
    { role: 'user', content: '组建分析团队，协调完成代码审查任务。' },
  ];

  while (true) {
    const response = yield* perform({ type: 'Chat', input: { messages, agentId } });
    messages.push({ role: 'assistant', content: extractText(response) });

    if (response.stop_reason !== 'tool_use') {
      return extractText(response);
    }

    const toolResults: Array<{ tool_use_id: string; content: string }> = [];

    for (const block of getToolUseBlocks(response)) {
      let output: string;
      switch (block.name) {
        case 'bash':
          output = yield* perform({ type: 'BashExec', input: { command: block.input['command'] as string } });
          break;
        case 'spawn_teammate': {
          const { agentId: spawnedId } = yield* perform({
            type: 'SpawnTeammate',
            input: { agentId: block.input['agentId'] as string, role: block.input['role'] as string },
          });
          output = `团队成员已生成: ${spawnedId}`;
          break;
        }
        case 'send_message': {
          const { messageId } = yield* perform({
            type: 'SendMessage',
            input: {
              from: agentId,
              to: block.input['to'] as string,
              body: block.input['body'] as string,
            },
          });
          output = `消息已发送 (${messageId})`;
          break;
        }
        case 'check_inbox': {
          const msgs = yield* perform({
            type: 'CheckInbox',
            input: { agentId: block.input['agentId'] as string },
          });
          output = msgs.length ? msgs.map(m => `${m.from}: ${m.body}`).join('\n') : '信箱为空';
          break;
        }
        default:
          output = `[未知工具] ${block.name}`;
      }
      toolResults.push({ tool_use_id: block.id, content: output });
    }

    messages.push({ role: 'user', content: JSON.stringify(toolResults) });
  }
}

// ============================================================
// Part 4: 启动入口（清理旧信箱）
// ============================================================

// 清理旧信箱
fs.mkdirSync(INBOX_DIR, { recursive: true });
fs.readdirSync(INBOX_DIR).forEach(f => {
  try { fs.unlinkSync(path.join(INBOX_DIR, f)); } catch {}
});

console.log('[S15] Agent Teams 启动\n');

const result = await runAgent<S15Effect, string>(agentLoop, s15Handlers);

console.log('\n[S15] 完成:', result);
