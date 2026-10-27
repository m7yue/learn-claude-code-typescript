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

三个核心 Effect 构建自主行为循环，**没有任何用全局变量 `globalThis` 悄悄传状态的做法**——状态机的每一次迁移都由真实条件（任务板、信箱、超时）决定：

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

另有 `RequestShutdown`（Lead 请求 worker 优雅退出）、`WaitForTeammates`（Lead 回合结束后由宿主等待队友）和 `ReleaseTask`（worker 退出前归还自己名下未完成的任务）三个辅助 Effect；它们不参与空闲轮询的核心循环。

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
      if (inbox.some(m => m.type === 'shutdown_request')) {
        // 先回复 shutdown_response（带同一 request_id），再退出
        state = 'SHUTDOWN'; break;
      }
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
`WORK → IDLE` →（空闲期自动认领）`IDLE → WORK (claimed)` →（任务做完）`WORK → IDLE` →（任务板上没有可认领任务）`IDLE → SHUTDOWN (timeout)`。

两个容易看错的日志：

- 第一个 `[AutoClaim]` 发生在 **WORK** 阶段（模型调用 `auto_claim` 工具）；IDLE 阶段的认领由 `IdlePoll` handler 直接调 `claimTask`，日志是 `[idle] ... auto-claimed`，随后才是 `IDLE → WORK (claimed)`。
- worker 的工具集里没有 `idle_poll`；模型没活时结束回合（`stop_reason !== 'tool_use'`），worker 自己的循环把 `state` 改成 IDLE，再调用 `IdlePoll` Effect。状态机只有这一条空闲路径。

WORK 内层最多 10 轮 LLM 调用。到 10 轮还没完成已认领任务时，worker 先进入 IDLE；`IdlePoll` 会优先恢复这个任务，最多恢复 3 次，仍不完成才带着“未完成任务”的描述退出——这是教学版为控制单轮长度设的边界；真实 CC 的空闲/唤醒机制与此不同，不能直接按这 10 轮理解。

任务不会因此被永久搁置：模型提前结束回合时，如果自己名下还有 `in_progress` 任务，宿主会先提醒它继续完成（最多 3 次）；进入 IDLE 后，`IdlePoll` 也会优先恢复这个任务，而不是认领新任务。`claim_task` / `auto_claim` 在工作者已有未完成任务时会直接拒绝，保证“一次只做一件事”。如果多次提醒后模型仍不完成，worker 会带着“未完成任务”的描述退出，而不是在 IDLE↔WORK 之间无限空转；退出前它会把任务改回 `pending`、清空 owner，放回任务板，之后的 worker 可以重新认领。

### 身份重注入

WORK 开始时如果 `messages.length <= 3`，会在对话开头插入一条 `<identity>`。本章没有实现上下文压缩，所以这个条件主要覆盖启动阶段；真实 CC 的 compaction 会保留 system prompt，教学版用重注入模拟这一点。

### IdlePoll：真实轮询（默认 5s / 60s，mock 可配更快）

`IdlePoll` Handler 不是空转，它真的 `sleep` 并按轮执行四件事：

```
每 pollIntervalMs 一轮：
  1. 读自己的信箱 → 有 shutdown_request → 回 shutdown_response 并返回 shutdown
                    → 有普通消息 → 返回 work（回到 WORK 处理来信）
  2. 自己名下还有未完成任务 → 返回 work（trigger=resume，继续做，不认领新任务）
  3. 扫描任务板 → 有可认领任务 → 真认领（owner 写入 .tasks/s17/*.json）→ 返回 work
  4. 都没命中 → 继续下一轮；累计超过 IDLE_TIMEOUT_MS → 返回 shutdown
```

worker 的工具集里没有 `idle_poll`。模型没活时结束回合，worker 自己的循环进入 IDLE，再调用 `IdlePoll` Effect；上面的 sleep、读信箱、扫任务板、认领都是这条路径里的真实代码。

时序常量（`IDLE_POLL_INTERVAL_MS_DEFAULT=5s`、`IDLE_TIMEOUT_MS_DEFAULT=60s`）：

| 模式 | 轮询间隔 | 超时 | 说明 |
|------|---------|------|------|
| real 模式默认时序 | 5000ms | 60000ms | `--real` 或 `.env` 的 `AGENT_MODE=real` |
| mock（演示） | 20ms | 200ms | 显式 `--mock`，让演示秒级完成，但走的是**同一条真实轮询/超时路径** |

