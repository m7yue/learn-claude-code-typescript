# s15: Agent Teams — 消息总线 + 真实的队友子循环

[s14](../s14_cron_scheduler/) → [s15] → [s16](../s16_team_protocols/)

---

## 第一性原理

**问题的本质**：单个 Agent 的能力有限。复杂任务需要多个专家协作——分析专家、审查专家、部署专家。但多个 Agent 如何通信？

直接调用（A 调用 B）会产生紧耦合；共享内存有竞争条件。解法是消息总线：每个 Agent 有独立信箱，通过异步消息传递协调。

---

## 问题

```typescript
// 没有消息总线时，Agent 之间必须直接耦合
const analyzerResult = await runAnalyzerAgent(code);  // 阻塞等待
const reviewerResult = await runReviewerAgent(analyzerResult);  // 串行依赖
```

---

## 代数效应视角

三个 Effect 构建去耦合的 Agent 团队：

```typescript
// 1. 生成团队成员：拉起一个真实队友 Agent（自带 generator + runAgent 子循环）
yield* perform({ type: 'SpawnTeammate', input: { agentId: 'analyzer', role: '代码分析专家' } });

// 2. 发送任务：向目标信箱追加一条 JSONL 消息（不等待响应）
yield* perform({ type: 'SendMessage', input: { from: 'main', to: 'analyzer', body: '请分析这段代码' } });

// 3. 检查自己的信箱：读取并清空（消费式），把队友的 result 注入主对话
const replies = yield* perform({ type: 'CheckInbox', input: { agentId: 'main' } });
```

**关键洞见**：消息总线 = 效应的异步路由。`SendMessage` 向 `.mailboxes/<to>.jsonl` 追加一行立即返回，`CheckInbox` 读取并清空信箱，发送方和接收方解耦。队友不是「被动回复的定时器」，而是真正跑自己的 Agent 循环的 Agent。

| Python MessageBus | 代数效应 TypeScript |
|------------------|-------------------|
| `MessageBus.send(from, to, content)` | `SendMessage` Effect → `fs.appendFileSync` |
| `MessageBus.read_inbox(agent)`（读 + unlink） | `CheckInbox` Effect（读 + 清空） |
| `spawn_teammate_thread(name, role, prompt)` | `SpawnTeammate` Effect → `runAgent(teammateLoop)` |
| 队友线程内 `client.messages.create(...)` | 队友子循环内 `Chat` Effect（mock/real） |

---

## 工作原理

### 1. 信箱文件（JSONL）

```
<WORKSPACE_ROOT>/.mailboxes/
  main.jsonl      ← 主 Agent 的信箱（接收 analyzer/reviewer 的 result）
  analyzer.jsonl  ← 分析专家的信箱（接收 main 派发的任务）
  reviewer.jsonl  ← 审查专家的信箱
```

- 路径来自 `runtime/workspace.ts` 的 `MAILBOXES_DIR`（`AGENT_WORKSPACE` 可覆盖根目录）。
- 每行一条 JSON 消息，消息结构字段：`{ from, to, body, type, timestamp }`。
- `send()` 用 `appendFileSync` 追加一行；`readInbox()` 读出全部行后清空（读完即取走）。
- 并发队友用 `runtime/locks.ts` 的 `Mutex` 加锁（同一时刻只允许一个操作），避免 append / read-clear 交错写坏 JSONL。

### 2. 队友子循环（真实 Agent，不是预设的固定回复）

`spawn_teammate` 的 Handler 会 `runAgent(teammateLoop, s15Handlers)` 起一个**独立的 Agent 循环**：

```typescript
function* teammateLoop(perform, agentId, role) {
  const messages = [{ role: 'user', content: `你是团队成员 '${agentId}'…` }];
  while (workTurns < MAX_TURNS /* =10 */) {
    const inbox = yield* perform({ type: 'CheckInbox', input: { agentId } }); // 读自己的信箱
    if (inbox.length === 0 && !received) {                                    // 还没接到活 → 有界空闲等待
      yield* perform({ type: 'Idle', input: { agentId, ms: POLL_MS } });
      continue;
    }
    if (inbox.length) messages.push({ role: 'user', content: `<inbox>${JSON.stringify(inbox)}</inbox>` });
    const response = yield* perform({ type: 'Chat', input: { messages, agentId } }); // 模型调用（mock/real）
    if (response.stop_reason !== 'tool_use') break;
    // 派发工具：bash / read_file / write_file / send_message（真实 Handler）
  }
  yield* perform({ type: 'SendMessage', input: { from: agentId, to: 'main', body: summary, kind: 'result' } });
  return summary;
}
```

要点：

- 队友有**自己的 `messages`、自己的 generator**，由 `runAgent` 驱动，与主 Agent 走同一套 Effect/Handler 体系。
- 队友工具集：`bash` / `read_file` / `write_file` / `send_message`。
- 教学版上限 `MAX_TURNS = 10` 个「工作轮」；空闲时轮询信箱，`MAX_IDLE` 次后主动放弃，保证进程能退出。
- 主 Agent 查信箱前会 `await`（等它们结束）所有活跃队友，保证 `result` 已写入磁盘；`CheckInbox` 读完后主对话看到队友回复，形成完整往返。
- 队友循环是独立的后台异步循环，模块退出前统一 `awaitTeammates()`，不会挂住进程。

