# s13: Background Tasks — 后台任务是脱离主循环的异步执行

[s12](../s12_task_system/) → [s13] → [s14](../s14_cron_scheduler/)

---

## 第一性原理

**问题的本质**：有些工作需要很长时间（构建、安装、测试），但主 Agent 不应因此阻塞。让 LLM 傻等 = 资源浪费 + 上下文窗口浪费。

核心需求：**主 Agent 继续执行前台工作，后台任务真正脱离主循环异步运行，完成后自动通知——不依赖 LLM 主动查询。**

这里的关键词是"真正脱离"：不是用一个 `await` 把耗时工作包起来假装异步，而是像 Python 的
`threading.Thread(daemon=True)` 那样，把工作**交出去后立刻返回**，结果稍后再由注册表收集回来。

---

## 问题

```typescript
// 没有后台任务时，必须等待每个操作完成
const buildResult = yield* perform({ type: 'ExecuteTool', input: { block: buildBlock } });
// 等了30秒...主 Agent 完全阻塞
const lintResult = yield* perform({ type: 'ExecuteTool', input: { block: lintBlock } });
// 又等了15秒...
```

---

## 真实机制：BackgroundRegistry

Python 用模块级的三样东西实现后台执行：

```python
_bg_counter = 0
background_tasks: dict[str, dict] = {}   # bg_id → {tool_use_id, command, status}
background_results: dict[str, str] = {}   # bg_id → output
background_lock = threading.Lock()
```

TypeScript 用 `runtime/locks.ts` 的 `Mutex` 把它们封进 `BackgroundRegistry`：

```typescript
class BackgroundRegistry {
  private readonly lock = new Mutex();                 // 对应 background_lock
  private counter = 0;                                 // 对应 _bg_counter
  private readonly backgroundTasks = new Map<string, BackgroundTaskRecord>();
  private readonly backgroundResults = new Map<string, string>();

  async startBackgroundTask(block: ToolUseBlock): Promise<string> {
    this.counter += 1;
    const bgId = `bg_${String(this.counter).padStart(4, '0')}`;   // bg_0001, bg_0002 ...
    await this.lock.withLock(() => {
      this.backgroundTasks.set(bgId, { toolUseId: block.id, command, status: 'running' });
    });

    // 不等它：主循环拿到 bgId 后立刻继续，后台这段代码稍后自己把结果写回。
    (async () => {
      const result = await executeTool(block);
      await this.lock.withLock(() => {
        this.backgroundTasks.get(bgId)!.status = 'completed';
        this.backgroundResults.set(bgId, result);
      });
    })().catch(...);

    return bgId;   // 立即返回
  }
}
```

`(async () => { ... })()` 不被 `await` 接管，对应 `Thread(daemon=True).start()`：调用方拿到
`bg_0001` 后主循环马上继续，后台那段代码稍后才把结果写回注册表（加锁保证同一时刻只有一个操作在改表）。

### 收集：`<task_notification>` 通知

`collectBackgroundResults()` 取出所有 `status === 'completed'` 的任务（取出后从注册表里删掉），
生成 XML 格式的通知（`summary` 取输出的前 200 字符，`duration_ms` 为后台任务实际耗时）：

```typescript
<task_notification>
  <task_id>bg_0001</task_id>
  <status>completed</status>
  <command>npm install</command>
  <duration_ms>27</duration_ms>
  <summary>(执行: npm install)</summary>
</task_notification>
```

### 判定：模型明确要求优先，否则按关键字猜测

```typescript
function shouldRunBackground(toolName, toolInput): boolean {
  if (toolInput['run_in_background']) return true;      // 模型明确要求（优先）
  return isSlowOperation(toolName, toolInput);          // 否则看它是不是慢命令
}
// isSlowOperation 命中关键词：install / build / test / deploy / compile /
// docker build / pip install / npm install / cargo build / pytest / make
```

---

## 代数效应视角

后台机制依然是 Effect + handler + generator：

```typescript
// 1. 前台：主循环等待工具结果
const out = yield* perform({ type: 'ExecuteTool', input: { block } });

// 2. 后台：交给注册表，立刻拿到 bg id（不等它）
const { bgId } = yield* perform({ type: 'StartBackground', input: { block } });

// 3. 收集：每轮工具执行完后，取回已经完成的通知（不等未完成的）
const notifs = yield* perform({ type: 'CollectBackgroundResults', input: {} });
```

| Python threading | 代数效应 TypeScript |
|-----------------|-------------------|
| `client.messages.create(...)` | `Chat` Effect（mock 只替换这里） |
| `execute_tool(block)`（前台） | `ExecuteTool` Effect |
| `start_background_task(block)` | `StartBackground` Effect |
| `threading.Thread(daemon=True).start()` | Handler 内不 `await` 的 async 函数 |
| `background_lock` | `new Mutex()` |
| `collect_background_results()` | `CollectBackgroundResults` Effect |
| `bg_%04d` 命名 | `bg_${String(n).padStart(4, '0')}` |
| `should_run_background()` | `shouldRunBackground()` |

