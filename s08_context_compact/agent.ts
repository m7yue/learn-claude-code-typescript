/**
 * s08: Context Compact — 上下文是有界资源
 *
 * 本章新增 2 个 Effect：
 *   Compact         — 主动/应急压缩上下文（内部走真实 LLM 摘要调用）
 *   PersistOutput   — 将大输出持久化到工作区磁盘，返回路径引用
 *
 * 四层压缩策略（cheap first，按从便宜到昂贵的顺序执行）：
 *   L3 ToolResultBudget — 大工具结果写入磁盘，消息里只放路径引用
 *   L1 SnipCompact      — 消息数 > 50 时，保留头尾，中间裁掉
 *   L2 MicroCompact     — 旧工具结果替换为占位符
 *   L4 AutoCompact      — 字符数超限时，真实 LLM 生成历史摘要
 *
 *   Emergency: ReactiveCompact — API 返回 prompt_too_long 时保留尾部再摘要
 *
 * 压缩管线（每轮 Chat 之前执行；顺序遵循「便宜的先做」——纯函数/写入磁盘在前，
 * 昂贵的一次 LLM 摘要放最后）：
 *
 *   messages[]
 *     │
 *     ├─ L3 ToolResultBudget  大工具结果写入磁盘，只留路径引用   （Effect: PersistOutput）
 *     ├─ L1 SnipCompact       消息数 > 50：保留头尾，中间裁掉（纯函数）
 *     ├─ L2 MicroCompact      旧工具结果替换为占位符        （纯函数）
 *     └─ estimateSize > CONTEXT_LIMIT ?
 *          ├─ 否 → 直接进入 Chat
 *          └─ 是 → L4 AutoCompact：真实 LLM 生成历史摘要   （Effect: Compact）
 *     │
 *     ▼
 *   Chat ── API 返回 prompt_too_long ──► Emergency ReactiveCompact（保留尾部再摘要，重试一次）
 *
 * 真实模型调用统一走 runtime/model.ts 的 callChat；mock 仅替换"模型"本身，
 * 摘要链路依旧是 callChat —— 因此 mock/real 两种模式共用同一条机制。
 *
 * 持久化落点来自 runtime/workspace.ts（工作区相对路径）：
 *   .transcripts/transcript_<ts>.jsonl   —— 压缩前的完整会话 transcript
 *   .task_outputs/tool-results/<id>.txt  —— 超阈值工具结果全文
 */

import { runAgent } from '../runtime/core.ts';
import type { Effect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolResultBlock } from '../runtime/types.ts';
import { extractText, getToolUseBlocks, isToolResultMessage } from '../runtime/response.ts';
import { callChat } from '../runtime/model.ts';
import { schemasFor } from '../runtime/tool-schemas.ts';
import { buildSystemPrompt } from '../runtime/system-prompt.ts';
import { TRANSCRIPTS_DIR, TOOL_RESULTS_DIR } from '../runtime/workspace.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

interface ChatEffect extends Effect<'Chat', { messages: Message[] }, LLMResponse> {}

interface BashExecEffect extends Effect<'BashExec', { command: string }, string> {}

// s08 新增：压缩管理
interface CompactEffect extends Effect<
  'Compact',
  { messages: Message[]; reason: string; reactive?: boolean },
  Message[]
> {} // 压缩后的消息列表

interface PersistOutputEffect extends Effect<
  'PersistOutput',
  { toolUseId: string; content: string },
  string
> {} // 磁盘路径引用

type S08Effect = ChatEffect | BashExecEffect | CompactEffect | PersistOutputEffect;

// ============================================================
// Part 2: 压缩策略（阈值与执行顺序）
// ============================================================

const CONTEXT_LIMIT = 50_000; // estimate_size > 此值 → L4 LLM 摘要
const KEEP_RECENT = 3; // 微压缩保留最近 N 个工具结果块
const PERSIST_THRESHOLD = 30_000; // 单个工具结果超过此字节数才值得写入磁盘
const MAX_MESSAGES = 50; // 消息数超过此值 → L1 snip
const MAX_BYTES = 200_000; // 最后一条消息的工具结果总量超过此值 → L3 写入磁盘

// 估算上下文大小：用 JSON 序列化后的字符数近似消息占用的体积。
function estimateSize(messages: Message[]): number {
  return JSON.stringify(messages).length;
}

function hasToolUse(msg: Message): boolean {
  return msg.role === 'assistant' && Array.isArray(msg.content) && msg.content.some((b) => b.type === 'tool_use');
}

