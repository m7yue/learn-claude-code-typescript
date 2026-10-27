/** 构造模拟 LLM 响应块的辅助函数。 */

import type { TextBlock, ToolUseBlock } from '../runtime/types.ts';

export const textBlock = (text: string): TextBlock => ({ type: 'text', text });

export const toolUse = (
  id: string,
  name: string,
  input: Record<string, unknown>,
): ToolUseBlock => ({ type: 'tool_use', id, name, input });