两者都可用环境变量覆盖：`S17_IDLE_POLL_INTERVAL_MS`、`S17_IDLE_TIMEOUT_MS`。未设置运行模式时默认 mock，但本机 `.env` 可能设为 real，所以命令里最好显式写 `--mock` 或 `--real`。

### ScanUnclaimed：依赖感知 + 归属感知

```typescript
// pending + 无 owner + 所有 blockedBy 依赖均已完成
function scanUnclaimedTasks(): TaskRecord[] {
  return listTasks().filter(t =>
    t.status === 'pending' && !t.owner && canStart(t.id)
  );
}
```

一个任务声明 `blockedBy: ['task_..._0001']`，在 `0001` 完成前不会出现在扫描结果里；`0001` 完成后 `completeTask` 只报告 `blockedBy` 直接包含 `0001`、且依赖已满足的 pending 下游任务，不会把无关任务也算作"解锁"。任务板位于 `.tasks/s17/`，启动时重置这个目录，不扫描共享 `.tasks/` 根目录。

### AutoClaim / ClaimTask / CompleteTask：owner 检查

`AutoClaim` **自己**扫描并认领第一个合格任务（这正是移除 `globalThis._pendingTaskId` 的关键）；三个任务效应都做真实校验：

- **认领**：任务必须 `pending`；**已有 owner 则拒绝**；依赖未满足则拒绝。`auto_claim` / `claim_task` 的 owner 都由宿主固定为当前工作者，模型不能替别人认领。
- **完成**：任务必须 `in_progress`；**owner 必须存在且匹配**——空 owner 也会被拒绝，一个工作者只处理自己拥有的任务。
- owner 持久化在 `.tasks/s17/<id>.json` 的 `owner` 字段，跨进程可见。

在单进程演示里读写不会被中途打断；多进程竞争场景需要任务级文件锁（教学版简化为单进程）。

### 队友循环：信箱驱动的自主工作者

lead 通过 `spawn_teammate` 拉起一个**独立 generator**（`autonomousWorkerLoop`），它有自己的 `messages` 和状态机：

- 从 `scan_unclaimed` / `auto_claim` 认领任务板上的活（**不依赖用户指令**，纯自主）。
- 结束时把最终摘要作为 `result` 消息**写回 lead 的信箱**（`SendMessage` → `.mailboxes/s17/main.jsonl`）。
- `check_inbox` 不等待，只读当前信箱。Lead 每次回合结束（`stop_reason !== 'tool_use'`）后，宿主用 `WaitForTeammates` 最多等一段固定时间，等活跃队友结束，再读一次信箱；有新消息就注入 `<inbox>` 并继续对话，最多 3 轮。这样报告能进入 Lead 的上下文，又不需要让 `check_inbox` 阻塞。
- 队友异常退出时，`startTeammate` 的 catch 会向 lead 写一条 `[teammate error]` result，把该队友记入 `teammateFailures`，并把它名下未完成的任务放回任务板；退出前仍有队友在运行也按失败处理。主脚本最终会打印 `[S17] 失败`，不会在 worker 崩溃时仍报成功。
- Lead 给已经退出的队友发消息会立即得到「队友未在运行」的工具错误，而不是写进一个没人读的信箱。
- Lead 的工具集也包含 `bash`；`leadLoop` 对 bash 做与 worker 相同的模拟执行，schema 与派发保持一致。

**最小关机协议**：Lead 可用 `request_shutdown` 发送 `shutdown_request`，消息 metadata 带 `request_id`；worker 在 WORK（`CheckInbox`）和 IDLE（`IdlePoll`）两处都能响应，回复 `shutdown_response` 并带回**同一个** `request_id`；退出前它会把未完成的 `in_progress` 任务放回任务板；Lead 下次收信时按 `request_id` 关联并打印 approved/rejected。默认 mock 剧本让 worker 空闲超时退出，`request_shutdown` 留给 real 模式或手动演示。

信箱是真实 JSONL 文件（`.mailboxes/s17/*.jsonl`），任务板是 `.tasks/s17/*.json`。启动时只清空本章的 `.mailboxes/s17/`、只重置 `.tasks/s17/`，不碰其它章节。

### 演示剧本（隔离工作区下结果可重复）