### 3. 消息流（mock 全流程）

```
main: spawn_teammate(analyzer) / spawn_teammate(reviewer)
      │
      │ 队友子循环启动 → 读自己的信箱（空）→ 空闲等待
      ↓
main: send_message(to=analyzer, …) / send_message(to=reviewer, …)
      │  append .mailboxes/analyzer.jsonl / reviewer.jsonl，并唤醒等待中的队友
      ↓
analyzer 子循环: CheckInbox → Chat(轮1: bash) → Chat(轮2: 结果文本) → SendMessage(to=main, type=result)
reviewer 子循环: 同上
      ↓
main: check_inbox(main) → join 队友 → 读到 2 条 result → 结束
```

---

## 相对 s14 的变更

| 组件 | 之前 (s14) | 之后 (s15) |
|------|-----------|-----------|
| 协作模式 | 单 Agent 管理定时任务 | 多 Agent 消息总线 |
| 通信方式 | 无 Agent 间通信 | `.mailboxes/*.jsonl` 信箱（异步解耦）|
| Agent 数量 | 1 个（主 Agent）| 1 主 + N 子 Agent |
| 子 Agent | 无 | 真实子循环（独立 generator + runAgent）|
| 新共享状态 | 无 | `activeTeammates` Map + 信箱目录 |
| 新 Effect | — | `SpawnTeammate`、`SendMessage`、`CheckInbox`、`Idle` |

---

## 运行

```bash
npm run s15
# 用独立工作区跑并观察信箱：
AGENT_WORKSPACE=$(mktemp -d) AGENT_MODE=mock npx tsx s15_agent_teams/agent.ts
ls -la "$AGENT_WORKSPACE/.mailboxes"   # main.jsonl / analyzer.jsonl / reviewer.jsonl
```

---

## 本章小结

**Agent 团队 = 多个真实 Agent 子循环通过文件信箱异步通信。`SpawnTeammate` 拉起独立 generator，`SendMessage` 追加 JSONL 立即返回，`CheckInbox` 读取并清空（读完即取走）。主 Agent 等队友结束后读到 `result`，完成一次完整的任务派发→执行→回报往返。这是分布式 Agent 协调的核心模式。**

---

<details>
<summary>深入 CC 源码</summary>

> 以下基于 CC 源码 `message_bus.ts`、`agent_team.ts` 的分析。

### 一、15 种消息类型

CC 的 `SendMessage` 支持约 15 种消息类型，通过 `type` 字段路由：

| 消息类型 | 用途 |
|---------|------|
| `task_assign` | 主 Agent 分配任务 |
| `task_complete` | 子 Agent 汇报完成 |
| `task_failed` | 子 Agent 报告失败 |
| `progress_update` | 进度百分比汇报 |
| `request_resource` | 请求文件/工具权限 |
| `resource_granted` | 权限批准响应 |
| `plan_request` | 请求计划（对接 s16）|
| `plan_review` | 计划审查响应 |
| `shutdown_request` | 请求关闭 |
| `shutdown_ack` | 关闭确认 |
| `heartbeat` | 心跳（存活检查）|
| `cron_trigger` | 定时触发（对接 s14）|
| `mcp_notification` | MCP 推送（对接 s19）|
| `error_report` | 错误上报 |
| `debug_log` | 调试信息 |

教学版消息结构保留 `type` 字段，但只用到 `message` / `result` 两种。

### 二、权限逐级上报

CC 中子 Agent 无法直接访问文件或工具——它必须向父 Agent 发送 `request_resource` 消息，父 Agent 确认后回复 `resource_granted`。这是权限边界的实现方式：

```
子 Agent → request_resource → 父 Agent → 审核 → resource_granted/denied
```

教学版无此机制，子 Agent 的 Handler 直接访问文件系统。

### 三、team config 与角色约束

CC 允许在启动时定义 `TeamConfig`，约束每个角色的工具访问权：

```json
{
  "analyzer": { "allowedTools": ["read_file", "bash_read_only"] },
  "deployer": { "allowedTools": ["bash", "write_file"] }
}
```

角色不在 `allowedTools` 中的工具调用会被拦截。教学版无此约束。

### 四、信箱持久化与消息去重

CC 的 JSONL 信箱有额外字段：
- `messageId`：UUID，用于去重（网络随机延时可能导致重发）
- `timestamp`：用于超时检测（消息超过时限还没被读取就丢弃）
- `retryCount`：重试次数

教学版消息结构有 `from/to/body/type/timestamp`，省略了去重和超时丢弃逻辑。

### 教学版的简化

| 简化项 | 教学版 | CC |
|--------|--------|-----|
| 消息类型 | `message` / `result` 两种 | 约 15 种语义类型 |
| 权限逐级上报 | 无 | `request_resource` → 审核 → 授权 |
| 角色约束 | 无 | `TeamConfig` 工具白名单 |
| 消息去重 | 无 | `messageId` + 超时丢弃 |
| 子 Agent 存活 | 有上限的循环（spawn→干活→回报→退出）| 空闲循环常驻，等待 `shutdown_request` |
| 并发模型 | 同进程 async 子循环（等它们结束，保证退出）| 独立进程/线程 |

</details>
