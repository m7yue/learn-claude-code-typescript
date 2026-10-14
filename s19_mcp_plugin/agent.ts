/**
 * s19: MCP Plugin — 外部工具是动态发现的效应
 *
 * 本章新增 3 个 Effect：
 *   MCPConnect       — 连接 MCP 服务器，获取工具目录
 *   MCPToolCall      — 调用 MCP 工具（类型安全的远程过程调用）
 *   AssembleToolPool — 合并本地工具和 MCP 工具为统一工具池
 *
 * 核心思想：MCP = 动态工具发现的效应协议
 * 工具不再是编译时硬编码，而是运行时从服务器动态获取。
 * AssembleToolPool 将本地工具和远程 MCP 工具合并为统一接口，
 * 使用 mcp__{server}__{tool} 前缀避免命名冲突。
 *
 * 数据流：
 *
 *   mcp_connect(serverId)
 *        │  MCPConnect → MCPClient.register(...)（模拟 tools/list，登记工具目录）
 *        ▼
 *   assemble_tool_pool
 *        │  AssembleToolPool：本地工具 + 规范化后的 mcp__{server}__{tool}
 *        ▼
 *   currentToolPool —— 唯一的工具来源；Chat 每轮把它作为 tools 传给模型
 *        │
 *        ▼  模型发出 mcp__{server}__{tool} 调用
 *   按名称在池中查到对应 MCP 工具 → 还原原始工具名 → MCPToolCall（模拟 tools/call）
 */

import { runAgent } from '../runtime/core.ts';
import type { Effect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolResultBlock } from '../runtime/types.ts';
import { extractText, getToolUseBlocks } from '../runtime/response.ts';
import { callChat } from '../runtime/model.ts';
import type { ToolInputSchema } from '../runtime/model.ts';
import { buildSystemPrompt } from '../runtime/system-prompt.ts';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

interface ChatEffect extends Effect<'Chat', { messages: Message[]; tools: ToolDef[] }, LLMResponse> {}

interface BashExecEffect extends Effect<'BashExec', { command: string }, string> {}

interface ToolDef {
  name: string;
  description: string;
  source: 'local' | 'mcp';
  serverId?: string;
  schema?: ToolInputSchema;
}

interface MCPServer {
  id: string;
  name: string;
  tools: ToolDef[];
}

// s19 新增：MCP 动态工具
interface MCPConnectEffect extends Effect<'MCPConnect', { serverUrl: string; serverId: string }, MCPServer> {}

interface MCPToolCallEffect extends Effect<'MCPToolCall', { serverId: string; toolName: string; args: Record<string, unknown> }, string> {}

interface AssembleToolPoolEffect extends Effect<'AssembleToolPool', { localTools: ToolDef[]; mcpServers: MCPServer[] }, ToolDef[]> {}

type S19Effect = ChatEffect | BashExecEffect | MCPConnectEffect | MCPToolCallEffect | AssembleToolPoolEffect;

// ============================================================
// Part 2: Handler 实现（MCP 协议模拟）
// ============================================================

// 名称规范化：将非 [a-zA-Z0-9_-] 字符替换为 _
// 对应 CC 源码 normalization.ts:17-23
function normalizeMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// 生成工具全局唯一名称：mcp__{server}__{tool}
// 对应 CC 源码 mcpStringUtils.ts:50-52 的 buildMcpToolName()
function buildMcpToolName(serverId: string, toolName: string): string {
  return `mcp__${normalizeMcpName(serverId)}__${normalizeMcpName(toolName)}`;
}

// MCPClient：模拟 MCP Server 的 tools/list + tools/call 协议
// 真实实现通过 stdio JSON-RPC 与子进程通信（CC 支持 6 种 Transport）
class MCPClient {
  readonly serverId: string;
  tools: ToolDef[] = [];
  private _handlers = new Map<string, (args: Record<string, unknown>) => string>();

  constructor(serverId: string) {
    this.serverId = serverId;
  }

