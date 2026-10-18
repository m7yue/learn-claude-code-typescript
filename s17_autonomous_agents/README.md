# s17: Autonomous Agents — 空闲循环是自主行为的效应基础

[s16](../s16_team_protocols/) → [s17] → [s18](../s18_worktree_isolation/)

---

## 第一性原理

**问题的本质**：之前所有章节的 Agent 都在响应用户指令。真正的自主 Agent 不需要用户推动——它主动扫描环境，发现可以做的工作就去做。

自主性 = 主动轮询 + 主动执行 + WORK/IDLE/SHUTDOWN 生命周期管理。

---

## 问题

```typescript
// 被动 Agent：等用户说话
const response = await readline("用户: ");
runTask(response);

// 自主 Agent 需要：
let state = WORK;
while (state !== SHUTDOWN) {
    const tasks = scanUnclaimedTasks();
    if (tasks.length > 0) {
        claimAndExecute(tasks[0]);
    } else {
        ({ state } = await idlePoll({ interval: 5000, timeout: 60000 }));
    }
}
```

---

## 代数效应视角

四个 Effect 构建自主行为循环，**没有任何用全局变量 `globalThis` 悄悄传状态的做法**——状态机的每一次迁移都由真实条件（任务板、信箱、超时）决定：

```typescript
// 1) 扫描可认领任务（status=pending + 无 owner + 依赖已满足）
const unclaimedTasks = yield* perform({ type: 'ScanUnclaimed', input: {} });

// 2) 主动认领：Handler 自己扫描并认领第一个能做的任务（检查 owner 和 can_start）
//    autoClaim 自己扫描任务板并认领，不需要用全局变量在扫描与认领之间传值
const { task, success } = yield* perform({
  type: 'AutoClaim',
  input: { owner: 'worker' }
});

// 3) 空闲等待：Handler 真 sleep、逐轮读信箱 + 扫任务板；
//    命中任务/来信返回 { state: 'work', trigger }，超时返回 { state: 'shutdown', trigger: 'timeout' }
const idle = yield* perform({
  type: 'IdlePoll',
  input: { agentId: 'worker', pollIntervalMs: 5000, reason: '等待新任务' }
});
// idle.state === 'shutdown' → 退出状态机
```

**关键洞见**：`IdlePoll` 把"等待"从 `setTimeout(fn, delay)` 提升为效应声明，Handler 决定实际等待策略并负责 IDLE→SHUTDOWN 判定。Generator 只说"我现在空闲"，拿到 `{ state, trigger }` 后做状态迁移。

| Python 自主循环 | 代数效应 TypeScript |
|---------------|-------------------|
| `scan_unclaimed_tasks()` | `ScanUnclaimed` Effect |
| `task.claim(owner)` + owner/依赖校验 | `AutoClaim` / `ClaimTask` Effect |
| `idle_poll()` 内循环 sleep + 扫描 + 认领 | `IdlePoll` Handler 真实轮询 |
| `WORK / IDLE / SHUTDOWN` 状态 | Generator 里的 `state` 变量（真状态机） |
| `threading.Thread(teammate.run)` | `SpawnTeammate` → `runAgent` 子循环 |
| `send_message` / `read_inbox` | `SendMessage` / `CheckInbox`（真 JSONL 信箱） |

---

## 工作原理

### WORK → IDLE → SHUTDOWN 生命周期（真状态机）

自主工作者的子循环由 `runAgent` 驱动，`state` 是一个真正的变量，每次迁移都由真实条件触发（不用 `globalThis` 全局变量悄悄传状态）：

```typescript
type WorkerState = 'WORK' | 'IDLE' | 'SHUTDOWN';
let state: WorkerState = 'WORK';

while (true) {
  if (state === 'WORK') {
    // 逐轮：读信箱 → Chat → 派发工具（最多 10 轮）
    for (let i = 0; i < MAX_WORK_ITERATIONS; i++) {
      const inbox = yield* perform({ type: 'CheckInbox', input: { agentId } });
      if (inbox.some(m => m.type === 'shutdown_request')) { state = 'SHUTDOWN'; break; }
      const response = yield* perform({ type: 'Chat', input: { messages, agentId } });
      if (response.stop_reason !== 'tool_use') break; // 模型不再请求工具 → 本轮工作结束
      // ...派发 scan_unclaimed / auto_claim / complete_task / bash / ...
    }
    if (state === 'SHUTDOWN') break;
    state = 'IDLE';               // WORK → IDLE
    continue;
  }

  // IDLE：真轮询。命中任务/来信 → 回 WORK；超时 → SHUTDOWN
  const idle = yield* perform({
    type: 'IdlePoll',
    input: { agentId, pollIntervalMs: IDLE_POLL_INTERVAL_MS, reason: '等待新任务' },
  });
  if (idle.state === 'shutdown') { state = 'SHUTDOWN'; break; }
  state = 'WORK';                 // IDLE → WORK
}
```