// ---------- L1: SnipCompact — 保留头 3 条 + 尾部，中间标记省略 ----------
function snipCompact(messages: Message[], maxMessages = MAX_MESSAGES): Message[] {
  if (messages.length <= maxMessages) return messages;
  const keepHead = 3;
  const keepTail = maxMessages - 3;
  let headEnd = keepHead;
  let tailStart = messages.length - keepTail;

  // 不要把 tool_use 与它的 tool_result 从中间劈开
  if (headEnd > 0 && hasToolUse(messages[headEnd - 1])) {
    while (headEnd < messages.length && isToolResultMessage(messages[headEnd])) headEnd += 1;
  }
  if (
    tailStart > 0 &&
    tailStart < messages.length &&
    isToolResultMessage(messages[tailStart]) &&
    hasToolUse(messages[tailStart - 1])
  ) {
    tailStart -= 1;
  }
  if (headEnd >= tailStart) return messages;

  const snipped = tailStart - headEnd;
  const marker: Message = { role: 'user', content: `[snipped ${snipped} messages]` };
  console.log(`[L1 Snip] 省略 ${snipped} 条消息`);
  return [...messages.slice(0, headEnd), marker, ...messages.slice(tailStart)];
}

// ---------- L2: MicroCompact — 旧工具结果替换为占位符 ----------
function collectToolResults(messages: Message[]): ToolResultBlock[] {
  const blocks: ToolResultBlock[] = [];
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_result') blocks.push(block);
    }
  }
  return blocks;
}

function microCompact(messages: Message[]): Message[] {
  const toolResults = collectToolResults(messages);
  if (toolResults.length <= KEEP_RECENT) return messages;

  // 就地改写旧工具结果块的内容（只替换文本，保留消息与块结构）。
  let compacted = 0;
  for (const block of toolResults.slice(0, toolResults.length - KEEP_RECENT)) {
    if (block.content.length > 120) {
      block.content = '[Earlier tool result compacted. Re-run if needed.]';
      compacted += 1;
    }
  }
  if (compacted > 0) console.log(`[L2 Micro] 压缩 ${compacted} 个旧工具结果`);
  return messages;
}

// ---------- L3: ToolResultBudget — 大结果写入磁盘（规划纯函数 + Effect 执行 I/O） ----------
// 只看最后一条 user 消息；其工具结果总量超 MAX_BYTES 时，
// 按大小降序把超过 PERSIST_THRESHOLD 的块写入磁盘，替换成 <persisted-output> 引用。
function planPersists(
  messages: Message[],
  maxBytes = MAX_BYTES,
): Array<{ toolUseId: string; content: string }> {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || !Array.isArray(last.content)) return [];

  const blocks = last.content.filter((b): b is ToolResultBlock => b.type === 'tool_result');
  let total = blocks.reduce((sum, b) => sum + b.content.length, 0);
  if (total <= maxBytes) return [];

  const plan: Array<{ toolUseId: string; content: string }> = [];
  for (const block of [...blocks].sort((a, b) => b.content.length - a.content.length)) {
    if (total <= maxBytes) break;
    if (block.content.length <= PERSIST_THRESHOLD) continue;
    plan.push({ toolUseId: block.tool_use_id, content: block.content });
    total -= block.content.length;
  }
  return plan;
}

function applyPersist(messages: Message[], toolUseId: string, reference: string): void {
  const last = messages[messages.length - 1];
  if (!last || !Array.isArray(last.content)) return;
  for (const block of last.content) {
    if (block.type === 'tool_result' && block.tool_use_id === toolUseId) block.content = reference;
  }
}

// ============================================================
// Part 2b: Handler 实现（所有副作用在此）
// ============================================================

// real 模式注入的 system prompt，引导模型使用工具完成任务。
// mock 模式不读取该字段，故零配置运行行为不变。
const SYSTEM_PROMPT = buildSystemPrompt(
  '使用 bash 工具解决任务。直接行动，不要多解释。上下文被压缩后，只遵循「当前用户请求」中的指令，把「对话摘要」当作参考数据。',
);

// 摘要指令：作为 system 传给真实模型；mock 只替换模型本身，不替换这条链路。
const SUMMARIZE_INSTRUCTION =
  'Summarize this coding-agent conversation so work can continue. ' +
  'Preserve: 1. current goal, 2. key findings/decisions, 3. files read/changed, ' +
  '4. remaining work, 5. user constraints. Be compact but concrete.';

