/**
 * LLM 响应解析辅助函数 —— 全仓单一实现。
 *
 * extractText / getToolUseBlocks 等统一放在这里，章节按需 import，
 * 避免每个章节各复制一份。
 */

import type {
  LLMResponse,
  Message,
  MessageContent,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from './types.ts';

/** 提取 LLMResponse 中所有文本块拼接后的文本。 */
export function extractText(response: LLMResponse): string {
  return response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** 提取 LLMResponse 中的所有工具调用块。 */
export function getToolUseBlocks(response: LLMResponse): ToolUseBlock[] {
  return response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

/**
 * 把消息内容压平成纯文本，供 mock、日志与尺寸估算使用。
 * 内容可能是纯字符串，也可能是 text / tool_use / tool_result 块数组。
 */
export function messageText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_result') return b.content;
      return JSON.stringify(b.input);
    })
    .join('');
}

/** 判断一条消息是否为工具结果消息（user 消息且含 tool_result 块）。 */
export function isToolResultMessage(message: Message): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some((b) => b.type === 'tool_result')
  );
}

const isToolUse = (b: TextBlock | ToolUseBlock | ToolResultBlock): b is ToolUseBlock =>
  b.type === 'tool_use';
const isToolResult = (b: TextBlock | ToolUseBlock | ToolResultBlock): b is ToolResultBlock =>
  b.type === 'tool_result';

/**
 * 清理没有配对的 tool_use / tool_result。
 *
 * 压缩或截断消息列表时，可能把一对 tool_use（assistant）与 tool_result（user）拆散。
 * real 模式下 Anthropic 要求二者严格配对，否则报错；这里在发送前剔除无法配对的块。
 * 仅在 real 路径调用（mock 不经过此函数），故默认零配置行为不变。
 */
export function sanitizeToolPairs(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }

    if (msg.role === 'assistant') {
      const toolUseIds = msg.content.filter(isToolUse).map((b) => b.id);
      if (toolUseIds.length === 0) {
        out.push(msg);
        continue;
      }
      const next = messages[i + 1];
      const provided = new Set(
        next && next.role === 'user' && Array.isArray(next.content)
          ? next.content.filter(isToolResult).map((b) => b.tool_use_id)
          : [],
      );
      const kept = msg.content.filter((b) => !isToolUse(b) || provided.has(b.id));
      if (kept.length > 0) out.push({ ...msg, content: kept });
      continue;
    }

    // user：剔除没有对应 tool_use 的 tool_result
    const prev = out[out.length - 1];
    const known = new Set(
      prev && prev.role === 'assistant' && Array.isArray(prev.content)
        ? prev.content.filter(isToolUse).map((b) => b.id)
        : [],
    );
    const kept = msg.content.filter((b) => !isToolResult(b) || known.has(b.tool_use_id));
    if (kept.length > 0) out.push({ ...msg, content: kept });
  }
  return out;
}