日志里可以看到完整迁移链：
`WORK → IDLE` →（空闲期自动认领）`IDLE → WORK (claimed)` →（任务做完）`WORK → IDLE` →（任务板清空）`IDLE → SHUTDOWN (timeout)`。

### idle_poll：真实轮询（默认 5s / 60s，mock 可配更快）

`IdlePoll` Handler 不是空转，它真的 `sleep` 并按轮执行三件事：

```
每 pollIntervalMs 一轮：
  1. 读自己的信箱 → 有 shutdown_request → 回 shutdown_response 并返回 shutdown
                    → 有普通消息 → 返回 work（回到 WORK 处理来信）
  2. 扫描任务板 → 有可认领任务 → 真认领（owner 写入 .tasks/*.json）→ 返回 work
  3. 都没命中 → 继续下一轮；累计超过 IDLE_TIMEOUT_MS → 返回 shutdown
```

时序常量（`IDLE_POLL_INTERVAL=5s`、`IDLE_TIMEOUT=60s`）：

| 模式 | 轮询间隔 | 超时 | 说明 |
|------|---------|------|------|
| real（默认） | 5000ms | 60000ms | 默认值 |
| mock（演示） | 20ms | 200ms | 让演示秒级完成，但走的是**同一条真实轮询/超时路径** |

两者都可用环境变量覆盖：`S17_IDLE_POLL_INTERVAL_MS`、`S17_IDLE_TIMEOUT_MS`。

### ScanUnclaimed：依赖感知 + 归属感知

```typescript
// pending + 无 owner + 所有 blockedBy 依赖均已完成
function scanUnclaimedTasks(): TaskRecord[] {
  return listTasks().filter(t =>
    t.status === 'pending' && !t.owner && canStart(t.id)
  );
}
```

一个任务声明 `blockedBy: ['task_..._0001']`，在 `0001` 完成前不会出现在扫描结果里；`0001` 完成后 `completeTask` 会报告"解锁"了哪些下游任务。

### AutoClaim / ClaimTask / CompleteTask：owner 检查

`AutoClaim` **自己**扫描并认领第一个合格任务（这正是移除 `globalThis._pendingTaskId` 的关键）；三个任务效应都做真实校验：

- **认领**：任务必须 `pending`；**已有 owner 则拒绝**；依赖未满足则拒绝。
- **完成**：任务必须 `in_progress`；**owner 必须匹配**——一个工作者只处理自己拥有的任务，否则拒绝。
- owner 持久化在 `.tasks/<id>.json` 的 `owner` 字段，跨进程可见。

在单进程演示里读写不会被中途打断；多进程竞争场景需要任务级文件锁（教学版简化为单进程）。

### 队友循环：信箱驱动的自主工作者

lead 通过 `spawn_teammate` 拉起一个**独立 generator**（`autonomousWorkerLoop`），它有自己的 `messages` 和状态机：

- 从 `scan_unclaimed` / `auto_claim` 认领任务板上的活（**不依赖用户指令**，纯自主）。
- 结束时把最终摘要作为 `result` 消息**写回 lead 的信箱**（`SendMessage` → `.mailboxes/main.jsonl`）。
- lead 的 `check_inbox` 会先 `await` 所有队友子循环再读信箱，保证"报告已送达"后能稳定结束。

信箱是真实 JSONL 文件（`.mailboxes/*.jsonl`）。

### 演示剧本（结果可重复）

预置三个任务：`更新文档索引`（无依赖）、`清理日志文件`（依赖前者）、`task_owned_by_lead`（owner=lead，用于演示归属拒绝）。mock 工作者依次执行：

```
WORK   扫描 → 强行认领 lead 的任务（被拒）→ 自动认领 A → 执行 → 完成 A（解锁 B）
IDLE   轮询 → 发现 B 可认领 → 自动认领 B
WORK   完成 B
IDLE   轮询 → 任务板已无可认领任务 → 超时
SHUTDOWN → 把摘要经信箱回报 lead
```

工作者会把任务板上所有可认领任务（不仅是预置的）都干完才进入超时关闭——这是"自主"的含义。mock **只替换模型调用**；状态机、轮询、认领、信箱全部是真实代码。

---

## 相对 s16 的变更

