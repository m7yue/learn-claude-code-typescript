/**
 * s08: Context Compact — 上下文是有界资源
 *
 * 本章新增 2 个 Effect：
 *   Compact         — 主动触发上下文压缩
 *   PersistOutput   — 将大输出持久化到磁盘，返回路径引用
 *
 * 四层压缩策略（与 Python 版完全对应）：
 *   L1 SnipCompact      — 消息数过多时，保留头尾，中间裁掉
 *   L2 MicroCompact     — 旧的工具结果替换为占位符
 *   L3 ToolResultBudget — 大输出落盘，消息里只放路径
 *   L4 AutoCompact      — Token 超限时，LLM 生成历史摘要
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
  input: { messages: Message[] };
  output: LLMResponse;
}

interface BashExecEffect extends BaseEffect {
  type: 'BashExec';
  input: { command: string };
  output: string;
}

// s08 新增：压缩管理
interface CompactEffect extends BaseEffect {
  type: 'Compact';
  input: { messages: Message[]; reason: string };
  output: Message[]; // 压缩后的消息列表
}

interface PersistOutputEffect extends BaseEffect {
  type: 'PersistOutput';
  input: { toolUseId: string; content: string };
  output: string; // 磁盘路径引用
}

type S08Effect = ChatEffect | BashExecEffect | CompactEffect | PersistOutputEffect;

// ============================================================
// Part 2: 压缩策略函数（纯函数，无副作用）
// ============================================================

const CONTEXT_LIMIT = 400;  // 字符数上限（教学用极小值，便于演示）
const KEEP_RECENT = 2;      // 微压缩时保留最近 N 个工具结果
const MAX_MESSAGES = 8;     // 超过多少条消息触发 snip 压缩
const PERSIST_THRESHOLD = 80; // 超过多少字符触发持久化

function estimateSize(messages: Message[]): number {
  return messages.reduce((acc, m) => acc + m.content.length, 0);
}

// L1: SnipCompact — 保留头3条 + 尾部，中间标记省略
function snipCompact(messages: Message[], maxMessages = MAX_MESSAGES): Message[] {
  if (messages.length <= maxMessages) return messages;
  const head = messages.slice(0, 3);
  const tail = messages.slice(-Math.floor(maxMessages * 0.8));
  const skipped = messages.length - head.length - tail.length;
  const marker: Message = {
    role: 'user',
    content: `[已省略 ${skipped} 条消息以节省上下文]`,
  };
  console.log(`[L1 Snip] 省略 ${skipped} 条消息`);
  return [...head, marker, ...tail];
}

// L2: MicroCompact — 旧工具结果替换为占位符
function microCompact(messages: Message[]): Message[] {
  let toolResultCount = 0;
  // 倒序计数，找出"最近 KEEP_RECENT 个"
  const toolResultIndices: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && messages[i].content.includes('"tool_use_id"')) {
      toolResultIndices.push(i);
    }
  }

  if (toolResultIndices.length <= KEEP_RECENT) return messages;

  const recentSet = new Set(toolResultIndices.slice(0, KEEP_RECENT));
  let compacted = 0;

  const result = messages.map((msg, i) => {
    if (msg.role === 'user' && msg.content.includes('"tool_use_id"') && !recentSet.has(i)) {
      compacted++;
      return { ...msg, content: '[工具结果已压缩]' };
    }
    return msg;
  });

  if (compacted > 0) console.log(`[L2 Micro] 压缩 ${compacted} 个旧工具结果`);
  return result;
}

// L4: AutoCompact — 生成历史摘要（mock LLM 调用）
function summarizeHistory(messages: Message[]): string {
  const userMessages = messages.filter(m => m.role === 'user').length;
  const assistantMessages = messages.filter(m => m.role === 'assistant').length;
  return `[历史摘要] 对话共 ${messages.length} 条消息（${userMessages} 用户/${assistantMessages} 助手）。` +
    `主要完成了文件操作和代码分析任务。关键发现：项目使用 TypeScript。`;
}

function autoCompact(messages: Message[]): Message[] {
  console.log(`[L4 Auto] Token 超限，生成历史摘要`);
  const summary = summarizeHistory(messages);
  // 保留最后 5 条消息
  const recent = messages.slice(-5);
  return [
    { role: 'user', content: `[已压缩]\n\n${summary}` },
    ...recent,
  ];
}

// ============================================================
// Part 2b: Handler 实现
// ============================================================

const PERSIST_DIR = path.join(os.tmpdir(), 'learn-claude-code-typescript', 's08');

function extractText(response: LLMResponse): string {
  return response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text).join('');
}

function getToolUseBlocks(response: LLMResponse): ToolUseBlock[] {
  return response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

// 跟踪是否已经压缩过（防止 mockLLM 反复触发 compact）
let hasCompacted = false;

// Mock LLM：模拟多轮对话，产生大输出
function mockLLM(messages: Message[]): LLMResponse {
  const round = messages.filter(m => m.role === 'assistant').length;
  if (round < 3) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: `第 ${round + 1} 轮执行。` },
        { type: 'tool_use', id: `tool_${round}`, name: 'bash', input: { command: `echo "round ${round}"` } },
      ],
    };
  }
  // 第4轮：主动压缩（只触发一次）
  if (round === 3 && !hasCompacted) {
    hasCompacted = true;
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '上下文有点长了，主动压缩一下。' },
        { type: 'tool_use', id: 'compact_001', name: 'compact', input: { reason: '上下文过长' } },
      ],
    };
  }
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '任务完成，上下文已通过多层策略管理。' }],
  };
}

const s08Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages } = effect.input;
    const size = estimateSize(messages);
    const round = messages.filter(m => m.role === 'assistant').length;
    console.log(`\n[Chat] → 轮次 ${round + 1} (上下文 ${size} 字符)`);
    await new Promise(r => setTimeout(r, 50));
    return mockLLM(messages);
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    console.log(`[BashExec] → ${effect.input.command}`);
    // 模拟大输出
    return `result: ${effect.input.command}\n${'x'.repeat(100)}`;
  },

  // 主动压缩：L4 AutoCompact
  Compact: async (effect: CompactEffect): Promise<Message[]> => {
    const { messages, reason } = effect.input;
    console.log(`[Compact] 触发压缩: ${reason}`);
    return autoCompact(messages);
  },

  // L3: 大输出持久化
  PersistOutput: async (effect: PersistOutputEffect): Promise<string> => {
    const { toolUseId, content } = effect.input;
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
    const filePath = path.join(PERSIST_DIR, `${toolUseId}.txt`);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`[L3 Persist] 大输出落盘: ${filePath} (${content.length} 字符)`);
    return `[大输出已持久化到 ${filePath}，可用 read_file 查看]`;
  },
};

// ============================================================
// Part 3: Agent Generator
// ============================================================

function* agentLoop(perform: PerformFn<S08Effect>) {
  let messages: Message[] = [
    { role: 'user', content: '帮我分析项目并执行几个操作。' },
  ];

  while (true) {
    // 压缩管道（每轮执行，防止上下文膨胀）
    // L1: 消息数过多 → Snip
    messages = snipCompact(messages);
    // L2: 旧工具结果 → 占位符
    messages = microCompact(messages);
    // L4: Token 超限 → AutoCompact
    if (estimateSize(messages) > CONTEXT_LIMIT) {
      messages = yield* perform({ type: 'Compact', input: { messages, reason: 'Token 超限' } });
    }

    const response = yield* perform({ type: 'Chat', input: { messages } });
    messages.push({ role: 'assistant', content: extractText(response) });

    if (response.stop_reason !== 'tool_use') {
      return extractText(response);
    }

    const toolResults: Array<{ tool_use_id: string; content: string }> = [];

    for (const block of getToolUseBlocks(response)) {
      let output: string;
      switch (block.name) {
        case 'bash': {
          const raw = yield* perform({ type: 'BashExec', input: { command: block.input['command'] as string } });
          // L3: 大输出 → 持久化
          if (raw.length > PERSIST_THRESHOLD) {
            output = yield* perform({ type: 'PersistOutput', input: { toolUseId: block.id, content: raw } });
          } else {
            output = raw;
          }
          break;
        }
        case 'compact': {
          // 主动压缩
          messages = yield* perform({
            type: 'Compact',
            input: { messages, reason: block.input['reason'] as string },
          });
          output = '[上下文已压缩]';
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
// Part 4: 启动入口
// ============================================================

console.log('[S08] Context Compact 启动\n');

const result = await runAgent<S08Effect, string>(agentLoop, s08Handlers);

console.log('\n[S08] 完成:', result);
