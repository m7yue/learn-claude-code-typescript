import type { Message } from "../core/types.ts";

export function estimateTokens(messages: Message[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

export function microCompact(messages: Message[], keepLastToolResults = 3): Message[] {
  const toolIndexes = messages
    .map((message, index) => ({ message, index }))
    .filter((item) => item.message.role === "tool")
    .map((item) => item.index);
  const compactBefore = Math.max(0, toolIndexes.length - keepLastToolResults);
  const toCompact = new Set(toolIndexes.slice(0, compactBefore));

  return messages.map((message, index) => {
    if (!toCompact.has(index) || message.content.length < 240) return message;
    return {
      ...message,
      content: `${message.content.slice(0, 120)}\n...[已微压缩 ${message.content.length} 字符]`,
    };
  });
}

export function summarizeMessages(messages: Message[]): string {
  const counts = messages.reduce<Record<string, number>>((acc, message) => {
    acc[message.role] = (acc[message.role] ?? 0) + 1;
    return acc;
  }, {});
  return [
    `消息数: ${messages.length}`,
    `角色分布: ${JSON.stringify(counts)}`,
    `最近消息: ${messages[messages.length - 1]?.content.slice(0, 120) ?? "(empty)"}`,
  ].join("\n");
}