  // 模拟 tools/list 响应：注册工具定义和处理器
  register(
    toolDefs: ToolDef[],
    handlers: Record<string, (args: Record<string, unknown>) => string>,
  ): void {
    this.tools = toolDefs;
    for (const [name, handler] of Object.entries(handlers)) {
      this._handlers.set(name, handler);
    }
  }

  // 模拟 tools/call：调用工具处理器
  callTool(toolName: string, args: Record<string, unknown>): string {
    const handler = this._handlers.get(toolName);
    if (!handler) return `MCP error: unknown tool '${toolName}'`;
    return handler(args);
  }
}

// 已连接的 MCP 客户端注册表
const mcpClients = new Map<string, MCPClient>();

// Mock MCP Server 工厂（教学用；真实实现启动子进程，通过 stdin/stdout 发送 JSON-RPC 请求）
function createGithubMcpClient(): MCPClient {
  const client = new MCPClient('github-mcp');
  client.register(
    [
      { name: 'gh_list_prs', description: '列出 Pull Requests (readOnly)', source: 'mcp', serverId: 'github-mcp' },
      { name: 'gh_create_pr', description: '创建 Pull Request (destructive)', source: 'mcp', serverId: 'github-mcp' },
      { name: 'gh_review_pr', description: '审查 Pull Request (readOnly)', source: 'mcp', serverId: 'github-mcp' },
    ],
    {
      gh_list_prs: (args) => JSON.stringify([
        { id: 42, title: '修复认证 bug', state: 'open', repo: args['repo'] },
        { id: 43, title: '添加测试', state: 'open', repo: args['repo'] },
      ]),
      gh_create_pr: (args) => JSON.stringify({ pr_url: `https://github.com/${args['repo']}/pull/44`, title: args['title'] }),
      gh_review_pr: (args) => JSON.stringify({ pr: args['pr_id'], status: 'approved', comments: [] }),
    },
  );
  return client;
}

function createDatabaseMcpClient(): MCPClient {
  const client = new MCPClient('database-mcp');
  client.register(
    [
      { name: 'db_query', description: '执行 SQL 查询 (readOnly)', source: 'mcp', serverId: 'database-mcp' },
      { name: 'db_schema', description: '获取数据库 schema (readOnly)', source: 'mcp', serverId: 'database-mcp' },
    ],
    {
      db_query: (args) => JSON.stringify([{ 'COUNT(*)': 1234, sql: args['sql'] }]),
      db_schema: () => JSON.stringify({ tables: ['users', 'orders', 'products'] }),
    },
  );
  return client;
}

const MOCK_SERVER_FACTORIES: Record<string, () => MCPClient> = {
  'github-mcp': createGithubMcpClient,
  'database-mcp': createDatabaseMcpClient,
};

// Mock LLM：连接 MCP → 组装工具池（含 mcp__ 前缀）→ 调用 MCP 工具
const mockResponses = [
  // 轮1：连接两个 MCP 服务器
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '连接外部 MCP 服务器。' },
      { type: 'tool_use' as const, id: 'm1', name: 'mcp_connect', input: { serverUrl: 'mcp://github.tools', serverId: 'github-mcp' } },
      { type: 'tool_use' as const, id: 'm2', name: 'mcp_connect', input: { serverUrl: 'mcp://db.tools', serverId: 'database-mcp' } },
    ],
  },
  // 轮2：组装工具池（工具名将带 mcp__ 前缀）
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '组装工具池，MCP 工具带规范化前缀。' },
      { type: 'tool_use' as const, id: 'm3', name: 'assemble_tool_pool', input: {} },
    ],
  },
  // 轮3：调用 mcp__github-mcp__gh_list_prs（连字符保留，normalizeMcpName 只替换非法字符）
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '使用 GitHub MCP 工具列出 PR。' },
      { type: 'tool_use' as const, id: 'm4', name: 'mcp__github-mcp__gh_list_prs', input: { repo: 'myorg/myrepo', state: 'open' } },
    ],
  },
  // 轮4：调用 mcp__database-mcp__db_query
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '查询数据库用户数量。' },
      { type: 'tool_use' as const, id: 'm5', name: 'mcp__database-mcp__db_query', input: { sql: 'SELECT COUNT(*) FROM users' } },
    ],
  },
  // 轮5：结束
  {
    stop_reason: 'end_turn' as const,
    content: [{ type: 'text' as const, text: 'MCP 插件演示完成：动态发现→mcp__ 前缀工具池→透明调用。' }],
  },
];

