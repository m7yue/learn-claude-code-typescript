# s13: Background Tasks — 后台任务是不阻塞主循环的协作式异步执行

[s12](../s12_task_system/) → [s13] → [s14](../s14_cron_scheduler/)

---

## 第一性原理

**问题的本质**：有些工作需要很长时间（构建、安装、测试），但主 Agent 不应因此阻塞。让 LLM 傻等 = 资源浪费 + 上下文窗口浪费。

核心需求：**主 Agent 继续执行前台工作，后台任务不阻塞主循环地推进，完成后自动通知——不依赖 LLM 主动查询。**

这里的「后台」不是 daemon thread。JS 只有一个线程，代码轮流执行；后台工作是一个不被 `await` 的 async 函数，
只在主循环等待 Chat 或 I/O 时推进。CPU 密集的前台代码会阻塞它，进程退出后也不会存活。

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

Python 用模块级的计数器和两张表实现后台执行：

```python
_bg_counter = 0
background_tasks: dict[str, dict] = {}   # bg_id → {tool_use_id, command, status}
background_results: dict[str, str] = {}   # bg_id → output
```

TypeScript 把它们封进 `BackgroundRegistry`：

```typescript
class BackgroundRegistry {
  private counter = 0;                                 // 对应 _bg_counter
  private readonly backgroundTasks = new Map<string, BackgroundTaskRecord>();
  private readonly backgroundResults = new Map<string, string>();
  private readonly pending = new Set<Promise<void>>();  // 结束回合时 waitForAll 用

  async startBackgroundTask(block: ToolUseBlock): Promise<string> {
    this.counter += 1;
    const bgId = `bg_${String(this.counter).padStart(4, '0')}`;   // bg_0001, bg_0002 ...
    const task: BackgroundTaskRecord = {
      toolUseId: block.id, command, status: 'running', startedAt: Date.now(),
    };
    this.backgroundTasks.set(bgId, task);

    // 不等它：主循环拿到 bgId 后立刻继续，后台这段代码稍后自己把结果写回。
    const job = (async () => {
      try {
        const output = await executeTool(block);
        this.backgroundResults.set(bgId, output);
        task.outputFile = writeBackgroundOutput(bgId, output);  // 写入 .task_outputs/bg_xxxx.log
        task.status = 'completed';
      } catch (err) {
        const output = `Error: ${err instanceof Error ? err.message : String(err)}`;
        this.backgroundResults.set(bgId, output);
        task.outputFile = writeBackgroundOutput(bgId, output);
        task.status = 'failed';
      } finally {
        task.finishedAt = Date.now();
      }
    })();
    this.pending.add(job);
    return bgId;   // 立即返回
  }

  /** 结束回合时等待在途任务；超时则放弃剩余任务，避免无限等待。 */
  async waitForAll(timeoutMs = 5_000): Promise<void> { /* Promise.race(allSettled, timeout) */ }
}
```

`(async () => { ... })()` 不被 `await` 接管：调用方拿到 `bg_0001` 后主循环马上继续，
后台那段代码只在事件循环让出执行权时推进。

### 收集：`<task-notification>` 通知

`collectBackgroundResults()` 取出所有非 `running` 的任务（`completed` / `failed`，取出后从注册表里删掉），
生成与真实 Claude Code 对齐的 XML 通知（`summary` 取输出的前 200 字符；
完整输出在 `output-file` 指向的文件里，模型可以用 `read_file` 读取）：

```xml
<task-notification>
  <task-id>bg_0001</task-id>
  <task-type>local_bash</task-type>
  <status>completed</status>
  <summary>(执行: npm install)</summary>
  <output-file>/path/to/workspace/.task_outputs/bg_0001.log</output-file>
</task-notification>
```

失败任务同样有通知：`<status>failed</status>`，`<summary>` 是错误信息。
任务耗时只打印在日志里（`[background done] ... (+25ms, ...)`），教学版的后台 bash 通知不包含 `duration_ms` 字段。

### 判定：模型明确要求优先，否则按关键字猜测

```typescript
function shouldRunBackground(toolName, toolInput): boolean {
  if (toolName !== 'bash') return false;                   // 只有 bash 支持后台执行
  if (toolInput['run_in_background'] === true) return true; // 模型明确要求（优先）
  return isSlowOperation(toolName, toolInput);              // 否则看它是不是慢命令
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

// 3. 收集：工具轮非阻塞收集；结束回合时 wait=true 先等完在途任务
const notifs = yield* perform({ type: 'CollectBackgroundResults', input: { wait: false } });
```