预置四个任务：`更新文档索引`（无依赖）、`清理日志文件`（依赖前者）、`task_owned_by_lead`（owner=`main`，pending，用于演示认领阶段的 owner 拒绝）、`task_owned_by_lead_active`（owner=`main`，in_progress，用于演示完成阶段的 owner 拒绝）。mock 工作者依次执行：

```
WORK   扫描 → 强行认领 lead 的 pending 任务（被拒）
       → 强行完成 lead 的 in_progress 任务（被拒）
       → 自动认领 A → 执行 → 完成 A（解锁 B）
IDLE   轮询 → 发现 B 可认领 → 自动认领 B
WORK   完成 B
IDLE   轮询 → 没有可认领任务 → 超时
SHUTDOWN → 把摘要（含已完成任务）经信箱回报 lead
```

结束时任务板并没有清空：两个 lead 持有的任务仍在板上，worker 是因为「没有可认领任务」才超时。工作者会做 `.tasks/s17/` 里所有可认领任务（不仅是预置的）；运行期间手动放进这个目录的新 pending 任务也会被认领。mock **只替换模型调用**；状态机、轮询、认领、信箱全部是真实代码。bash 在所有模式下都只回显命令文本，任务完成是任务板记账，不代表真的执行了命令。

---

## 相对 s16 的变更

| 组件 | 之前 (s16) | 之后 (s17) |
|------|-----------|-----------|
| Agent 行为模式 | 响应协议请求 | 主动轮询，无需用户指令 |
| 生命周期 | 空闲时轮询信箱、处理协议请求 | 显式 `WORK → IDLE → SHUTDOWN` 状态机 |
| 任务发现 | 显式协议 | `ScanUnclaimed` 自动扫描（依赖+归属感知） |
| 任务认领 | 无 | `AutoClaim` 自带扫描，**移除 globalThis 全局变量悄悄传状态的做法** |
| 等待机制 | 信箱轮询 + 协议响应等待 | `IdlePoll` 轮询信箱 + 任务板，60s 超时 |
| 归属校验 | 无 | 认领/完成均校验 `owner`（完成阶段空 owner 也拒绝） |
| 多 Agent | 协议编排 | 邮箱驱动的自主队友子循环 |
| 关机协议 | `request_shutdown` / `shutdown_response` + `request_id` | 保留最小版本：Lead 发 `request_shutdown`，worker 回同一 `request_id` |
| 信箱目录 | `.mailboxes/s16/*.jsonl` | `.mailboxes/s17/*.jsonl`（启动只清本章） |
| 任务板目录 | 无（s16 不使用任务板） | `.tasks/s17/`（启动只重置本章） |
| Lead 收信 | `check_inbox` 最多等 500ms（`waitMs` 可调）再读，回合结束直接返回 | `check_inbox` 非阻塞；`WaitForTeammates` 最多等一段时间，然后把新消息注入，最多 3 轮 |

---

## 运行

```bash
# mock（本机 .env 可能设了 AGENT_MODE=real，所以显式 --mock）
npm run s17 -- --mock
# 或
AGENT_MODE=mock npx tsx s17_autonomous_agents/agent.ts

# real（需要 .env 里的 ANTHROPIC_AUTH_TOKEN / MODEL_ID；缺少配置会回退 mock）
npm run s17 -- --real
```

预置 4 个任务，演示 `WORK → IDLE → WORK → SHUTDOWN` 完整生命周期、两处 owner 拒绝和报告注入，最后打印任务板状态与 `[S17] 完成: <lead 最终文本>`。

real 模式默认使用 5000ms / 60000ms；演示时可用环境变量调节：

```bash
S17_IDLE_POLL_INTERVAL_MS=1000 S17_IDLE_TIMEOUT_MS=5000 npm run s17 -- --real
```

real 模式单轮输出默认 4096 tokens，可用 `S17_MAX_TOKENS` 调整。`check_inbox` 不阻塞；Lead 回合结束后由 `WaitForTeammates` 最多等一段时间（`S17_JOIN_TIMEOUT_MS`，real 默认 90000ms），最终收尾再等 `S17_CLEANUP_WAIT_MS`（real 默认 3000ms）。如果 lead 自己失败，或者超时后仍有队友在运行，脚本会记录仍在运行的队友，进程可能被队友的空闲等待或模型请求拖住，直到队友自己退出。

**bash 在所有模式下都是模拟执行**：real 模式是「真实模型 + 模拟执行」，任务完成只是任务板记账，不代表真的执行了命令。

---

## 本章小结

