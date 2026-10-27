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

三个团队 Effect + 一个内部等待 Effect：

```typescript
// 1. 生成并派活：prompt 就是队友要执行的任务，队友立即开工
yield* perform({
  type: 'SpawnTeammate',
  input: { agentId: 'analyzer', role: '代码分析专家', prompt: '阅读 s15_agent_teams/.output/analyzer_sample.ts，分析代码复杂度' },
});

// 2. 发送后续消息：向目标信箱追加一条 JSONL 消息（不等待响应）
yield* perform({ type: 'SendMessage', input: { from: 'main', to: 'analyzer', body: '补充：重点关注错误处理' } });

// 3. 非阻塞查看自己的信箱：读取并清空（消费式）
const replies = yield* perform({ type: 'CheckInbox', input: { agentId: 'main' } });

// 4. 内部等待：lead 在 end_turn 后等活跃队友，不暴露给模型
yield* perform({ type: 'WaitForTeammates', input: { timeoutMs: 90_000 } });
```

**关键洞见**：消息总线 = 效应的异步路由。`SpawnTeammate` 在启动队友时就把任务放进它的第一条用户消息，队友不需要先等信箱；`SendMessage` 向 `.mailboxes/s15/<to>.jsonl` 追加一行立即返回；`CheckInbox` 读取并清空信箱；lead 的队友结果在回合结束时由宿主自动注入对话。

---

## 工作原理

### 1. 信箱文件（JSONL）

```
<WORKSPACE_ROOT>/.mailboxes/s15/
  main.jsonl      ← 主 Agent 的信箱（接收 analyzer/reviewer 的 result）
  analyzer.jsonl  ← 分析专家的信箱（接收 main 的后续消息）
  reviewer.jsonl  ← 审查专家的信箱
```

- 路径来自 `runtime/workspace.ts` 的 `MAILBOXES_DIR`，本章再下沉一层 `s15/`，避免和 s16/s17/s20 的旧消息互相污染。
- 启动时只清空 `.mailboxes/s15/`，并预先创建 `main.jsonl` 和每个 spawn 的队友信箱；读完文件会清空，所以跑完看到的是 0 字节文件，消息流看 `[bus]` / `[Inbox]` 日志。
- 每行一条 JSON 消息，消息结构字段：`{ from, to, body, type, timestamp }`。
- `send()` 用 `appendFileSync` 追加一行；`readInbox()` 读出全部行后清空（读完即取走）。

### 2. 队友子循环（真实 Agent，不是预设的固定回复）

`spawn_teammate` 的 Handler 会 `runAgent(teammateLoop, s15Handlers)` 起一个**独立的 Agent 循环**：

```typescript
function* teammateLoop(perform, agentId, prompt) {
  const messages = [{ role: 'user', content: prompt }];       // spawn 时任务已经在手里
  while (workTurns < MAX_TURNS /* =10 */) {
    const inbox = yield* perform({ type: 'CheckInbox', input: { agentId } });
    if (inbox.length) {
      messages.push({ role: 'user', content: `<inbox>${JSON.stringify(inbox)}</inbox>` });
    }
    const response = yield* perform({ type: 'Chat', input: { messages, agentId } });
    if (response.stop_reason !== 'tool_use') break;
    // 派发工具：bash（只回显命令文本的教学实现）/ read_file / write_file / send_message
  }
  yield* perform({ type: 'SendMessage', input: { from: agentId, to: 'main', body: summary, kind: 'result' } });
  return summary;
}
```

要点：

- 队友有**自己的 `messages`、自己的 generator**，由 `runAgent` 驱动，与主 Agent 走同一套 Effect/Handler 体系。
- 任务在 spawn 时通过 `prompt` 下发，队友立即开始；不会再出现「先空闲等任务、等不到就退出」的窗口。
- 队友工具集：`bash` / `read_file` / `write_file` / `send_message`。没有 `check_inbox` 工具，因为子循环自己会在每轮开头读信箱。
- 教学版上限 `MAX_TURNS = 10` 个「工作轮」；一轮任务完成后发 `result` 并退出。需要后续工作就重新 spawn，重新 spawn 同名队友会清空它的旧信箱；真实 CC 使用常驻 idle loop，见文末对照表。
- 队友异常时，`startTeammate` 的 catch 会向 lead 写一条 `[teammate error]` result，避免 lead 只看到空信箱；该队友会被记入失败集合，脚本最终退出码为 1。

