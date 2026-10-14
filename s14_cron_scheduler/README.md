# s14: Cron Scheduler — 定时任务是时间维度的效应

[s13](../s13_background_tasks/) → [s14] → [s15](../s15_agent_teams/)

---

## 第一性原理

**问题的本质**：Agent 有些工作需要周期性执行——每分钟检查构建状态、每天凌晨3点清理缓存。这是"时间触发的效应"。

核心问题不是"如何计时"，而是"谁来声明何时执行什么"——让业务逻辑声明调度意图，把时钟状态封装在 Handler 与独立定时器里。

---

## 问题

```typescript
// 没有 cron 时，用轮询实现周期任务
while (true) {
    if (Date.now() - lastCheck > 300 * 1000) {  // 5分钟
        checkBuild();
        lastCheck = Date.now();
    }
    // 时间逻辑（300秒间隔）混入业务逻辑（检查构建）
}
```

---

## 代数效应视角

三个 Effect 分离"何时"（声明）和"如何计时"（执行）：

```typescript
// 1. 声明调度意图：每分钟执行，持久化（重启后保留）
yield* perform({
  type: 'ScheduleCron',
  input: { cronId: 'health_check', cron: '* * * * *', prompt: '执行健康检查', recurring: true, durable: true }
});

// 2. 查看已注册任务（Handler 持有时钟状态，Generator 不感知时间）
const jobs = yield* perform({ type: 'ListCrons', input: {} });

// 3. 随时取消
yield* perform({ type: 'CancelCron', input: { cronId: 'cleanup' } });
```

| Python 概念 | 代数效应 TypeScript |
|------------|-------------------|
| `CronJob(id, cron, prompt, recurring, durable)` | `CronJob` 接口（同字段，去掉无用的 runCount/lastRunAt） |
| `schedule_job()` / `cancel_job()` | `ScheduleCron` / `CancelCron` Effect |
| `run_list_crons()` | `ListCrons` Effect |
| `cron_scheduler_loop()` 守护线程 | 真实 `setInterval(cronSchedulerTick, TICK_MS)` |
| `queue_processor_loop()` 守护线程 | 真实 `setInterval(queueProcessorTick, QUEUE_MS)` |
| `cron_queue` + `cron_lock` | `cronQueue` 数组 + `Mutex`（`runtime/locks.ts`） |
| `agent_lock` | `agentLock: Mutex`（`tryAcquire` 对应 `acquire(blocking=False)`） |
| `_last_fired` 分钟标记 | `lastFired: Map<id, "YYYY-MM-DD HH:MM">` |
| `durable=True` | 写入工作区 `.scheduled_tasks.json` |

> 注意：**不是**由 LLM 主动调用某个"处理队列"工具来触发任务。到期的任务由独立的调度器定时器写入队列，队列处理器在 Agent 空闲时唤醒一个 turn，turn 在每次 Chat 之前自动把 `[Scheduled] <prompt>` 注入消息。Generator 从不轮询时钟。

---

## 工作原理

### 1. 两层真实定时器（与 Python 的守护线程对应）

Python 用两个 `threading.Thread(daemon=True)`；TS 用两个 `setInterval`：

```typescript
// 层 1：调度器——每秒检查 cron 表达式，命中则入队
const schedulerTimer = setInterval(() => { void cronSchedulerTick(); }, TICK_MS);

// 层 2：队列处理器——检查队列，Agent 空闲时唤醒一个 turn
const queueTimer = setInterval(() => { void queueProcessorTick(); }, QUEUE_MS);
```

周期可由环境变量调整：`S14_TICK_MS`（默认 `1000`）、`S14_QUEUE_MS`（默认 `200`）。

调度器 tick（持 `cronLock`）：

```typescript
async function cronSchedulerTick(): Promise<void> {
  const now = new Date();
  const marker = minuteMarker(now);            // "YYYY-MM-DD HH:MM"
  await cronLock.withLock(() => {
    for (const job of [...scheduledJobs.values()]) {
      if (!cronMatches(job.cron, now)) continue;
      if (lastFired.get(job.id) !== marker) {  // 分钟级去重
        cronQueue.push(job);
        lastFired.set(job.id, marker);
        console.log(`[cron fire] ${job.id} → ${job.prompt}`);
      }
      if (!job.recurring) {                    // 一次性任务触发后注销
        scheduledJobs.delete(job.id);
        if (job.durable) saveDurableJobs();
      }
    }
  });
}
```

日期感知的分钟标记（`YYYY-MM-DD HH:MM`）保证同一天内每分钟只触发一次，且跨天后不会漏触发。

