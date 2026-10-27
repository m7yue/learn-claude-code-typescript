/**
 * 上下文压缩策略 —— 全仓单一实现（s08 / s20 共用）。
 *
 * L1 snip：消息数超限时保留头部与尾部，中段省略，并避免拆开 tool_use/tool_result。
 * L2 micro：只把较早且足够长的工具结果替换成占位符。
 * L3 budget：最后一条消息的工具结果总量超限时，把大块写入磁盘并替换成引用。
 * L4 summary：真正调用模型生成摘要，保留最初任务作为锚点。
 * reactive：API 报 prompt_too_long 时，摘要 + 尾部 + 锚点。
 *
 * 模块本身不读章节配置：chat、mock summarizer、transcript 目录和阈值都由调用方注入。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ChatHandlerOptions } from './model.ts';
import type { LLMResponse, Message, ToolResultBlock } from './types.ts';
import { extractText, isToolResultMessage } from './response.ts';

export interface CompactionLimits {
  /** 消息总字符数超过此值触发 L4 摘要 */
  contextLimit: number;
  /** L2 保留最近 N 个工具结果块 */
  keepRecent: number;
  /** L3 单个工具结果超过此值才值得写盘 */
  persistThreshold: number;
  /** L1 消息数超过此值触发 snip */
  maxMessages: number;
  /** L3 最后一条消息的工具结果总量超过此值触发写盘 */
  maxBytes: number;
  /** 摘要输入的上限，避免“为了压缩反而撑爆上下文” */
  summaryInputLimit: number;
  /** 摘要调用的 maxTokens */
  summaryMaxTokens: number;
}

export const DEFAULT_COMPACTION_LIMITS: CompactionLimits = {
  contextLimit: 50_000,
  keepRecent: 3,
  persistThreshold: 30_000,
  maxMessages: 50,
  maxBytes: 200_000,
  summaryInputLimit: 80_000,
  summaryMaxTokens: 2000,
};

export const SUMMARIZE_INSTRUCTION =
  'Summarize this coding-agent conversation so work can continue. ' +
  'Preserve: 1. current goal, 2. key findings/decisions, 3. files read/changed, ' +
  '4. remaining work, 5. user constraints. Be compact but concrete.';

/** 这些标签开头的 user 消息是压缩产物，不是最初任务。 */
const COMPACT_MARKERS = ['[Compacted]', '[Reactive compact]', '[snipped'];

export type ChatFn = (
  mockFn: (messages: Message[]) => LLMResponse | Promise<LLMResponse>,
  messages: Message[],
  options?: ChatHandlerOptions,
) => Promise<LLMResponse>;

export interface CompactorOptions {
  /** 生产路径传 callChat；测试可注入假的实现。 */
  chat: ChatFn;
  /** mock 模式下生成摘要文本的函数。 */
  mockSummarizer: (messages: Message[]) => LLMResponse;
  /** transcript 落盘目录。 */
  transcriptsDir: string;
  summarizeInstruction?: string;
  limits?: Partial<CompactionLimits>;
}

export function estimateSize(messages: Message[]): number {
  return JSON.stringify(messages).length;
}

function hasToolUse(msg: Message): boolean {
  return (
    msg.role === 'assistant' &&
    Array.isArray(msg.content) &&
    msg.content.some((b) => b.type === 'tool_use')
  );
}

/** 从历史里找最初的任务消息；压缩产物的标签需要跳过。 */
export function originalRequest(messages: Message[]): Message | undefined {
  for (const msg of messages) {
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue;
    const text = msg.content;
    if (COMPACT_MARKERS.some((marker) => text.startsWith(marker))) continue;
    return msg;
  }
  return undefined;
}

/** L1: 保留头 3 条 + 尾部，中间标记省略。 */
export function snipCompact(messages: Message[], maxMessages = DEFAULT_COMPACTION_LIMITS.maxMessages): Message[] {
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

/** 收集所有 user 消息里的工具结果块。 */
export function collectToolResults(messages: Message[]): ToolResultBlock[] {
  const blocks: ToolResultBlock[] = [];
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_result') blocks.push(block);
    }
  }
  return blocks;
}

/** L2: 旧工具结果替换为占位符；只处理较早且 >120 字符的块。 */
export function microCompact(
  messages: Message[],
  keepRecent = DEFAULT_COMPACTION_LIMITS.keepRecent,
): Message[] {
  const toolResults = collectToolResults(messages);
  if (toolResults.length <= keepRecent) return messages;

  let compacted = 0;
  for (const block of toolResults.slice(0, toolResults.length - keepRecent)) {
    if (block.content.length > 120) {
      block.content = '[Earlier tool result compacted. Re-run if needed.]';
      compacted += 1;
    }
  }
  if (compacted > 0) console.log(`[L2 Micro] 压缩 ${compacted} 个旧工具结果`);
  return messages;
}

