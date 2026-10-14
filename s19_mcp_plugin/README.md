# s19: MCP Plugin — 外部工具是动态发现的效应

[s18](../s18_worktree_isolation/) → [s19] → [s20](../s20_comprehensive/)

---

## 第一性原理

**问题的本质**：Agent 的工具集不应该是编译时写死的。GitHub、数据库、Slack、自定义 API——这些工具来自不同系统，由不同团队维护，需要在运行时动态集成。

MCP（Model Context Protocol）= 工具的动态发现协议。Agent 连接服务器，服务器告知可用工具，Agent 按需调用。

---

## 问题

```typescript
// 没有 MCP 时，每个工具都要硬编码
switch (block.name) {
  case 'bash': ...
  case 'github_create_pr': ...  // 和 GitHub API 紧耦合
  case 'db_query': ...          // 和数据库紧耦合
}
// 问题：加新工具 = 修改代码 + 重新部署
```

---

## 代数效应视角

三个 Effect 实现动态工具发现和调用：

```typescript
// 1. 连接 MCP 服务器，获取工具目录（模拟 tools/list JSON-RPC）
const server = yield* perform({
  type: 'MCPConnect',
  input: { serverUrl: 'mcp://github.tools', serverId: 'github-mcp' }
});
// server.tools: ['gh_list_prs', 'gh_create_pr', 'gh_review_pr']

// 2. 合并本地工具和 MCP 工具，生成 mcp__{server}__{tool} 前缀名
const toolPool = yield* perform({
  type: 'AssembleToolPool',
  input: { localTools: LOCAL_TOOLS, mcpServers: connectedServers }
});
// toolPool 含 'mcp__github-mcp__gh_list_prs' 等规范化名称

// 3. 透明调用 MCP 工具（Generator 只管路由，不关心是本地还是远程）
const result = yield* perform({
  type: 'MCPToolCall',
  input: { serverId: 'github-mcp', toolName: 'gh_list_prs', args: { repo: 'myorg/myrepo' } }
});
```

| Python | 代数效应 TypeScript |
|--------|-------------------|
| `MCPClient.register(tool_defs, handlers)` | `MCPConnect` Effect（模拟 tools/list） |
| `client.call_tool(name, args)` | `MCPToolCall` Effect（模拟 tools/call） |
| `normalize_mcp_name(name)` | `normalizeMcpName()` — 相同规则 |
| `assemble_tool_pool()` | `AssembleToolPool` Effect |
| `mcp__{server}__{tool}` 前缀 | 同样命名约定，Handler 中生成 |

---

## 工作原理

### MCPClient：发现 + 调用

```typescript
class MCPClient {
  register(toolDefs: ToolDef[], handlers: Record<string, Handler>): void
  // 模拟 tools/list：注册工具定义和处理器

  callTool(toolName: string, args: Record<string, unknown>): string
  // 模拟 tools/call：路由到对应处理器
}
```

教学版用 TypeScript 函数模拟 server 的工具实现。真实版通过 stdio JSON-RPC 与子进程通信。

### 命名规范化：mcp__{server}__{tool}

```typescript
// 对应 CC 源码 normalization.ts:17-23
function normalizeMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// 对应 CC 源码 mcpStringUtils.ts:50-52 的 buildMcpToolName()
function buildMcpToolName(serverId: string, toolName: string): string {
  return `mcp__${normalizeMcpName(serverId)}__${normalizeMcpName(toolName)}`;
}
```

所有非 `[a-zA-Z0-9_-]` 字符替换为 `_`。连字符 `-` 是合法字符，保留不变。这使 `github-mcp` 服务器的 `gh_list_prs` 工具生成 `mcp__github-mcp__gh_list_prs`。

### AssembleToolPool：组装工具池

```typescript
// 本地工具保持原名，MCP 工具添加前缀
for (const [serverId, client] of mcpClients.entries()) {
  for (const tool of client.tools) {
    mcpToolDefs.push({
      ...tool,
      name: buildMcpToolName(serverId, tool.name),
      serverId,
    });
  }
}
// 本地工具优先（内置工具前置，名称冲突时保留内置）
return [...localTools, ...mcpToolDefs];
```

工具池更新后立即生效：下一轮 LLM 调用时，模型可以看到所有 `mcp__*` 工具。

### 透明路由（Generator 中）

```typescript
const mcpTool = currentToolPool.find(t => t.name === block.name && t.source === 'mcp');

if (mcpTool) {
  // 从前缀名还原原始工具名，透明转发给 MCPClient
  const rawToolName = client.tools.find(t =>
    buildMcpToolName(serverId, t.name) === block.name
  )?.name;
  output = yield* perform({ type: 'MCPToolCall', input: { serverId, toolName: rawToolName, args } });
} else {
  switch (block.name) { ... } // 本地工具
}
```

LLM 调用 `mcp__github-mcp__gh_list_prs`，Generator 识别为 MCP 工具，路由到 `MCPToolCall`，还原为 `gh_list_prs` 调用——LLM 和本地工具逻辑都看不到这个路由过程。

### 无 Prompt 缓存

连接新 MCP 服务器后工具池变化，缓存的旧工具列表会失效。s19 去掉了 prompt 缓存——代价是每轮多花一点序列化时间，收益是工具池始终反映最新状态。

---

## 相对 s18 的变更