| Python threading | 代数效应 TypeScript |
|-----------------|-------------------|
| `client.messages.create(...)` | `Chat` Effect（mock 只替换这里） |
| `execute_tool(block)`（前台） | `ExecuteTool` Effect |
| `start_background_task(block)` | `StartBackground` Effect |
| `threading.Thread(daemon=True).start()` | Handler 内不 `await` 的 async 函数（同一线程，协作式） |
| `collect_background_results()` | `CollectBackgroundResults` Effect（`wait` 决定是否等待） |
| 退出前 join 线程 | 结束回合时 `waitForAll`（有超时上限） |
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

### 工具轮：通知合并进同一条 user 消息

工具执行完后，把通知和 tool_result 合并进**同一条** user 消息：

```typescript
const userContent: Array<TextBlock | ToolResultBlock> = [...toolResults];
const notifications = yield* perform({
  type: 'CollectBackgroundResults',
  input: { wait: false },
});
for (const notif of notifications) userContent.push({ type: 'text', text: notif });
messages.push({ role: 'user', content: userContent });
```

LLM 下一轮开始时就能在同一批用户消息里看到 `<task-notification>`，无需主动调用工具查询。

### 结束回合：先排空后台，再让模型收尾

`stop_reason !== 'tool_use'` 时不能直接 return：模型可能刚启动后台任务就结束回合，此时通知还没被收集。
先把在途任务等完（`waitForAll`，带 5 秒超时），再把通知作为一条 user 消息注入，让模型多走一轮：

```typescript
const MAX_END_TURN_DRAINS = 3;

if (response.stop_reason !== 'tool_use') {
  const finalText = extractText(response);
  if (endTurnDrains >= MAX_END_TURN_DRAINS) return finalText;

  const notifications = yield* perform({
    type: 'CollectBackgroundResults',
    input: { wait: true },          // 只在这里等待；普通工具轮仍是非阻塞收集
  });
  if (notifications.length === 0) return finalText;

  endTurnDrains += 1;
  messages.push({
    role: 'user',
    content: notifications.map((text) => ({ type: 'text', text })),
  });
  continue;                         // 再给模型一轮，让它看到通知后收尾
}
```

`MAX_END_TURN_DRAINS` 是安全阀，防止排空分支追加无上限的回合；正常情况只会多用一轮。

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
     → collectBackgroundResults 取出 bg_0001，生成 <task-notification>（含 output-file）
     → 与本轮前台 bash 的 tool_result 合并进同一条 user 消息（[inject] 1 条）
轮3: mock 在对话里读到该通知并回显 → end_turn
     → 结束回合时已无在途任务，waitForAll 立即返回，不追加轮次
```

---

## 相对 s12 的变更

| 组件 | 之前 (s12) | 之后 (s13) |
|------|-----------|-----------|
| 任务执行 | 同步等待 | `bash run_in_background` / 按关键字判断慢命令 → 后台 |
| 后台机制 | — | `BackgroundRegistry`（tasks/results 两张表 + pending） |
| 任务命名 | — | `bg_0001`（`bg_%04d`，自增计数） |
| 完成通知 | 主动查询任务状态 | `collectBackgroundResults` 自动注入 `<task-notification>`（含 output-file） |
| 任务结果 | — | 内存 Map + `.task_outputs/bg_xxxx.log` |
| 后台失败 | — | `failed` 通知 + 错误 summary |
| 回合结束 | 直接返回 | 先 `waitForAll` 排空通知，注入 user 消息后再走一轮 |
| 新 Effect | — | `StartBackground`、`CollectBackgroundResults`（`wait` 输入区分是否等待） |
| 新工具 | — | 无新增工具（后台由 `bash` 参数触发） |

---

## 运行

```bash
# 强制离线 mock（本地 .env 设了 AGENT_MODE=real 时用 --mock）
npm run s13 -- --mock

# 真实模型（需要 .env 里的 token 与 MODEL_ID）
npm run s13 -- --real
```

mock 的 stdout 结尾：

```
[Chat] → 轮次 3

