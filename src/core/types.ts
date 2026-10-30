import type { ToolInputSchema } from "../../runtime/model.ts";
import type { LLMUsage } from "../../runtime/types.ts";

export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
  name?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: ToolInputSchema;
}

export interface ToolUse {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * 模型的一次回合。usage 来自真实请求（mock 没有）；
 * stopReason 为 max_tokens 表示回答被截断，而不是正常结束。
 */
export type ModelTurn =
  | { stopReason: "end"; content: string; toolUses?: never; usage?: LLMUsage }
  | { stopReason: "max_tokens"; content: string; toolUses?: never; usage?: LLMUsage }
  | { stopReason: "tool_use"; content: string; toolUses: ToolUse[]; usage?: LLMUsage };

export interface Model {
  complete(input: {
    system: string;
    messages: Message[];
    tools: ToolDefinition[];
  }): Promise<ModelTurn>;
}