/** L3: 最后一条消息的工具结果总量超限时，规划哪些块写入磁盘。 */
export function planPersists(
  messages: Message[],
  maxBytes = DEFAULT_COMPACTION_LIMITS.maxBytes,
  persistThreshold = DEFAULT_COMPACTION_LIMITS.persistThreshold,
): Array<{ toolUseId: string; content: string }> {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || !Array.isArray(last.content)) return [];

  const blocks = last.content.filter((b): b is ToolResultBlock => b.type === 'tool_result');
  let total = blocks.reduce((sum, b) => sum + b.content.length, 0);
  if (total <= maxBytes) return [];

  const plan: Array<{ toolUseId: string; content: string }> = [];
  for (const block of [...blocks].sort((a, b) => b.content.length - a.content.length)) {
    if (total <= maxBytes) break;
    if (block.content.length <= persistThreshold) continue;
    plan.push({ toolUseId: block.tool_use_id, content: block.content });
    total -= block.content.length;
  }
  return plan;
}

/** 把最后一条消息里对应 tool_use_id 的结果替换成落盘引用。 */
export function applyPersist(messages: Message[], toolUseId: string, reference: string): void {
  const last = messages[messages.length - 1];
  if (!last || !Array.isArray(last.content)) return;
  for (const block of last.content) {
    if (block.type === 'tool_result' && block.tool_use_id === toolUseId) block.content = reference;
  }
}

/** 摘要输入上限：压缩本身也可能遇到很长的 head，先截断再发给模型。 */
function boundForSummary(messages: Message[], limit: number): Message[] {
  const kept: Message[] = [];
  let size = 0;
  for (const msg of messages) {
    const cost = JSON.stringify(msg).length;
    if (kept.length > 0 && size + cost > limit) break;
    kept.push(msg);
    size += cost;
  }
  return kept;
}

export interface Compactor {
  limits: CompactionLimits;
  writeTranscript(messages: Message[]): string;
  summarizeHistory(messages: Message[]): Promise<string>;
  compactHistory(messages: Message[]): Promise<Message[]>;
  reactiveCompact(messages: Message[]): Promise<Message[]>;
  snipCompact(messages: Message[]): Message[];
  microCompact(messages: Message[]): Message[];
  planPersists(messages: Message[]): Array<{ toolUseId: string; content: string }>;
  applyPersist(messages: Message[], toolUseId: string, reference: string): void;
  estimateSize(messages: Message[]): number;
}

export function createCompactor(options: CompactorOptions): Compactor {
  const limits: CompactionLimits = { ...DEFAULT_COMPACTION_LIMITS, ...options.limits };
  const instruction = options.summarizeInstruction ?? SUMMARIZE_INSTRUCTION;
  let transcriptSeq = 0;

  function writeTranscript(messages: Message[]): string {
    fs.mkdirSync(options.transcriptsDir, { recursive: true });
    transcriptSeq += 1;
    const stamp = Math.floor(Date.now() / 1000);
    const filePath = path.join(options.transcriptsDir, `transcript_${stamp}_${transcriptSeq}.jsonl`);
    const body = messages.map((msg) => JSON.stringify(msg)).join('\n') + '\n';
    fs.writeFileSync(filePath, body, 'utf8');
    return filePath;
  }

  async function summarizeHistory(messages: Message[]): Promise<string> {
    const response = await options.chat(options.mockSummarizer, boundForSummary(messages, limits.summaryInputLimit), {
      system: instruction,
      maxTokens: limits.summaryMaxTokens,
    });
    return extractText(response).trim() || '(empty summary)';
  }

  async function compactHistory(messages: Message[]): Promise<Message[]> {
    const transcriptPath = writeTranscript(messages);
    console.log(`[transcript saved: ${transcriptPath}]`);
    const summary = await summarizeHistory(messages);
    const anchor = originalRequest(messages);
    const compacted: Message[] = [{ role: 'user', content: `[Compacted]\n\n${summary}` }];
    return anchor ? [...compacted, anchor] : compacted;
  }

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
    const tail = messages.slice(tailStart);
    const anchor = originalRequest(messages);
    const kept = anchor && !tail.includes(anchor) ? [anchor, ...tail] : tail;
    return [{ role: 'user', content: `[Reactive compact]\n\n${summary}` }, ...kept];
  }

  return {
    limits,
    writeTranscript,
    summarizeHistory,
    compactHistory,
    reactiveCompact,
    snipCompact: (messages) => snipCompact(messages, limits.maxMessages),
    microCompact: (messages) => microCompact(messages, limits.keepRecent),
    planPersists: (messages) => planPersists(messages, limits.maxBytes, limits.persistThreshold),
    applyPersist,
    estimateSize,
  };
}
