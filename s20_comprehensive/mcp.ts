/**
 * s20 的 MCP 教学实现（s19）—— 进程内 server + mcp__{server}__{tool} 工具池。
 */

interface MCPServer {
  serverId: string;
  tools: Array<{ name: string; description: string; handler: (args: Record<string, unknown>) => string }>;
}

export const mcpClients = new Map<string, MCPServer>();
export const mcpToolIndex = new Map<string, { serverId: string; toolName: string }>();

// 宿主配置：用户在运行前配置好的 MCP 服务器；宿主在 leadLoop 启动时连接它们。
export const CONFIGURED_MCP_SERVERS = ['docs', 'deploy'];

function mockServer(serverId: string): MCPServer | null {
  if (serverId === 'docs') {
    return {
      serverId,
      tools: [
        {
          name: 'search',
          description: 'Search documentation.',
          handler: (a) =>
            `docs.search("${String(a['query'] ?? '')}") → 3 篇结果：oauth2-pkce, token-refresh, migration-guide`,
        },
        {
          name: 'fetch',
          description: 'Fetch a doc page.',
          handler: (a) => `docs.fetch("${String(a['id'] ?? '')}") → (doc content)`,
        },
      ],
    };
  }
  if (serverId === 'deploy') {
    return {
      serverId,
      tools: [
        {
          name: 'status',
          description: 'Deployment status.',
          handler: () => 'deploy.status() → all services healthy',
        },
      ],
    };
  }
  return null;
}

export function buildMcpToolName(serverId: string, toolName: string): string {
  const norm = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `mcp__${norm(serverId)}__${norm(toolName)}`;
}

export function connectMcp(serverId: string): { serverId: string; toolNames: string[] } {
  const server = mockServer(serverId);
  if (!server) return { serverId, toolNames: [] };
  mcpClients.set(serverId, server);
  const toolNames = server.tools.map((t) => t.name);
  console.log(`  \x1b[34m[MCP] connected '${serverId}' → tools: ${toolNames.join(', ')}\x1b[0m`);
  return { serverId, toolNames };
}

export function callMcpTool(serverId: string, toolName: string, args: Record<string, unknown>): string {
  const server = mcpClients.get(serverId);
  if (!server) return `MCP server '${serverId}' not connected`;
  const tool = server.tools.find((t) => t.name === toolName);
  if (!tool) return `MCP tool '${toolName}' not found on '${serverId}'`;
  return tool.handler(args);
}