### 2. 队列处理器：Agent 空闲时才唤醒

```typescript
async function queueProcessorTick(): Promise<void> {
  if (!hasCronQueue()) return;
  const release = agentLock.tryAcquire();   // 等价于 acquire(blocking=False)
  if (!release) return;                      // 已有 turn 在跑 → 跳过
  try {
    if (!hasCronQueue()) return;
    await runAgentTurn();                    // 消费队列 → 注入 → Chat
  } finally {
    release();
  }
}
```

`agentLock` 保证同一时刻只有一个 Agent turn 运行：主流程的第一个 turn 与队列处理器唤醒的 turn 不会并发。

### 3. 消费队列：注入 `[Scheduled]` 消息

`agentTurn` 是一个"turn"（跑到模型不再请求工具为止）。每轮 Chat 前先消费队列：

```typescript
while (true) {
  const fired = consumeCronQueue();          // 取出并清空 cronQueue
  for (const job of fired) {
    sessionHistory.push({ role: 'user', content: `[Scheduled] ${job.prompt}` });
    console.log(`[inject cron] ${job.prompt}`);
  }
  const response = yield* perform({ type: 'Chat', input: { messages: sessionHistory } });
  // ...
}
```

`consumeCronQueue` 是同步的（JS 单线程下相对于其它 JS 执行是不可分割的，中间不会被打断），因此 Generator 无需 await 锁即可安全读取。

### 4. cron 5 字段表达式解析

```typescript
// 单字段匹配：支持 * | N | */N | N-M | N,M
function cronFieldMatches(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) { const step = Number(field.slice(2)); return step > 0 && value % step === 0; }
  if (field.includes(',')) return field.split(',').some(f => cronFieldMatches(f.trim(), value));
  if (field.includes('-')) { /* lo <= value <= hi */ }
  return Number(field) === value;
}

// 5字段：分 时 日 月 周
// 日 和 周 都不是 * 时用 OR 语义（标准 cron 行为）
function cronMatches(expr: string, dt: Date): boolean {
  const [minute, hour, dom, month, dow] = expr.trim().split(/\s+/);
  if (!(cronFieldMatches(minute, dt.getMinutes())
      && cronFieldMatches(hour, dt.getHours())
      && cronFieldMatches(month, dt.getMonth() + 1))) return false;
  const domStar = dom === '*', dowStar = dow === '*';
  if (domStar && dowStar) return true;
  if (domStar) return cronFieldMatches(dow, dt.getDay());
  if (dowStar) return cronFieldMatches(dom, dt.getDate());
  return cronFieldMatches(dom, dt.getDate()) || cronFieldMatches(dow, dt.getDay());
}
```

`validateCron`（5 字段 + 各字段边界 `[0-59]/[0-23]/[1-31]/[1-12]/[0-6]`）在注册时校验，非法表达式直接返回错误而不会入表。表达式示例：`* * * * *`（每分钟）、`0 3 * * *`（每天凌晨3点）、`*/5 * * * *`（每5分钟）、`0 9 * * 1-5`（工作日9点）。

### 5. durable 持久化

```typescript
// durable=true 的任务写入工作区 .scheduled_tasks.json，进程重启后自动恢复
function saveDurableJobs(): void {
  const durable = [...scheduledJobs.values()].filter(j => j.durable);
  fs.writeFileSync(SCHEDULED_TASKS_PATH, JSON.stringify(durable, null, 2), 'utf8');
}
```

持久化路径 `SCHEDULED_TASKS_PATH` 来自 `runtime/workspace.ts`（即工作区根目录下的 `.scheduled_tasks.json`；可用 `AGENT_WORKSPACE` 隔离）。

保存时机：
- `schedule_job` 注册 durable 任务后
- `cancel_job` 取消 durable 任务后
- 调度器移除一次性（`recurring: false`）durable 任务后

启动时 `loadDurableJobs()` 读取并**逐条校验** cron 表达式，非法任务被跳过并打印 `[cron] skipping invalid job ...`。

### 6. recurring vs one-shot

`recurring: false` 的任务由调度器在命中的同一 tick 内从 `scheduledJobs` 移除；`recurring: true` 的任务持续保留（受分钟去重保护，每分钟最多触发一次）。

---

## 相对 s13 的变更