### 3. lead 怎么收队友结果

`check_inbox` 工具只给 lead，并且是**非阻塞**的：读到什么返回什么，读不到返回「信箱为空」。宿主注入是结果进入 lead 上下文的主要路径，但它是**尽力而为**的：等待超时后晚到的结果不会再被读取。

```typescript
// lead 的 agent loop，在 stop_reason !== 'tool_use' 时
const timedOut = yield* perform({ type: 'WaitForTeammates', input: { timeoutMs: JOIN_TIMEOUT_MS } });
const inbox = yield* perform({ type: 'CheckInbox', input: { agentId: 'main' } });
if (inbox.length) {
  messages.push({ role: 'user', content: `[Inbox]\n${formatInbox(inbox)}` });
  continue;   // 让模型看到结果后再汇总
}
return extractText(response);
```

- `WaitForTeammates` 有超时：mock 5 秒、real 90 秒，可用 `S15_JOIN_TIMEOUT_MS` 覆盖。最多继续 `MAX_END_TURN_DRAINS = 3` 轮，避免无限循环。
- `check_inbox` 只给 lead：队友子循环自己读自己的信箱，lead 的循环没有这个预处理。真实 CC 两类 Agent 都没有 `check_inbox` 工具，而是由运行时 poller 自动注入；本章保留工具是为了让「收信箱」这个动作在代码里可见。

### 4. 消息流（mock 全流程）

```
main: spawn_teammate(analyzer, prompt) / spawn_teammate(reviewer, prompt)
      │
      │ 队友子循环启动 → 第一条消息就是任务 → 立即开工
      ↓
analyzer 子循环: Chat(轮1: read_file 样例) → Chat(轮2: 结果文本) → SendMessage(to=main, type=result)
reviewer 子循环: 同上
      ↓
main: Chat 返回 end_turn
      → WaitForTeammates 等两个队友结束
      → CheckInbox(main) 读到 2 条 result
      → 注入 [Inbox] → 下一轮 Chat 汇总
```

### 5. 样例文件（启动时生成）

本章启动时会把两个小样例写到 `<WORKSPACE_ROOT>/s15_agent_teams/.output/`：

- `analyzer_sample.ts`：几个订单统计函数，嵌套条件较多，适合演示复杂度分析。
- `reviewer_sample.ts`：几个小函数，故意留了边界和校验问题，适合演示代码审查。

队友读的是这两个样例，而不是 `runtime/` 或本章 `agent.ts`。样例内容由章节固定、每次运行重新生成，因此临时工作区里也能读到，不会把核心源码带进模型上下文。

---

## 相对 s14 的变更

| 组件 | 之前 (s14) | 之后 (s15) |
|------|-----------|-----------|
| 协作模式 | 单 Agent 管理定时任务 | 多 Agent 消息总线 |
| 通信方式 | 无 Agent 间通信 | `.mailboxes/s15/*.jsonl` 信箱（异步解耦）|
| Agent 数量 | 1 个（主 Agent）| 1 主 + N 子 Agent |
| 子 Agent | 无 | 真实子循环（独立 generator + runAgent）|
| 任务下发 | 无 | `spawn_teammate.prompt`，队友立即开工 |
| 新共享状态 | 无 | `activeTeammates` Map + 按章节隔离的信箱目录 |
| 新 Effect | — | `SpawnTeammate`、`SendMessage`、`CheckInbox`，以及内部 `WaitForTeammates` |

---

## 运行

```bash
# 离线跑本章（本机 .env 可能设了 AGENT_MODE=real，所以显式 --mock）
npm run s15 -- --mock

# 用独立工作区跑并观察信箱布局
ws=$(mktemp -d)
AGENT_WORKSPACE="$ws" AGENT_MODE=mock npx tsx s15_agent_teams/agent.ts
ls -la "$ws/.mailboxes/s15"            # main.jsonl / analyzer.jsonl / reviewer.jsonl（读后为空文件）
ls -la "$ws/s15_agent_teams/.output"   # analyzer_sample.ts / reviewer_sample.ts（启动时生成）

# real 模式：样例文件启动时生成到工作区，直接跑即可
npm run s15 -- --real
```