let roundIndex = 0;
const connectedServers: MCPServer[] = [];
/** 最近一次装配的工具池，用于把带 mcp__ 前缀的工具名透明路由回原始工具。 */
let currentToolPool: ToolDef[] = [];

function mockLLM(_messages: Message[], _tools: ToolDef[]): LLMResponse {
  return mockResponses[Math.min(roundIndex++, mockResponses.length - 1)] as LLMResponse;
}

const s19Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages, tools } = effect.input;
    const round = messages.filter(m => m.role === 'assistant').length;
    console.log(`\n[Chat] → 轮次 ${round + 1} (工具池: ${tools.length} 个)`);
    const localTools = tools.filter(t => t.source === 'local').map(t => t.name);
    const mcpTools = tools.filter(t => t.source === 'mcp').map(t => t.name);
    if (localTools.length) console.log(`  本地: ${localTools.join(', ')}`);
    if (mcpTools.length) console.log(`  MCP:  ${mcpTools.join(', ')}`);
    const mcpNames = [...new Set(tools.filter(t => t.source === 'mcp').map(t => t.serverId).filter((id): id is string => Boolean(id)))];
    // real 模式注入的 system prompt，引导模型使用工具完成任务。
    // mock 模式不读取该字段，故零配置运行行为不变。
    const systemPrompt = buildSystemPrompt(
      '使用内置工具和已连接的 MCP 工具解决任务。使用某个 server 前先调用 mcp_connect 连接。',
      mcpNames.length ? `已连接的 MCP 服务器：${mcpNames.join('、')}` : '',
    );
    await new Promise(r => setTimeout(r, 30));
    return callChat((m) => mockLLM(m, tools), messages, {
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema ?? { type: 'object', properties: {} } })),
      system: systemPrompt,
    });
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    console.log(`[BashExec] → ${effect.input.command}`);
    return `(执行: ${effect.input.command})`;
  },

  MCPConnect: async (effect: MCPConnectEffect): Promise<MCPServer> => {
    const { serverId, serverUrl } = effect.input;
    if (mcpClients.has(serverId)) {
      console.log(`[MCPConnect] '${serverId}' 已连接，跳过`);
      return connectedServers.find(s => s.id === serverId)!;
    }
    const factory = MOCK_SERVER_FACTORIES[serverId];
    if (!factory) {
      throw new Error(`未知 MCP 服务器: ${serverId}。可用: ${Object.keys(MOCK_SERVER_FACTORIES).join(', ')}`);
    }
    const client = factory();
    mcpClients.set(serverId, client);
    const server: MCPServer = { id: serverId, name: serverId, tools: client.tools };
    connectedServers.push(server);
    console.log(`[MCPConnect] 连接: ${serverId} (${serverUrl})`);
    console.log(`  发现工具: ${client.tools.map(t => t.name).join(', ')}`);
    return server;
  },

  MCPToolCall: async (effect: MCPToolCallEffect): Promise<string> => {
    const { serverId, toolName, args } = effect.input;
    const client = mcpClients.get(serverId);
    if (!client) return `[MCP 错误] 服务器未连接: ${serverId}`;
    console.log(`[MCPToolCall] ${serverId}/${toolName}(${JSON.stringify(args)})`);
    const result = client.callTool(toolName, args);
    console.log(`  结果: ${result}`);
    return result;
  },

  AssembleToolPool: async (effect: AssembleToolPoolEffect): Promise<ToolDef[]> => {
    const { localTools } = effect.input;
    // 合并为统一工具池：本地工具保留原名，MCP 工具统一加 mcp__{server}__{tool} 前缀，
    // 两者命名空间天然隔离，不会冲突。
    const mcpToolDefs: ToolDef[] = [];
    for (const [serverId, client] of mcpClients.entries()) {
      for (const tool of client.tools) {
        mcpToolDefs.push({
          ...tool,
          name: buildMcpToolName(serverId, tool.name),
          serverId,
        });
      }
    }
    const pool = [...localTools, ...mcpToolDefs];
    currentToolPool = pool;
    console.log(`[AssembleToolPool] ${localTools.length} 本地 + ${mcpToolDefs.length} MCP = ${pool.length} 总计`);
    if (mcpToolDefs.length > 0) {
      console.log(`  MCP 工具（规范化前缀）:`);
      mcpToolDefs.forEach(t => console.log(`    ${t.name}`));
    }
    return pool;
  },
};

