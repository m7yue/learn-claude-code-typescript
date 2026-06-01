export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
  name?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface ToolUse {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type ModelTurn =
  | { stopReason: "end"; content: string; toolUses?: never }
  | { stopReason: "tool_use"; content: string; toolUses: ToolUse[] };

export interface Model {
  complete(input: {
    system: string;
    messages: Message[];
    tools: ToolDefinition[];
  }): Promise<ModelTurn>;
}