说明：本章的 bash 是模拟执行，只回显命令文本；real 模式下真正读文件的是 `read_file`，读取对象是启动时生成的样例文件，不依赖仓库里的核心源码。real 模式单轮输出默认 4096 tokens，可用 `S15_MAX_TOKENS` 调整；队友完成一个任务后会退出，需要追问就重新 spawn 一个新队友。

脚本在 lead 结束后、进程退出前，还会最多等 `S15_CLEANUP_WAIT_MS`（mock 1 秒 / real 3 秒），让仍在运行的队友有机会把结果写完。这不是 CC 的关机超时，也不会强制停止队友；如果队友正在一次模型请求里，进程可能还要等它完成。真实 CC 的关闭由 lead 发 `shutdown_request`、队友回 `shutdown_response`，队友会先完成当前请求或工具调用，所以关闭可能很慢；卡住的队友由用户用 `TaskStop` 或结束会话处理。本章不实现关闭协议，关闭流程在 s16。

---

## 本章小结

**Agent 团队 = 多个真实 Agent 子循环通过文件信箱异步通信。`SpawnTeammate` 在启动时把任务写进 prompt，队友立即开工；`SendMessage` 追加 JSONL 立即返回；`CheckInbox` 非阻塞读取并清空。lead 在 `end_turn` 后等待活跃队友，把结果作为 `[Inbox]` 注入下一轮，完成一次完整的派发→执行→回报往返。这是分布式 Agent 协调的核心模式。**

---

<details>
<summary>深入 CC 源码</summary>

> 以下基于 CC 源码与公开分析整理；消息类型和字段名可能随版本变化。

### 一、结构化消息类型

CC 的团队通信有约 15 种结构化消息，常见的有：

| 消息类型 | 用途 |
|---------|------|
| `plain text` | 普通队友间通信 |
| `task_assignment` | 主 Agent 分配任务 |
| `idle_notification` | 队友完成一轮工作，进入空闲 |
| `permission_request` / `permission_response` | 队友请求操作审批，Lead 回审批结果 |
| `plan_approval_request` / `plan_approval_response` | 队友提交计划，Lead 审批 |
| `shutdown_request` / `shutdown_response` | 请求关闭 / 确认关闭 |
| `teammate_terminated` | 队友被移除通知 |

教学版消息结构保留 `type` 字段，但只用到 `message` / `result` 两种。

### 二、权限逐级上报

CC 中子 Agent 使用工具时遇到需要审批的操作，会向 Lead 发送 `permission_request`；用户审批后 Lead 回 `permission_response`，队友继续或拒绝执行。这是权限边界的实现方式：

```
子 Agent → permission_request → Lead → 审核 → permission_response → 子 Agent
```

教学版无此机制，子 Agent 的 Handler 直接访问文件系统。

### 三、team config 与角色约束

CC 有团队配置和角色工具权限约束（具体字段随版本变化）。角色不在允许列表中的工具调用会被拦截。教学版无此约束。

### 四、信箱持久化与已读状态

CC 的信箱是团队目录下的文件，消息带已读状态，读取后不会直接删除；具体字段随版本变化。教学版用 JSONL，`readInbox()` 读完清空，省略了已读标记、去重和超时处理。

### 教学版的简化

| 简化项 | 教学版 | CC |
|--------|--------|-----|
| 消息类型 | `message` / `result` 两种 | 约 15 种结构化类型 |
| 权限逐级上报 | 无 | `permission_request` → 审核 → `permission_response` |
| 角色约束 | 无 | 团队配置中的工具白名单 |
| 消息已读/去重 | 读完清空，无去重 | 消息带已读状态，具体字段随版本 |
| 消息投递 | lead 非阻塞 `check_inbox` + 宿主每轮注入 | 无 `check_inbox` 工具；运行时 poller 约每秒读信箱并注入下一轮，忙时排队 |
| 子 Agent 存活 | spawn 带任务，最多 10 轮后退出 | 空闲循环常驻，等待 `shutdown_request` |
| 并发模型 | 同进程 async 子循环 | 独立进程/线程或 in-process 会话 |

</details>