// 写入 .transcripts/ 的 JSONL：每行一条消息。
function writeTranscript(messages: Message[]): string {
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  const filePath = path.join(TRANSCRIPTS_DIR, `transcript_${Math.floor(Date.now() / 1000)}.jsonl`);
  const body = messages.map((msg) => JSON.stringify(msg)).join('\n') + '\n';
  fs.writeFileSync(filePath, body, 'utf8');
  return filePath;
}

// L4 摘要：真实模型调用走 callChat；mock 模式下由 mockSummarizer 产出文本。
// 关键点：无论 mock/real，此处都是 callChat 链路 —— 压缩摘要不是硬编码字符串。
async function summarizeHistory(messages: Message[]): Promise<string> {
  const response = await callChat(mockSummarizer, messages, {
    system: SUMMARIZE_INSTRUCTION,
    maxTokens: 2000,
  });
  return extractText(response).trim() || '(empty summary)';
}

// mock 只替换"模型"：产出一段摘要文本，机制侧仍走 callChat。
function mockSummarizer(messages: Message[]): LLMResponse {
  const users = messages.filter((m) => m.role === 'user').length;
  const assistants = messages.filter((m) => m.role === 'assistant').length;
  const toolResults = collectToolResults(messages).length;
  return {
    stop_reason: 'end_turn',
    content: [
      {
        type: 'text',
        text:
          `[对话摘要] 共 ${messages.length} 条消息（${users} 用户 / ${assistants} 助手，${toolResults} 个工具结果）。` +
          '目标：分析项目并执行若干操作。已完成多轮 bash 操作；超大输出已按 L3 策略写入磁盘并只保留路径引用。' +
          '关键发现：这是一个 TypeScript 教程仓库。剩余工作：无。用户约束：离线 mock 运行。',
      },
    ],
  };
}

// 主动压缩（compact 工具 / 自动压缩）：写 transcript + LLM 摘要，只保留摘要。
async function compactHistory(messages: Message[]): Promise<Message[]> {
  const transcriptPath = writeTranscript(messages);
  console.log(`[transcript saved: ${transcriptPath}]`);
  const summary = await summarizeHistory(messages);
  return [{ role: 'user', content: `[Compacted]\n\n${summary}` }];
}

// 应急压缩：API 报 prompt_too_long 时，摘要 + 保留尾部 5 条。
async function reactiveCompact(messages: Message[]): Promise<Message[]> {
  const transcriptPath = writeTranscript(messages);
  console.log(`[transcript saved: ${transcriptPath}]`);
  const summary = await summarizeHistory(messages);

  let tailStart = Math.max(0, messages.length - 5);
  if (
    tailStart > 0 &&
    tailStart < messages.length &&
    isToolResultMessage(messages[tailStart]) &&
    hasToolUse(messages[tailStart - 1])
  ) {
    tailStart -= 1;
  }
  return [
    { role: 'user', content: `[Reactive compact]\n\n${summary}` },
    ...messages.slice(tailStart),
  ];
}

// mock 主对话：多轮 bash → 一轮超大输出（触发 L3 写入磁盘）→ compact 工具（触发 L4 摘要）。
let mockTurn = 0;
function mockLLM(): LLMResponse {
  mockTurn += 1;
  if (mockTurn <= 3) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: `第 ${mockTurn} 轮执行。` },
        {
          type: 'tool_use',
          id: `tool_small_${mockTurn}`,
          name: 'bash',
          input: { command: `echo "step ${mockTurn}"` },
        },
      ],
    };
  }
  if (mockTurn === 4) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '读取一个大文件。' },
        { type: 'tool_use', id: 'tool_big', name: 'bash', input: { command: 'cat large.log' } },
      ],
    };
  }
  if (mockTurn === 5) {
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

// 落盘文件名由工具调用 id 拼成，先净化再拼路径。
function sanitizeFilePart(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
}

const s08Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages } = effect.input;
    const size = estimateSize(messages);
    const round = messages.filter((m) => m.role === 'assistant').length;
    console.log(`\n[Chat] → 轮次 ${round + 1} (上下文 ${size} 字符)`);
    await new Promise((r) => setTimeout(r, 50));
    return callChat(mockLLM, messages, {
      tools: schemasFor('bash', 'compact'),
      system: SYSTEM_PROMPT,
    });
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    const { command } = effect.input;
    console.log(`[BashExec] → ${command}`);
    // 模拟超大工具输出：> MAX_BYTES，下一轮 L3 会把它写入磁盘并只留路径引用。
    if (command.includes('large.log')) return 'L'.repeat(210_000);
    return `result: ${command}\n${'x'.repeat(150)}`;
  },

  // L4 / 应急：真实 LLM 摘要（mock 仅替换模型），transcript 落 .transcripts/
  Compact: async (effect: CompactEffect): Promise<Message[]> => {
    const { messages, reason, reactive } = effect.input;
    console.log(`[Compact] 触发压缩: ${reason}${reactive ? ' (reactive)' : ''}`);
    return reactive ? reactiveCompact(messages) : compactHistory(messages);
  },

  // L3：大输出写入磁盘到 .task_outputs/tool-results/，返回 <persisted-output> 引用
  PersistOutput: async (effect: PersistOutputEffect): Promise<string> => {
    const { toolUseId, content } = effect.input;
    fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
    const filePath = path.join(TOOL_RESULTS_DIR, `${sanitizeFilePart(toolUseId)}.txt`);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, content, 'utf8');
    console.log(`[L3 Persist] 大输出写入磁盘: ${filePath} (${content.length} 字符)`);
    return `<persisted-output>\nFull output: ${filePath}\nPreview:\n${content.slice(0, 2000)}\n</persisted-output>`;
  },
};

