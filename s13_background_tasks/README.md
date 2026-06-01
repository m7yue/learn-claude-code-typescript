# s13: Background Tasks — 后台任务是异步效应的并发容器

[s12](../s12_task_system/) → [s13] → [s14](../s14_cron_scheduler/)

---

## 第一性原理

**问题的本质**：有些工作需要很长时间（构建、lint、测试），但主 Agent 不应因此阻塞。让 LLM 傻等 = 资源浪费 + 上下文窗口浪费。

核心需求：**主 Agent 继续执行前台工作，后台任务异步运行，完成时自动通知——不依赖 LLM 主动查询。**

---

## 问题

```typescript
// 没有后台任务时，必须等待每个操作完成
const buildResult = yield* perform({ type: 'BashExec', input: { command: 'npm run build' } });
// 等了30秒...主 Agent 完全阻塞
const lintResult = yield* perform({ type: 'BashExec', input: { command: 'eslint src/' } });
// 又等了15秒...
```

---

## 代数效应视角

三个 Effect 构建完整的后台任务生命周期：

```typescript
// 1. 声明"启动后台任务"（立即返回，不阻塞）
const { taskId } = yield* perform({
  type: 'SpawnBackground',
  input: { taskId: 'bg_scan', description: '扫描代码库', durationMs: 5000 }
});

// 2. 主 Agent 继续执行前台工作（两者并行）
const result = yield* perform({ type: 'BashExec', input: { command: 'echo "前台继续"' } });

// 3. 等待特定任务完成（需要结果时才阻塞）
const { result: scanResult } = yield* perform({ type: 'WaitBackground', input: { taskId: 'bg_scan' } });
```

**关键洞见**：通知注入不依赖 LLM 主动调用工具。Agent Loop 在每轮 `Chat` 前自动检查 `notificationQueue`，有通知则前置注入 `<task_notification>` 消息——LLM 在每轮开始时就已知道后台任务状态。

| Python threading | 代数效应 TypeScript |
|-----------------|-------------------|
| `threading.Thread(target=task).start()` | `SpawnBackground` Effect |
| `notification_queue.put(result)` | Handler 内 `setTimeout` 写入 `notificationQueue` |
| Loop 前自动 `queue.get(block=False)` | Generator 主循环的自动注入逻辑 |
| `thread.join()` | `WaitBackground` Effect |
| `is_slow_operation(cmd)` 启发式 | `isSlowOperation(command)` 关键词检测 |

---

## 工作原理

### 通知自动注入：Loop 前置，不依赖工具调用

```typescript
// 对应 CC 源码 Agent Loop 的 pendingToolUseSummary 注入逻辑
while (true) {
  // 每轮 Chat 前自动检查
  if (notificationQueue.length > 0) {
    const pending = [...notificationQueue];
    notificationQueue.length = 0;
    const notifText = pending.map(n =>
      `<task_notification>\n任务 ${n.taskId} ${n.event}: ${n.result}\n</task_notification>`
    ).join('\n');
    messages.push({ role: 'user', content: notifText });
  }
  const response = yield* perform({ type: 'Chat', input: { messages } });
  // ...
}
```

LLM 在每轮开始前就能看到后台任务的完成状态，无需等待下一轮工具调用。

### isSlowOperation：启发式后台化

```typescript
// 对应 CC 源码的慢操作检测：识别需要自动后台化的命令
function isSlowOperation(command: string): boolean {
  const slowKeywords = ['install', 'build', 'test', 'compile', 'lint', 'typecheck', 'tsc', 'webpack', 'vite'];
  return slowKeywords.some(kw => command.toLowerCase().includes(kw));
}

// BashExec Handler：命中关键词则自动后台化，立即返回任务句柄
if (isSlowOperation(command)) {
  const taskId = `bg_auto_${Date.now()}`;
  const promise = new Promise(resolve => setTimeout(() => {
    notificationQueue.push({ taskId, event: 'completed', result: `${command} 完成` });
    resolve(result);
  }, durationMs));
  backgroundTasks.set(taskId, promise);
  return `已后台化 (${taskId})，主 Agent 可继续工作`;
}
```

### 时间线