| 组件 | 之前 (s16) | 之后 (s17) |
|------|-----------|-----------|
| Agent 行为模式 | 响应协议请求 | 主动轮询，无需用户指令 |
| 生命周期 | 无 | `WORK → IDLE → SHUTDOWN`（真状态机） |
| 任务发现 | 显式协议 | `ScanUnclaimed` 自动扫描（依赖+归属感知） |
| 任务认领 | 无 | `AutoClaim` 自带扫描，**移除 globalThis 全局变量悄悄传状态的做法** |
| 等待机制 | 无 | `IdlePoll` 真轮询 + 超时，返回 `{ state, trigger }` |
| 归属校验 | 无 | 认领/完成均校验 `owner` |
| 多 Agent | 协议编排 | 邮箱驱动的自主队友子循环 |

---

## 运行

```bash
npm run s17            # 默认 mock，离线秒级完成
AGENT_MODE=mock npx tsx s17_autonomous_agents/agent.ts
```

预置 3 个任务，演示 `WORK → IDLE → WORK → SHUTDOWN` 完整生命周期与 owner 拒绝，最后打印 `[S17] 完成`。

真实模式（`--real`）默认使用 5000ms / 60000ms；演示时可用环境变量调节：

```bash
S17_IDLE_POLL_INTERVAL_MS=1000 S17_IDLE_TIMEOUT_MS=5000 npm run s17
```

---

## 本章小结

**自主 Agent = ScanUnclaimed（发现机会）+ AutoClaim（主动认领，自带扫描与归属/依赖校验）+ IdlePoll（真轮询，命中任务/来信回 work，超时回 shutdown）的循环。生命周期 WORK→IDLE→SHUTDOWN 是 Generator 里的真状态机，迁移由 Handler 返回的 `{ state, trigger }` 与真实条件驱动——没有任何用全局变量 `globalThis` 悄悄传状态的做法，自主性的复杂时序逻辑封装在效应边界内。**

---

<details>
<summary>深入 CC 源码</summary>

> 以下基于 CC 源码 `autonomous/agent.ts`、`task_board.ts` 的分析。

### 一、CC 的混合自主机制

CC 的自主模式比教学版的纯轮询更复杂——它是**事件驱动 + 轮询的混合**：

| 信号源 | 触发方式 |
|--------|---------|
| cron 定时器到期 | `ProcessCronQueue` 注入（对接 s14） |
| MCP Server 推送 | `channelNotification`（对接 s19） |
| 新 GitHub Issue | Webhook → 任务队列 |
| 无外部信号 | 退化为 5s 轮询 |

教学版只实现了轮询，没有事件驱动触发。

### 二、idle_poll 的实现

CC 的 `idle_poll` 是 `SleepTool`（一个特殊工具，非普通工具调用），LLM 调用它时 Agent Loop 暂停：
1. 设置一个定时器（间隔可在 `/loop` 命令中指定，默认 30s）
2. 同时监听外部事件（cron、MCP 通知、webhook）
3. `Promise.race([timer, externalEvent])` 谁先完成就唤醒

教学版直接在 Handler 内轮询，不用 `Promise.race`。

### 三、并发安全的任务认领

真实多 Agent 场景下，多个 Agent 可能同时扫描并尝试认领同一任务。CC 的任务板（task_board）用乐观锁：
- 读取任务的 `version` 字段
- 更新时 `WHERE version == $old_version`（等价于 CAS 操作）
- 更新失败 → `success=false` → 重新扫描

教学版单进程，直接覆盖写，不存在竞争。

### 四、SHUTDOWN 与平稳退出

CC 的 SHUTDOWN 不是直接退出，而是：
1. 等待所有 `in_progress` 任务完成（或超时强制取消）
2. 发送 `shutdown_complete` 通知给 coordinator
3. 清理临时文件和连接
4. 最后 exit

教学版的自主工作者在 IDLE 超时（或收到 `shutdown_request`）后退出，并把最终摘要作为 `result` 消息写回 lead 信箱；不做资源清理与强杀未完成任务。

### 教学版的简化

| 简化项 | 教学版 | CC |
|--------|--------|-----|
| 触发方式 | 纯轮询 | 混合（事件驱动 + 轮询退化） |
| idle_poll 机制 | Handler 内真轮询（sleep + 信箱 + 任务板） | SleepTool + `Promise.race` |
| 并发安全 | 单进程读写（owner 校验） | 乐观锁 + CAS |
| SHUTDOWN | 超时/请求后退出并回传 result | 平稳清理 + 通知 coordinator |

</details>