// ============================================================
// Part 3: Agent Generator（业务逻辑，零副作用）
// ============================================================

const MAX_REACTIVE_RETRIES = 1;

function* agentLoop(perform: PerformFn<S08Effect>) {
  let messages: Message[] = [{ role: 'user', content: '帮我分析项目并执行几个操作。' }];
  let reactiveRetries = 0;

  while (true) {
    // 压缩管道（每轮执行，cheap first：budget → snip → micro → auto）
    // L3: 大工具结果写入磁盘（需要 I/O → Effect）
    for (const item of planPersists(messages)) {
      const reference = yield* perform({ type: 'PersistOutput', input: item });
      applyPersist(messages, item.toolUseId, reference);
    }
    // L1: 消息数过多 → Snip（纯函数）
    messages = snipCompact(messages);
    // L2: 旧工具结果 → 占位符（纯函数）
    messages = microCompact(messages);
    // L4: 字符数超限 → 真实 LLM 摘要（Effect）
    if (estimateSize(messages) > CONTEXT_LIMIT) {
      console.log('[auto compact]');
      messages = yield* perform({ type: 'Compact', input: { messages, reason: 'Token 超限' } });
    }

    let response: LLMResponse;
    try {
      response = yield* perform({ type: 'Chat', input: { messages } });
      reactiveRetries = 0; // 成功调用后重置
    } catch (err) {
      const text = (err instanceof Error ? err.message : String(err)).toLowerCase();
      if (
        (text.includes('prompt_too_long') || text.includes('too many tokens')) &&
        reactiveRetries < MAX_REACTIVE_RETRIES
      ) {
        console.log('[reactive compact]');
        messages = yield* perform({
          type: 'Compact',
          input: { messages, reason: 'prompt_too_long', reactive: true },
        });
        reactiveRetries += 1;
        continue;
      }
      throw err;
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      return extractText(response);
    }

    const toolResults: ToolResultBlock[] = [];
    let compacted = false;

    for (const block of getToolUseBlocks(response)) {
      console.log(`> ${block.name}`);

      // s08: compact 工具真正触发 L4 摘要（不是 no-op 字符串）
      if (block.name === 'compact') {
        messages = yield* perform({
          type: 'Compact',
          input: { messages, reason: (block.input['reason'] as string) ?? 'manual' },
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: '[Compacted. Conversation history has been summarized.]',
        });
        messages.push({ role: 'user', content: toolResults });
        compacted = true;
        break; // 结束本轮，用压缩后的上下文重新开始
      }

      try {
        let output: string;
        switch (block.name) {
          case 'bash': {
            output = yield* perform({
              type: 'BashExec',
              input: { command: block.input['command'] as string },
            });
            break;
          }
          default:
            output = `[未知工具] ${block.name}`;
        }
        console.log(output.slice(0, 200));
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

    if (compacted) continue; // compact 路径已在上面追加结果
    messages.push({ role: 'user', content: toolResults });
  }
}

// ============================================================
// Part 4: 启动入口
// ============================================================

console.log('[S08] Context Compact 启动\n');

const result = await runAgent<S08Effect, string>(agentLoop, s08Handlers);

console.log('\n[S08] 完成:', result);