```
轮1: SpawnBackground(bg_scan, 80ms)  ─┐ 立即返回
     BashExec("npm run build")        ─┤ → isSlowOperation → 自动后台化
                                       │ （bg_scan 和 build 在后台并行运行）
轮2: BashExec(前台工作)                │
                                       │ [80ms后: bg_scan 完成，写入 notificationQueue]
                                       │ [60ms后: build 完成，写入 notificationQueue]
轮3前: AutoInject 检查到 2 条通知 ←───┘
       前置注入 <task_notification> 消息
轮3: WaitBackground(bg_scan) → 已完成，立即返回
轮4: end_turn
```

---

## 相对 s12 的变更

| 组件 | 之前 (s12) | 之后 (s13) |
|------|-----------|-----------|
| 任务执行 | 同步等待（CreateTask/ClaimTask/CompleteTask） | 后台异步（SpawnBackground）|
| 完成通知 | 需主动查询任务状态 | 自动注入 `<task_notification>` |
| BashExec | 始终同步阻塞 | `isSlowOperation` 自动后台化 |
| 新共享状态 | — | `notificationQueue` + `backgroundTasks` |
| 新工具函数 | — | `isSlowOperation` 启发式检测 |
| 新 Effect | — | `SpawnBackground`、`CollectNotifications`、`WaitBackground` |

---

## 运行

```bash
npm run s13
```

---

## 本章小结

**后台任务 = SpawnBackground 在 Handler 层启动 Promise 但不阻塞返回；通知自动注入 = Agent Loop 在每轮 Chat 前检查 notificationQueue，前置 `<task_notification>` 消息；isSlowOperation 启发式让普通 BashExec 无缝自动后台化。三者合力让 LLM 在每轮开始时就知道后台状态，无需等待。**

---

<details>
<summary>深入 CC 源码</summary>

> 以下基于 CC 源码 `background/tasks.ts`、`loop.ts` 的分析。

### 一、7 种后台任务类型

CC 的后台任务比教学版丰富得多：

| 类型 | 描述 |
|------|------|
| `bash` | 后台 shell 命令 |
| `agent` | 子 Agent 进程 |
| `remote_agent` | 远程 Agent（跨机器） |
| `local_agent` | 本机 Agent（独立进程） |
| `cron` | 定时触发（对接 s14） |
| `sleep` | 睡眠定时器（SleepTool） |
| `mcp_notification` | MCP 服务器推送的通知（对接 s19） |

教学版只实现了 `bash`/`spawn` 类型。

### 二、pendingToolUseSummary：通知的格式化注入

CC 的通知注入比教学版更精细：

```typescript
// CC 伪代码
if (pendingNotifications.length > 0) {
    const summary = formatNotifications(pendingNotifications);
    // 注入到 messages 的 "user" 轮中，与正常工具结果分开
    const pendingToolUseSummary = `<function_results>\n${summary}\n</function_results>`;
}
```

通知被包裹在 `<function_results>` 而非简单的 `<task_notification>`，与标准工具调用结果格式一致，LLM 解析更稳定。教学版用简单文本注入，功能等价但格式有差异。

### 三、看门狗（watchdog）机制

CC 对长时间运行的后台 bash 任务有看门狗：
- 每 30 秒检查任务是否还在运行
- 任务输出超过 10KB 则截断并发通知
- 进程意外退出（非零 exit code）自动发送 `failed` 通知

教学版用 `setTimeout` 简化，不处理截断和看门狗。

### 四、并发控制

CC 同时运行的后台任务有上限（默认 10 个），超出则排队等待。任务之间可以声明依赖关系（`depends_on: ['bg_build']`），自动按依赖顺序执行。教学版无并发控制和依赖图。

### 教学版的简化

| 简化项 | 教学版 | CC |
|--------|--------|-----|
| 任务类型 | 1 种（通用 spawn） | 7 种 |
| 通知格式 | `<task_notification>` 文本 | `<function_results>` 标准格式 |
| 看门狗 | 无 | 30s 心跳，输出截断 |
| 并发控制 | 无 | 上限 + 依赖图 |
| 自动后台化 | `isSlowOperation` 关键词 | 更完整的启发式 + 超时检测 |

</details>
