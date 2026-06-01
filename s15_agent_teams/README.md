# s15: Agent Teams — 消息总线是多 Agent 协作的效应基础

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
// 1. 生成团队成员（逻辑隔离的 Agent 实例）
yield* perform({ type: 'SpawnTeammate', input: { agentId: 'analyzer', role: '代码分析专家' } });

// 2. 发送任务（写入信箱，不等待响应）
yield* perform({ type: 'SendMessage', input: { from: 'main', to: 'analyzer', body: '请分析这段代码' } });

// 3. 检查自己的信箱（非阻塞读取，读后清空）
const replies = yield* perform({ type: 'CheckInbox', input: { agentId: 'main' } });
```

**关键洞见**：消息总线 = 效应的异步路由。`SendMessage` 写 JSONL 文件立即返回，`CheckInbox` 读取并清空信箱，发送方和接收方解耦。

| Python MessageBus | 代数效应 TypeScript |
|------------------|-------------------|
| `MessageBus.send(to, body)` | `SendMessage` Effect |
| `MessageBus.receive(agent_id)` | `CheckInbox` Effect |
| `Agent(role='analyzer')` 实例化 | `SpawnTeammate` Effect |
| JSONL 信箱文件 | Handler 内 `fs.appendFileSync(inboxPath(to))` |

---

## 工作原理

### 信箱文件结构（JSONL 格式）

```
/tmp/learn-claude-code-typescript/s15/inbox/
  main.jsonl      ← 主 Agent 的信箱（接收 analyzer/reviewer 的回复）
  analyzer.jsonl  ← 分析专家的信箱
  reviewer.jsonl  ← 审查专家的信箱
```

每行一条 JSON 消息，`CheckInbox` 读取后清空文件。多条消息自然累积（JSONL append）。

### 异步回复模拟

```typescript
SendMessage: async (effect) => {
  const { from, to, body } = effect.input;
  // 写入目标信箱
  fs.appendFileSync(inboxPath(to), JSON.stringify(msg) + '\n');
  
  // 被动 Agent 自动异步回复（模拟真实子 Agent 延迟处理）
  if (spawned.has(to)) {
    setTimeout(() => {
      const reply = { from: to, to: from, body: `${role} 处理完成: ${body.slice(0, 20)}...` };
      fs.appendFileSync(inboxPath(from), JSON.stringify(reply) + '\n');
    }, 50);
  }
  return { messageId };
}
```

### 消息流

```
主 Agent:
  SpawnTeammate(analyzer) → SpawnTeammate(reviewer)
  SendMessage(main→analyzer, '分析代码')
           │
           │ [50ms 后 analyzer 异步回复]
           ↓
  CheckInbox(main) → [{ from: 'analyzer', body: '分析完成：...' }]
  → 完成
```

---

## 相对 s14 的变更

| 组件 | 之前 (s14) | 之后 (s15) |
|------|-----------|-----------|
| 协作模式 | 单 Agent 管理定时任务 | 多 Agent 消息总线 |
| 通信方式 | 无 Agent 间通信 | JSONL 文件信箱（异步解耦）|
| Agent 数量 | 1 个（主 Agent）| 1 主 + N 子 Agent |
| 新共享状态 | 无 | `spawned` Map + 信箱目录 |
| 新 Effect | — | `SpawnTeammate`、`SendMessage`、`CheckInbox` |

---

## 运行

```bash
npm run s15
```

---

## 本章小结

**Agent 团队 = 多个逻辑 Agent 通过文件信箱异步通信。SpawnTeammate 创建逻辑隔离，SendMessage 写 JSONL 信箱（立即返回），CheckInbox 读取并清空（非阻塞）。消息总线解耦发送时机和接收时机，这是分布式 Agent 协调的核心模式。**

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

教学版只演示了通用文本消息，不区分类型。

### 二、权限冒泡

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
- `messageId`：UUID，用于去重（网络抖动可能导致重发）
- `timestamp`：用于超时检测（消息超过 TTL 未被消费则丢弃）
- `retryCount`：重试次数

教学版省略了去重和 TTL 逻辑。

### 教学版的简化

| 简化项 | 教学版 | CC |
|--------|--------|-----|
| 消息类型 | 通用文本 | 约 15 种语义类型 |
| 权限冒泡 | 无 | `request_resource` → 审核 → 授权 |
| 角色约束 | 无 | `TeamConfig` 工具白名单 |
| 消息去重 | 无 | `messageId` + TTL |
| 子 Agent 实现 | 模拟回复 | 真实独立进程 |

</details>