[S13] 完成: 前台工作结束，已收到后台任务完成通知：
<task-notification>
  <task-id>bg_0001</task-id>
  <task-type>local_bash</task-type>
  <status>completed</status>
  <summary>(执行: npm install)</summary>
  <output-file>.../.task_outputs/bg_0001.log</output-file>
</task-notification>
```

真实模式的逐字输出取决于模型：若模型按提示调用 `bash(run_in_background: true)`（或直接执行
`npm install` 命中慢命令关键字），日志会先出现 `[background] dispatched bg_0001`，
结束回合时出现 `[inject] 注入 1 条后台通知（回合结束排空）`，随后模型再回答一轮。
若模型完全不触发后台，脚本仍会正常结束，只是没有后台通知。

### 已知限制

- **协作式并发**：后台任务是同一线程里的 async 函数，不是 daemon thread；同步 CPU 密集代码会阻塞它。
- **退出丢失**：进程在任务完成前退出（Ctrl-C、崩溃）时，内存注册表里的记录和通知会丢失；已经写出的 output-file 仍在磁盘上，但不会再自动注入。教学版不做持久化。
- **排空有上限**：结束回合最多排空 `MAX_END_TURN_DRAINS` 轮，每次最多等 5 秒；超时或超限后，未送达的通知会被放弃。
- **real 模式不确定**：模型可能不调用 `run_in_background`，也可能不命中慢命令关键字；这不影响脚本运行，但后台机制不会被演示。
- **没有停止/看门狗/并发上限**：教学版不支持停止后台任务，也没有看门狗、并发上限和依赖图。

---

## 本章小结

**后台任务 = `startBackgroundTask` 用一个「启动后不等它」的 async 函数，让工作在主循环之外推进；
注册表用 `background_tasks` / `background_results` 两张表记录任务与结果；`bg_%04d` 是任务身份；
`collectBackgroundResults` 把已完成/失败任务整理成 `<task-notification>`；工具轮非阻塞收集，
结束回合时 `waitForAll` 排空并注入 user 消息，让模型无需主动查询即可获知后台状态。**

---

<details>
<summary>深入 CC 源码</summary>

> 以下以当前 Claude Code 的公开文档与可观察行为为准；具体字段拼写可能随版本变化。

真实 Claude Code 的后台 bash 任务完成时，会注入一条对模型可见、对 UI 消息流隐藏的 meta user 消息，
正文是包装文本加 `<task-notification>` XML。通知字段是：

```xml
<task-notification>
  <task-id>b97d2yl9o</task-id>
  <task-type>local_bash</task-type>
  <status>completed</status>
  <summary>...</summary>
  <output-file>/path/to/output</output-file>
</task-notification>
```

- `task-id` 是不透明字符串（例如 `b97d2yl9o`），不是教学版的自增 `bg_0001`。
- `task-type` 对后台 bash 是 `local_bash`；还有其他类型，如 `local_agent`、`remote_agent`。
- `status` 常见 `completed` / `failed`；当前 SDK 文档还列出 `stopped`（手动终止的任务通常不发完成通知）。
- 后台 bash 的完整输出写在 `output-file` 里。`BashOutput` 工具在 v2.1.277 已移除，
  模型改为用 `Read` 读输出文件。
- 通知不是 `<function_results>` 包裹，也不是 tool_result；它是一条独立的 meta user 消息。

教学版与真实 CC 的差异：

| 维度 | 教学版 | 真实 CC |
|------|--------|---------|
| 触发 | `bash` 的 `run_in_background` / 慢命令关键字 | 后台 bash、后台 Agent、Monitor、Cron 等 |
| 执行 | 模拟 `setTimeout`，同一线程协作式推进 | 由 harness 跟踪的子进程 / 任务 |
| 任务 id | `bg_0001`（自增） | 不透明 id（如 `b97d2yl9o`） |
| 通知 | `<task-notification>` + `task-id` / `task-type` / `status` / `summary` / `output-file` | 同左 |
| 结果 | 写入工作区 `.task_outputs/bg_xxxx.log` | `output-file` |
| 失败 | `failed` + 错误 summary | `failed`（当前 SDK 文档还有 `stopped`） |
| 其他 | 无看门狗、并发上限、依赖图、停止工具 | 更完整的任务管理（本章不展开） |

</details>
