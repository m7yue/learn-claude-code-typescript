# s14: Cron Scheduler — 定时任务是时间维度的效应

[s13](../s13_background_tasks/) → [s14] → [s15](../s15_agent_teams/)

---

## 第一性原理

**问题的本质**：Agent 有些工作需要周期性执行——每分钟检查构建状态、每天凌晨3点清理缓存。这是"时间触发的效应"。

核心问题不是"如何计时"，而是"谁来声明何时执行什么"——让业务逻辑声明调度意图，把时钟状态封装在 Handler 里。

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

// 2. 处理到期队列（Handler 内部用 cronMatches 比对当前时间）
const triggers = yield* perform({ type: 'ProcessCronQueue', input: {} });
for (const t of triggers) {
  // 触发的 prompt 可以注入 Agent 对话，驱动下一步行动
  console.log(`触发: ${t.prompt} (第 ${t.runCount} 次)`);
}

// 3. 随时取消
yield* perform({ type: 'CancelCron', input: { cronId: 'cleanup' } });
```

| Python 概念 | 代数效应 TypeScript |
|------------|-------------------|
| `CronJob(cron='* * * * *', func=check)` | `ScheduleCron` Effect |
| `cron_scheduler_loop()` | Handler 内的 `cronJobs` Map + `cronMatches()` |
| `job.cancel()` | `CancelCron` Effect |
| `queue.get_due_jobs()` | `ProcessCronQueue` Effect |
| `durable=True` | `durable: true` → 持久化到 `.scheduled_tasks.json` |

---

## 工作原理

### cron 5字段表达式解析

```typescript
// 单字段匹配：支持 * | 数字 | */N（步长）
function cronFieldMatches(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return !isNaN(step) && value % step === 0;
  }
  return parseInt(field, 10) === value;
}

// 5字段：分 时 日 月 周
// 对应 CC 源码 cron.ts 的 parseCronExpression + isCronJobDue
function cronMatches(expr: string, date: Date): boolean {
  const [minF, hourF, domF, monF, dowF] = expr.trim().split(/\s+/);
  // 日 和 周 都不是 * 时用 OR 语义（标准 cron 行为）
  const domStar = domF === '*';
  const dowStar = dowF === '*';
  if (!domStar && !dowStar) {
    if (!cronFieldMatches(domF, date.getDate()) && !cronFieldMatches(dowF, date.getDay())) return false;
  } else {
    if (!cronFieldMatches(domF, date.getDate())) return false;
    if (!cronFieldMatches(dowF, date.getDay())) return false;
  }
  return cronFieldMatches(minF, date.getMinutes())
    && cronFieldMatches(hourF, date.getHours())
    && cronFieldMatches(monF, date.getMonth() + 1);
}
```

表达式示例：`* * * * *`（每分钟）、`0 3 * * *`（每天凌晨3点）、`*/5 * * * *`（每5分钟）。

### durable 持久化

```typescript
// durable=true 的任务写入磁盘，进程重启后自动恢复
function persistDurableJobs(): void {
  const durableJobs = [...cronJobs.values()].filter(j => j.durable);
  fs.writeFileSync(CRON_PERSIST_PATH, JSON.stringify(durableJobs, null, 2), 'utf8');
}
```

持久化路径：`/tmp/learn-claude-code-typescript/s14/.scheduled_tasks.json`。启动时调用 `loadDurableJobs()` 恢复。

### recurring vs one-shot

```typescript
// recurring=false：触发一次后自动从 cronJobs 删除
if (!job.recurring) {
  toDelete.push(id);
}
```

`cleanup` 任务（`0 3 * * *`，`recurring: false`）触发一次后自动注销；`health_check`（`* * * * *`，`recurring: true`）持续运行。

---

## 相对 s13 的变更

| 组件 | 之前 (s13) | 之后 (s14) |
|------|-----------|-----------|
| 调度粒度 | 后台任务（毫秒级 intervalMs） | cron 表达式（分钟级，5字段） |
| `CronJob` 接口 | `intervalMs` + `nextRunMs` | `cron`（表达式）+ `recurring` + `durable` |
| 时间匹配 | `Date.now() >= nextRunMs` | `cronMatches(expr, new Date())` |
| 持久化 | 无 | `durable=true` → `.scheduled_tasks.json` |
| 新 Handler | `SpawnBackground`, `CollectNotifications` | `ScheduleCron`, `CancelCron`, `ProcessCronQueue` |
| 新工具函数 | — | `cronFieldMatches`, `cronMatches` |

---

## 运行

```bash
npm run s14
```

---

## 本章小结

**cron 表达式 = 时间意图的语言。`cronFieldMatches` 处理单字段（`*` / 数字 / `*/N`），`cronMatches` 组合 5 字段，`durable: true` 让任务跨重启持久化，`recurring: false` 实现一次性触发。Generator 只声明"何时做什么"，Handler 持有时钟状态——时间逻辑与业务逻辑彻底分离。**

---

<details>
<summary>深入 CC 源码</summary>

> 以下基于 CC 源码 `services/cron/cron.ts`、`tools/scheduleCron.ts` 的分析。

### 一、4 种工具细节

CC 的 cron 工具集比教学版多一个：

| 工具 | 用途 |
|------|------|
| `schedule_cron` | 注册新 cron 任务（含 `cron` 表达式 + `durable`） |
| `cancel_cron` | 按 ID 取消任务 |
| `process_cron_queue` | 查询到期任务并触发 |
| `list_scheduled_tasks` | 列出所有活跃任务（教学版省略） |

### 二、注入时机：不是工具调用，而是消息前置

CC 的 cron 触发不是 LLM 调用 `process_cron_queue` 工具——而是 Agent Loop 在每轮 `client.messages.create()` **之前**自动调用 `getCronNotifications()`，将到期任务的 `prompt` 包裹在 `<task_notification>` 标签中，前置注入 `messages` 数组。

```typescript
// CC 伪代码（cron 注入时机）
const pending = cronScheduler.getDueJobs();
if (pending.length > 0) {
    messages.unshift({
        role: "user",
        content: `<task_notification>\n${pending[0].prompt}\n</task_notification>`
    });
}
```

教学版让 LLM 显式调用 `process_cron_queue` 工具，便于演示机制，但真实 CC 是自动注入——对 LLM 完全透明。

### 三、1 秒轮询 + 抖动

CC 的 cron 调度器每 1 秒轮询一次 `isCronJobDue()`，但为了避免多个 Agent 实例同步竞争，加入了随机抖动（0-100ms）。教学版每轮 `ProcessCronQueue` 才检查，不做轮询。

### 四、durable 存储格式

CC 的 `.scheduled_tasks.json` 格式包含额外字段：
- `lastRunAt`：上次触发时间戳（`isCronJobDue` 用来防止同一分钟内重复触发）
- `createdBy`：创建该任务的 Agent ID

教学版存储 `CronJob` 全字段，简化了 `lastRunAt` 检查（不防重复触发）。

### 五、触发上限

CC 对单次 `getCronNotifications()` 返回的任务数有上限（默认 5 个），防止一次注入过多通知导致上下文膨胀。教学版无此限制。

### 教学版的简化

| 简化项 | 教学版 | CC |
|--------|--------|-----|
| 注入方式 | LLM 调用工具 | Loop 自动前置注入 |
| 轮询 | 无（按需调用） | 1s 轮询 + 随机抖动 |
| 重复触发防护 | 无 | `lastRunAt` 分钟级去重 |
| 触发上限 | 无 | 单次最多 N 个 |
| 工具数量 | 3 | 4（含 `list_scheduled_tasks`） |

</details>
