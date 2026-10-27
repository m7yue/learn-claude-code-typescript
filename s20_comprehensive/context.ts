/**
 * s20 的上下文压缩适配层。
 *
 * 纯函数、阈值、摘要、transcript 与锚点都在 runtime/compaction.ts（s08/s20 共用），
 * 这里只把 s20 的配置、mock summarizer 和 COMPACTED_MARKER 接进去。
 */

import { classifyError } from '../runtime/errors.ts';
import { callChat } from '../runtime/model.ts';
import {
  DEFAULT_COMPACTION_LIMITS,
  SUMMARIZE_INSTRUCTION,
  createCompactor,
  type ChatFn,
  type CompactionLimits,
} from '../runtime/compaction.ts';
import {
  MAX_RETRIES,
  readRetryAfterMs,
  retryDelayMs,
} from '../runtime/recovery.ts';
import type { LLMResponse, Message } from '../runtime/types.ts';
import { TRANSCRIPTS_DIR } from '../runtime/workspace.ts';
import {
  COMPACTED_MARKER,
  CONTEXT_LIMIT,
  KEEP_RECENT_TOOL_RESULTS,
  PERSIST_THRESHOLD,
  SNIP_MAX_MESSAGES,
  TOOL_RESULT_MAX_BYTES,
} from './config.ts';
import { textBlock } from './blocks.ts';

export { SUMMARIZE_INSTRUCTION };
export const SUMMARY_MAX_TOKENS = DEFAULT_COMPACTION_LIMITS.summaryMaxTokens;

const LIMITS: Partial<CompactionLimits> = {
  contextLimit: CONTEXT_LIMIT,
  keepRecent: KEEP_RECENT_TOOL_RESULTS,
  maxMessages: SNIP_MAX_MESSAGES,
  maxBytes: TOOL_RESULT_MAX_BYTES,
  persistThreshold: PERSIST_THRESHOLD,
};

function mockSummarizer(messages: Message[]): LLMResponse {
  const n = messages.length;
  return {
    stop_reason: 'end_turn',
    content: [
      textBlock(
        `[对话摘要] 前 ${Math.max(0, n - 3)} 条消息已压缩：涵盖初始化、任务图、队友计划审批、worktree 与 cron 调度等步骤。`,
      ),
    ],
  };
}

/**
 * 摘要调用也走 429/529 重试：它发生在 PrepareContext 里，不在 lead 的 Chat 重试循环中，
 * 否则一次瞬时错误就会中断整次运行。
 */
const chatWithRetry: ChatFn = async (mockFn, messages, options) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await callChat(mockFn, messages, options);
    } catch (error: unknown) {
      const kind = classifyError(error);
      if ((kind === 'rate_limit' || kind === 'overloaded') && attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt, readRetryAfterMs(error))));
        continue;
      }
      throw error;
    }
  }
};

const defaultCompactor = createCompactor({
  chat: chatWithRetry,
  mockSummarizer,
  transcriptsDir: TRANSCRIPTS_DIR,
  limits: LIMITS,
});

export const estimateSize = defaultCompactor.estimateSize;
export const snipCompact = defaultCompactor.snipCompact;
export const microCompact = defaultCompactor.microCompact;
export const planPersists = defaultCompactor.planPersists;
export const applyPersist = defaultCompactor.applyPersist;

export interface CompactOptions {
  /** 测试可注入假的 chat；生产路径默认走 callChat。 */
  chat?: ChatFn;
  transcriptsDir?: string;
}

function withMarker(messages: Message[]): Message[] {
  return [...messages, { role: 'user', content: COMPACTED_MARKER }];
}

export async function compactHistory(
  messages: Message[],
  options: CompactOptions = {},
): Promise<Message[]> {
  const compactor =
    options.chat || options.transcriptsDir
      ? createCompactor({
          chat: options.chat ?? chatWithRetry,
          mockSummarizer,
          transcriptsDir: options.transcriptsDir ?? TRANSCRIPTS_DIR,
          limits: LIMITS,
        })
      : defaultCompactor;
  return withMarker(await compactor.compactHistory(messages));
}

export async function reactiveCompact(messages: Message[]): Promise<Message[]> {
  return defaultCompactor.reactiveCompact(messages);
}