// ============================================================
// Part 3: Agent Generator
// ============================================================

const LOCAL_TOOLS: ToolDef[] = [
  { name: 'bash', description: '执行 shell 命令', source: 'local' },
  { name: 'mcp_connect', description: '连接 MCP 服务器，动态发现工具', source: 'local' },
  { name: 'assemble_tool_pool', description: '组装工具池（本地 + MCP，生成 mcp__ 前缀名称）', source: 'local' },
];

function* agentLoop(perform: PerformFn<S19Effect>) {
  const messages: Message[] = [
    { role: 'user', content: '连接 GitHub 和数据库 MCP 服务器，组装工具池，然后查询 PR 列表和用户数量。' },
  ];
  let tools: ToolDef[] = LOCAL_TOOLS;

  while (true) {
    const response = yield* perform({ type: 'Chat', input: { messages, tools } });
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      return extractText(response);
    }

    const toolResults: ToolResultBlock[] = [];

    for (const block of getToolUseBlocks(response)) {
      try {
        let output: string;

        // 透明路由：按名称在工具池中查找是否是 MCP 工具
        const mcpTool = currentToolPool.find(t => t.name === block.name && t.source === 'mcp');

        if (mcpTool) {
          // 从前缀名称还原原始工具名：mcp__{server}__{tool} → tool
          const client = mcpClients.get(mcpTool.serverId!);
          const rawToolName = client?.tools.find(t =>
            buildMcpToolName(mcpTool.serverId!, t.name) === block.name
          )?.name ?? block.name;

          output = yield* perform({
            type: 'MCPToolCall',
            input: { serverId: mcpTool.serverId!, toolName: rawToolName, args: block.input as Record<string, unknown> },
          });
        } else {
          switch (block.name) {
            case 'bash':
              output = yield* perform({ type: 'BashExec', input: { command: block.input['command'] as string } });
              break;
            case 'mcp_connect': {
              const server = yield* perform({
                type: 'MCPConnect',
                input: { serverUrl: block.input['serverUrl'] as string, serverId: block.input['serverId'] as string },
              });
              output = `已连接: ${server.id}，发现 ${server.tools.length} 个工具`;
              break;
            }
            case 'assemble_tool_pool': {
              tools = yield* perform({
                type: 'AssembleToolPool',
                input: { localTools: LOCAL_TOOLS, mcpServers: connectedServers },
              });
              output = `工具池已更新: ${tools.length} 个工具`;
              break;
            }
            default:
              output = `[未知工具] ${block.name}`;
          }
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: output });
      } catch (err) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `[错误] ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        });
      }
    }

    messages.push({
      role: 'user',
      content: toolResults,
    });
  }
}

// ============================================================
// Part 4: 启动入口
// ============================================================

console.log('[S19] MCP Plugin 启动\n');
console.log('命名规范: mcp__{server}__{tool}（非法字符替换为 _）\n');

const result = await runAgent<S19Effect, string>(agentLoop, s19Handlers);

console.log('\n[S19] 完成:', result);