---

## 工作原理

### Agent Loop：bash 命中后台条件 → 占位结果

```typescript
for (const block of getToolUseBlocks(response)) {
  if (shouldRunBackground(block.name, block.input)) {
    const { bgId } = yield* perform({ type: 'StartBackground', input: { block } });
    toolResults.push({
      type: 'tool_result', tool_use_id: block.id,
      content: `[Background task ${bgId} started] Command: ${block.input.command}. ` +
               `Result will be available when complete.`,
    });
  } else {
    const output = yield* perform({ type: 'ExecuteTool', input: { block } });
    toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: output });
  }
}
```

注意：本章**没有** `spawn_background` / `wait_background` / `collect_notifications`
这三个工具——后台执行完全由 `bash` 的 `run_in_background` 参数（或按关键字判断是不是慢命令）触发。

### 通知合并进同一条 user 消息

工具执行完后，把通知和 tool_result 合并进**同一条** user 消息：

```typescript
const userContent: Array<TextBlock | ToolResultBlock> = [...toolResults];
const notifications = yield* perform({ type: 'CollectBackgroundResults', input: {} });
for (const notif of notifications) userContent.push({ type: 'text', text: notif });
messages.push({ role: 'user', content: userContent });
```

LLM 下一轮开始时就能在同一批用户消息里看到 `<task_notification>`，无需主动调用工具查询。

### 本章工具集

本章工具集：`bash`、`read_file`、`write_file`、`create_task`、`list_tasks`、
`get_task`、`claim_task`、`complete_task`。后台能力是 `bash` 上的 `run_in_background` 布尔参数。

### 时间线（mock 演示）

```
轮1: bash(run_in_background: true) —— "npm install"
     → shouldRunBackground 命中 → [background] dispatched bg_0001（交给后台，不等它）
     → tool_result 是占位串 "[Background task bg_0001 started] ..."
     （此刻 collect 取不到结果：慢命令要跑约 25ms，后台任务还没完成）
轮2: 主循环继续前台 bash("echo ...")；其间 Chat 在等待，后台任务趁机往下跑并完成
     → collectBackgroundResults 取出 bg_0001，生成 <task_notification>（含 duration_ms）
     → 与本轮前台 bash 的 tool_result 合并进同一条 user 消息（[inject] 1 条）
轮3: mock 在对话里读到该通知并回显 → end_turn
```

---

## 相对 s12 的变更

| 组件 | 之前 (s12) | 之后 (s13) |
|------|-----------|-----------|
| 任务执行 | 同步等待 | `bash run_in_background` / 按关键字判断慢命令 → 后台 |
| 后台机制 | — | `BackgroundRegistry`（Mutex + tasks/results 两张表） |
| 任务命名 | — | `bg_0001`（`bg_%04d`，自增计数） |
| 完成通知 | 主动查询任务状态 | `collectBackgroundResults` 自动注入 `<task_notification>` |
| 新 Effect | — | `ExecuteTool`、`StartBackground`、`CollectBackgroundResults` |
| 新工具 | — | 无新增工具（后台由 `bash` 参数触发） |

---

## 运行

```bash
npm run s13        # 默认 mock，离线运行
```

标准输出结尾：

```
[Chat] → 轮次 3

[S13] 完成: 前台工作结束，已收到后台任务完成通知：
<task_notification>
  <task_id>bg_0001</task_id>
  <status>completed</status>
  <command>npm install</command>
  <duration_ms>27</duration_ms>
  <summary>(执行: npm install)</summary>
</task_notification>
```

---

## 本章小结

**后台任务 = `startBackgroundTask` 用一个「启动后不等它」的 async 函数，让工作在对话之外独立进行，
注册表用 `Mutex` 保护 `background_tasks` / `background_results` 两张表；`bg_%04d` 是任务身份；
`collectBackgroundResults` 把已完成任务整理成 `<task_notification>`；主循环每轮把通知并进 user 消息，
让模型无需主动查询即可获知后台状态。**

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

教学版只实现了 `bash` 类型。

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

教学版不做看门狗，后台任务完成后一次性写回结果。

### 四、并发控制

CC 同时运行的后台任务有上限（默认 10 个），超出则排队等待。任务之间可以声明依赖关系（`depends_on: ['bg_build']`），自动按依赖顺序执行。教学版无并发控制和依赖图。

### 教学版的简化

| 简化项 | 教学版 | CC |
|--------|--------|-----|
| 任务类型 | 1 种（bash） | 7 种 |
| bash 实现 | 不真正 fork，用一段固定的等待模拟耗时（慢命令更久，约 25ms） | 真正子进程 + 管道 |
| 通知格式 | `<task_notification>` 文本 | `<function_results>` 标准格式 |
| 看门狗 | 无 | 30s 心跳，输出截断 |
| 并发控制 | 无 | 上限 + 依赖图 |
| 自动后台化 | `shouldRunBackground`：模型明确要求 + 按关键字猜测 | 更完整的判断规则 + 超时检测 |

</details>