| 组件 | 之前 (s13) | 之后 (s14) |
|------|-----------|-----------|
| 调度粒度 | 后台任务（毫秒级 intervalMs） | cron 表达式（分钟级，5字段） |
| `CronJob` 接口 | `intervalMs` + `nextRunMs` | `cron` + `recurring` + `durable` |
| 时间匹配 | `Date.now() >= nextRunMs` | `cronMatches(expr, new Date())` |
| 触发路径 | 前台轮询 / 等待 | 独立调度器定时器 → 队列 → 队列处理器唤醒 |
| 持久化 | 无 | `durable=true` → `.scheduled_tasks.json` |
| 新 Effect | `SpawnBackground`, `CollectNotifications` | `ScheduleCron`, `ListCrons`, `CancelCron` |
| 新工具函数 | — | `cronFieldMatches`, `cronMatches`, `validateCron` |
| 并发控制 | 单线程 setTimeout | `cronLock` + `agentLock`（`runtime/locks.ts`） |

> 说明：本章聚焦 cron 机制，为保持章节精简，未重复实现后台任务——该机制已在 [s13](../s13_background_tasks/) 讲解。这里不做任何"假"的后台实现（宁可省略也不伪造）。

---

## 运行

```bash
npm run s14                 # mock 模式（离线，仅替换模型调用）
S14_TICK_MS=1000 S14_QUEUE_MS=200 npm run s14
```

mock 脚本驱动：注册一个匹配「当前分钟」的 cron 任务 → `list_crons` → 结束第一轮；调度器在 ~1s 内命中并入队；队列处理器唤醒 Agent，注入 `[Scheduled] 执行健康检查`，模型确认后收尾。

---

## 本章小结

**cron 表达式 = 时间意图的语言。`cronFieldMatches` 处理单字段（`*` / `N` / `*/N` / `N-M` / `N,M`），`cronMatches` 组合 5 字段并按 DOM/DOW OR 语义匹配；独立的调度器定时器把命中任务写入队列（`_last_fired` 分钟去重、一次性任务自动注销），队列处理器在 Agent 空闲时唤醒 turn 并把 `[Scheduled] <prompt>` 注入消息；`durable: true` 让任务跨重启持久化。Generator 只声明"何时做什么"，时钟状态由 Handler 与定时器持有——时间逻辑与业务逻辑彻底分离。**

---

<details>
<summary>深入 CC 源码</summary>

> 以下基于 CC 源码 `services/cron/cron.ts`、`tools/scheduleCron.ts` 的分析。

### 一、工具集

教学版与 CC 一致，提供三个由模型调用的 cron 工具：

| 工具 | 用途 |
|------|------|
| `schedule_cron` | 注册新 cron 任务（含 `cron` 表达式 + `recurring` + `durable`） |
| `list_crons` | 列出所有活跃任务 |
| `cancel_cron` | 按 ID 取消任务 |

**触发不是工具调用**。到期的任务由调度器定时器写入队列，队列处理器唤醒 Agent 后自动注入——对 LLM 完全透明。

### 二、注入时机：消息前置，而非工具调用

CC 在每轮 `client.messages.create()` **之前**自动取出到期任务，把 `prompt` 包裹后前置注入 `messages`。教学版用同样的机制：

```typescript
// 每轮 Chat 前（agentTurn 循环顶部）
const fired = consumeCronQueue();
for (const job of fired) {
  sessionHistory.push({ role: 'user', content: `[Scheduled] ${job.prompt}` });
}
```

### 三、1 秒轮询 + 随机延时

CC 的 cron 调度器每 1 秒轮询一次 `isCronJobDue()`，并加入随机延时（0-100ms）避免多实例同步竞争。教学版同样是 1 秒轮询（`S14_TICK_MS`），省去了随机延时。

### 四、durable 存储格式

CC 的 `.scheduled_tasks.json` 额外包含 `lastRunAt`（分钟级去重）与 `createdBy`（创建者 Agent ID）。教学版把去重状态放在内存 `lastFired` 中，磁盘上只持久化 `CronJob` 的 5 个字段。

### 五、触发上限

CC 对单次通知返回的任务数有上限（默认 5 个），防止一次注入过多通知导致上下文膨胀。教学版无此限制。

### 教学版与 CC 的差异

| 项 | 教学版 | CC |
|----|--------|-----|
| 调度实现 | `setInterval` 定时器 | 守护线程 / 服务 |
| 轮询时的随机延时 | 无 | 1s 轮询 + 随机延时 |
| 去重状态 | 内存 `lastFired` | 磁盘 `lastRunAt` |
| 触发上限 | 无 | 单次最多 N 个 |
| 创建者字段 | 无 | `createdBy` |

</details>