**自主 Agent = ScanUnclaimed（发现机会）+ AutoClaim（主动认领，自带扫描与归属/依赖校验）+ IdlePoll（真轮询，命中任务/来信回 work，超时回 shutdown）的循环。生命周期 WORK→IDLE→SHUTDOWN 是 Generator 里的真状态机，迁移由 Handler 返回的 `{ state, trigger }` 与真实条件驱动——没有任何用全局变量 `globalThis` 悄悄传状态的做法，自主性的复杂时序逻辑封装在效应边界内。**

Lead 的 `request_shutdown` 与 worker 的 `shutdown_response` 用同一个 `request_id` 关联；`check_inbox` 非阻塞，回合结束由宿主最多等一段时间，再注入报告。worker 退出前会把未完成的任务放回任务板。

---

<details>
<summary>深入 CC 源码</summary>

> 以下依据 CC 源码中 `inProcessRunner.ts`、`hooks/useTaskListWatcher.ts`、`utils/tasks.ts` 的实现整理。

### 一、CC 的空闲机制：组合路径，不是单一轮询

CC 不是只靠一个 `idle_poll` 函数，而是四个机制组合：

- **idle_notification**：队友完成一轮工作后，`sendIdleNotification()`（`inProcessRunner.ts:569-589`）向 Lead 发送空闲通知。Lead 知道队友可用了，可以分配新任务或请求关机。
- **mailbox 轮询**：`waitForNextPromptOrShutdown()`（`inProcessRunner.ts:689-868`）是一个 **500ms 轮询循环**，持续检查三类来源：pending user messages、mailbox 文件消息、task list。`shutdown_request` 被优先处理（`inProcessRunner.ts:768-804`），不会被普通消息饿死。
- **task watcher**：`useTaskListWatcher`（`hooks/useTaskListWatcher.ts:34-189`）用 `fs.watch()` 监听任务目录，1 秒 debounce，当新任务创建或依赖解锁时触发检查。依赖判断（L197-207）是「blockedBy 中没有未完成任务」，不是「blockedBy 为空」。
- **主动认领**：轮询循环内部也会调用 `tryClaimNextTask()`（`inProcessRunner.ts:853-860`）——在等待期间主动从 task list 领取任务。所以「队友不主动轮询任务」不准确，CC 同时有被动通知和主动认领。

### 二、任务认领：文件锁 + 原子操作

`claimTask()`（`utils/tasks.ts:541-612`）用 `proper-lockfile` 的任务文件锁，在锁内完成读-检查-改-写。检查项：owner 是否已存在（L575-576）、是否已完成（L580-581）、blockedBy 中是否有未完成任务（L585-594）。

`claimTaskWithBusyCheck()`（`utils/tasks.ts:614-692`）用 task-list 级别锁，把 busy check 和 claim 做成原子操作，避免 TOCTOU。

`findAvailableTask()`（`inProcessRunner.ts:595-604`）的依赖判断也是「所有 blockedBy 已完成」；`tryClaimNextTask()`（`inProcessRunner.ts:624-657`）在认领后把状态更新为 `in_progress`，让 UI 立即反映变化。

### 三、教学版 vs CC

| 维度 | 教学版 (s17) | CC |
|------|-------------|-----|
| 空闲机制 | `IdlePoll` 统一轮询（5s / 60s） | `idle_notification` + 500ms mailbox 轮询 + task watcher |
| 任务发现 | `scanUnclaimedTasks`（轮询） | `useTaskListWatcher`（文件监听）+ `tryClaimNextTask`（主动轮询） |
| 依赖判断 | `canStart`（所有 blockedBy 已完成） | `findAvailableTask`（同样语义） |
| 并发安全 | 单进程 owner 检查（无文件锁） | `proper-lockfile` 任务锁 + task-list 锁 |
| shutdown 处理 | WORK/IDLE 两处响应；默认 60s 空闲超时退出 | 500ms 轮询中优先处理 `shutdown_request`；无固定超时，由 Lead 手动关闭 |
| 身份保持 | `messages.length <= 3` 重注入（本章无压缩，主要覆盖启动阶段） | context compaction 保留 system prompt |
| claim 失败处理 | 检查返回值，失败不注入 | 文件锁保证原子性 |

教学版的 `IdlePoll` 把 CC 的四个机制合并成一个轮询函数——简化合理，因为核心语义（空闲时找活干、依赖解锁后可认领、shutdown 优先）是一致的。

</details>