| 组件 | 之前 (s18) | 之后 (s19) |
|------|-----------|-----------|
| 工具来源 | 全部手写 builtin | 手写 + MCP 外部工具动态发现 |
| 工具池 | 固定工具集合 | `AssembleToolPool` 动态组装 `mcp__` 前缀工具 |
| 名称安全 | 无 | `normalizeMcpName` 规范化 |
| 新类 | — | `MCPClient`（模拟 tools/list + tools/call） |
| 命名空间 | — | `mcp__{server}__{tool}` 避免冲突 |
| 工具描述 | 无标注 | `(readOnly)` / `(destructive)` 标注 |
| 新 Effect | — | `MCPConnect`、`MCPToolCall`、`AssembleToolPool` |

---

## 运行

```bash
npm run s19
```

---

## 本章小结

**MCP = 动态工具发现的效应协议。`MCPClient` 封装 tools/list + tools/call 协议，`normalizeMcpName` 保证命名安全，`mcp__{server}__{tool}` 前缀避免多服务器工具名冲突，`AssembleToolPool` 构建统一工具池。Generator 通过 `tool.source` 路由，对 LLM 完全透明——这就是代数效应让"扩展不需要修改核心逻辑"的体现。**

---

<details>
<summary>深入 CC 源码</summary>

> 以下基于 CC 源码 `services/mcp/client.ts`、`auth.ts`、`config.ts`、`channelNotification.ts` 的分析。

### 一、6 种 Transport 类型

教学版只展示了 mock 的 stdio 模式。CC 支持 6 种传输：

| Transport | 通信方式 |
|-----------|---------|
| `stdio` | 子进程 stdin/stdout（跨平台默认） |
| `sse` | HTTP Server-Sent Events |
| `http` | Streamable HTTP（POST/SSE 双向） |
| `ws` | WebSocket |
| `sse-ide` | IDE 内嵌 SSE 传输 |
| `sdk` | 进程内 SDK 传输 |

连接时本地（stdio）和远程（http/sse/ws）服务器分批并发：本地批量 3 个，远程批量 20 个。

### 二、工具池组装算法

`assembleToolPool()`（`tools.ts:345-364`）：

```typescript
// 去重时优先保留内置工具（name 相同时内置在前）
return uniqBy(
  [...builtInTools.sort(byName), ...filteredMcpTools.sort(byName)],
  'name',
)
```

内置工具和 MCP 工具**分开排序**，不是合起来排。原因是 CC 的 `claude_code_system_cache_policy` 在最后一个内置工具之后某个位置放全局缓存断点——混排会破坏这个设计。教学版 `[...localTools, ...mcpToolDefs]` 保留了这个顺序约定。

### 三、权限检查

CC 对 MCP 工具有独立的权限系统。MCP 工具可以声明自己的权限需求（readOnly、destructive 等），CC 根据声明决定是否需要用户确认。教学版只在 description 中用文本标注 `(readOnly)` / `(destructive)`，不做权限拦截。

### 四、配置来源与优先级

MCP 服务器配置来自多个来源。CC 的配置优先级从低到高：

```
claude.ai 连接器 < plugin < user settings.json
  < approved project .mcp.json < local settings.local.json
```

`claude.ai` 连接器单独拉取、按内容签名去重，以最低优先级合并（`config.ts:1267-1289`）。企业 `managed-mcp.json` 存在时完全排除其他配置。教学版直接传 `serverId` 到工厂函数，不做配置合并。

### 五、Channel 通知：服务器反向推消息

教学版只讲了 Agent → MCP Server 的单向调用。CC 还支持反向通知（`channelNotification.ts`）：

1. Server 声明 `capabilities.experimental['claude/channel']`
2. Server 通过 `notifications/claude/channel` 向 Agent 发消息
3. 消息包装在 `<channel source="serverName">...</channel>` XML 标签中
4. Agent 被 SleepTool 唤醒（1 秒内）

Server 还可以请求权限：`permission_request` → Agent 回复 → 用户通过 5 字母短 ID 确认/拒绝。

### 六、OAuth 认证流程

CC 的 MCP 认证（`auth.ts`）支持完整的 OAuth 2.0 + PKCE 流程：
- 通过公钥客户端 + PKCE 发现 OAuth 元数据（RFC 8414 / RFC 9728）
- 本地回调服务器接收授权码
- 令牌通过 `getSecureStorage()` 持久化（macOS Keychain / Linux 加密文件 / Windows 凭据管理器）
- 过期前 5 分钟自动刷新
- 支持跨应用访问（XAA）：浏览器获取 id_token → RFC 8693 + RFC 7523 交换 → 无需反复弹浏览器

教学版假设 server 不需要认证，省略整个 OAuth 流程。

### 七、连接生命周期的错误处理

CC 对 MCP 连接有精细的错误分类和重试（`client.ts:1266-1402`）：
- 无法恢复的错误（ECONNRESET、ETIMEDOUT、EPIPE 等）：连续 3 次 → 关闭 + 重连
- 工具调用 401：令牌过期 → 抛出 `McpAuthError` → 触发重认证
- 工具调用超时：`Promise.race` 超时（可配置，默认约 28 小时）
- Stdio 断连：按 SIGINT → SIGTERM → SIGKILL 顺序杀进程

教学版只用 `throw new Error(...)` 简单抛出错误，不做错误分类。

### 教学版的简化

| 简化项 | 教学版 | CC |
|--------|--------|-----|
| Transport | mock 函数 | 6 种（stdio/sse/http/ws/sse-ide/sdk） |
| Channel 通知 | 省略 | Server 可反向推消息给 Agent |
| OAuth | 省略 | 完整 PKCE 流程 + 令牌持久化 |
| 配置合并 | 直接传 serverId | 多层优先级合并 |
| 错误分类 | throw Error | 无法恢复的错误 / 401 / 超时 / 断连分类处理 |
| MCP 工具权限 | description 文本标注 | 独立权限系统 |

</details>
