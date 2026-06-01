---
name: mcp-builder
description: 构建 MCP（Model Context Protocol）服务器，为 Agent 提供新的工具和资源。Use when user wants to create an MCP server, add tools to Claude, or integrate external services.
---

# MCP Builder Skill

帮助用户创建符合 MCP 规范的服务器，使 Agent 能够动态发现和调用外部工具。

## MCP 基础概念

MCP 服务器通过标准协议向 Agent 暴露：
- **Tools** — 可调用的函数（如 `gh_create_pr`、`db_query`）
- **Resources** — 可读取的数据（如文件、数据库记录）
- **Prompts** — 预定义的提示词模板

## 创建 MCP 服务器（TypeScript）

### 1. 初始化项目
```bash
npm init -y
npm install @modelcontextprotocol/sdk
```

### 2. 定义工具
```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server({ name: 'my-mcp', version: '1.0.0' });

server.setRequestHandler('tools/list', async () => ({
  tools: [{
    name: 'my_tool',
    description: '工具描述',
    inputSchema: {
      type: 'object',
      properties: { param: { type: 'string' } },
      required: ['param'],
    },
  }],
}));

server.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args } = request.params;
  if (name === 'my_tool') {
    const result = doSomething(args.param);
    return { content: [{ type: 'text', text: result }] };
  }
  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

### 3. 在 Agent 中使用（MCPConnect Effect）
```typescript
const server = yield* perform({
  type: 'MCPConnect',
  input: { serverUrl: 'mcp://localhost', serverId: 'my-mcp' }
});
// server.tools 包含动态发现的工具列表
```

## 常见用例
- GitHub PR 管理
- 数据库查询
- Slack 消息发送
- 自定义业务 API

## 输出

提供完整的 MCP 服务器代码和测试方法。
