# s17: Autonomous Agents — 空闲循环是自主行为的效应基础

[s16](../s16_team_protocols/) → [s17] → [s18](../s18_worktree_isolation/)

---

## 第一性原理

**问题的本质**：之前所有章节的 Agent 都在响应用户指令。真正的自主 Agent 不需要用户推动——它主动扫描环境，发现可以做的工作就去做。

自主性 = 主动轮询 + 机会主义执行 + WORK/IDLE/SHUTDOWN 生命周期管理。

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

三个 Effect 构建自主行为循环：

```typescript
// 扫描可认领任务（status=pending 且依赖已满足）
const unclaimedTasks = yield* perform({ type: 'ScanUnclaimed', input: {} });

// 机会主义认领（并发安全，success=false 时重新扫描）
const { task, success } = yield* perform({
  type: 'AutoClaim',
  input: { taskId: unclaimedTasks[0].id, owner: 'autonomous_agent' }
});

// 空闲等待：Handler 内部轮询，发现任务返回 'work'，超时返回 'shutdown'
const outcome = yield* perform({
  type: 'IdlePoll',
  input: { pollIntervalMs: 5000, reason: '等待新任务' }
});
// outcome === 'shutdown' → 退出主循环
```

**关键洞见**：`IdlePoll` 将"等待"从 `setTimeout(fn, delay)` 提升为效应声明，Handler 决定实际等待策略（固定间隔、指数退避、外部信号监听），并负责 IDLE→SHUTDOWN 超时判断。Generator 只说"我现在空闲"。

| Python 自主循环 | 代数效应 TypeScript |
|---------------|-------------------|
| `scan_unclaimed_tasks()` | `ScanUnclaimed` Effect |
| `task.claim(owner)` + 文件锁 | `AutoClaim` Effect（Handler 做原子写）|
| `Promise.race([poll, timeout])` | `IdlePoll` Handler 内循环 |
| `WORK / IDLE / SHUTDOWN` 状态 | `lifecycle` 变量 + Handler 转换 |

---

## 工作原理

### WORK → IDLE → SHUTDOWN 生命周期

```typescript
type AgentLifecycle = 'WORK' | 'IDLE' | 'SHUTDOWN';
let lifecycle: AgentLifecycle = 'WORK';

// 任务执行完毕 → IDLE
task.status = 'completed';
lifecycle = 'IDLE';
idleStartedAt = Date.now();

// IdlePoll Handler：内部轮询 + 超时
async function handleIdlePoll(pollIntervalMs: number): Promise<'work' | 'shutdown'> {
  const start = idleStartedAt ?? Date.now();
  while (Date.now() - start < IDLE_TIMEOUT_MS) {
    await sleep(pollIntervalMs);
    const unclaimed = scanPendingTasks();
    if (unclaimed.length > 0) {
      lifecycle = 'WORK';
      return 'work';  // 发现新任务，回到 WORK
    }
  }
  lifecycle = 'SHUTDOWN';
  return 'shutdown';  // 超时，进入 SHUTDOWN
}
```

### ScanUnclaimed：依赖感知的任务筛选

```typescript
// 返回 status=pending 且所有依赖均已完成的任务
const tasks = listAllTasks().filter(t =>
  t.status === 'pending' &&
  t.blockedBy.every(dep => loadTask(dep)?.status === 'completed')
);
```

一个任务可以声明 `blockedBy: ['task_001']`，在 `task_001` 完成前不出现在扫描结果中。

### AutoClaim 的原子性

Handler 读取任务文件 → 检查 `status === 'pending'` → 更新为 `in_progress` → 写回磁盘。在单进程场景下这是原子的；多进程场景需要文件锁（教学版简化为单进程）。

---

## 相对 s16 的变更

| 组件 | 之前 (s16) | 之后 (s17) |
|------|-----------|-----------|
| Agent 行为模式 | 响应协议请求 | 主动轮询，无需用户指令 |
| 生命周期 | 无 | `WORK → IDLE → SHUTDOWN` |
| 任务发现 | 显式协议 | `ScanUnclaimed` 自动扫描 |
| 等待机制 | 无 | `IdlePoll` 含超时返回值 |
| IdlePoll 返回 | `void` | `'work' \| 'shutdown'` |
| 依赖检查 | 无 | `blockedBy` 链式依赖 |

---

## 运行

```bash
npm run s17
```

预置了 2 个未认领任务，演示 WORK→IDLE→WORK→SHUTDOWN 完整生命周期。

---

## 本章小结

**自主 Agent = ScanUnclaimed（发现机会）+ AutoClaim（机会主义认领）+ IdlePoll（空闲等待，超时返回 shutdown）的循环。生命周期 WORK→IDLE→SHUTDOWN 由 Handler 内的时间判断驱动，Generator 只看到 `'work' | 'shutdown'` 返回值——自主性的复杂时序逻辑全部封装在效应边界内。**

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

### 四、SHUTDOWN 与优雅退出

CC 的 SHUTDOWN 不是直接退出，而是：
1. 等待所有 `in_progress` 任务完成（或超时强制取消）
2. 发送 `shutdown_complete` 通知给 coordinator
3. 清理临时文件和连接
4. 最后 exit

教学版直接 `end_turn`，不做清理。

### 教学版的简化

| 简化项 | 教学版 | CC |
|--------|--------|-----|
| 触发方式 | 纯轮询 | 混合（事件驱动 + 轮询退化） |
| idle_poll 机制 | Handler 内循环 | SleepTool + `Promise.race` |
| 并发安全 | 无（单进程） | 乐观锁 + CAS |
| SHUTDOWN | 直接退出 | 优雅清理 + 通知 coordinator |

</details>
