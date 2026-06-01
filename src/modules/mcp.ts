export interface McpTool {
  server: string;
  name: string;
  description: string;
  call: (args: Record<string, unknown>) => Promise<string> | string;
}

export class McpToolPool {
  private readonly tools = new Map<string, McpTool>();

  connect(server: string, discovered: Omit<McpTool, "server">[]): string[] {
    const names: string[] = [];
    for (const tool of discovered) {
      const normalized = normalizeMcpName(server, tool.name);
      this.tools.set(normalized, { ...tool, server });
      names.push(normalized);
    }
    return names;
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`未知 MCP 工具: ${name}`);
    return tool.call(args);
  }

  list(): string[] {
    return [...this.tools.keys()].sort();
  }
}

export function normalizeMcpName(server: string, tool: string): string {
  const clean = (value: string) => value.replace(/[^a-zA-Z0-9_]+/g, "_");
  return `mcp__${clean(server)}__${clean(tool)}`;
}
