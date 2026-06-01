import type { Message, Model, ModelTurn, ToolDefinition } from "./types.ts";

export class ScriptedModel implements Model {
  private index = 0;
  private readonly turns: ModelTurn[];

  constructor(turns: ModelTurn[]) {
    this.turns = turns;
  }

  async complete(_input: { system: string; messages: Message[]; tools: ToolDefinition[] }): Promise<ModelTurn> {
    const turn = this.turns[Math.min(this.index, this.turns.length - 1)];
    this.index += 1;
    return turn;
  }
}

export function toolTurn(name: string, args: Record<string, unknown>, content = `调用工具: ${name}`): ModelTurn {
  return {
    stopReason: "tool_use",
    content,
    toolUses: [{ id: crypto.randomUUID(), name, args }],
  };
}

export function finalTurn(content: string): ModelTurn {
  return { stopReason: "end", content };
}
