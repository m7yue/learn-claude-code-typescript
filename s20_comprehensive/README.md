# s20: Comprehensive — 一个真实整合的 Agent Harness

[s19](../s19_mcp_plugin/) → **[s20]**

---

## 第一性原理

**问题的本质**：前 19 章各展示一个机制。真实 Agent 需要在一个连贯的工作流里同时驱动它们——任务图、队友协议、后台执行、cron、worktree 隔离、MCP 工具池、错误恢复、上下文压缩。

本章把这些机制**真正组合**进一个可运行的 Harness：`s20_comprehensive/effects.ts` 声明 **41 个 Effect**，全部由 `s20_comprehensive/handlers.ts` 的 `s20Handlers` 提供真实实现（`EffectHandlers<S20Effect>` 的类型映射强制“每个 Effect 都必须有 handler”，避免出现声明了却接不上的无用代码）。**唯一被 mock 替换的是“模型调用”这一步**——并发任务、定时器、持久化、git、协议是真实副作用；bash 的后台命令执行沿用全章模拟约定，MCP 使用进程内教学 server。

---

## 目录

- [真实机制清单](#真实机制清单)
- [代码结构](#代码结构)
- [41 个 Effect](#41-个-effect)
- [工具集](#工具集)
- [确定性 mock 驱动的流程](#确定性-mock-驱动的流程)
- [代数效应视角](#代数效应视角)
- [运行](#运行)
- [项目小结](#项目小结)

---

## 真实机制清单

| 机制 | 章节 | 本实现（不是写死的占位） |
|------|------|----------------------|
| 任务系统 + blockedBy 依赖图 | s12 / s17 | 每个任务一个 JSON 文件持久化到 `.tasks/`；`blockingDeps`/`canStart` 真实判定依赖；`preferredOwner` 预订 owner，worker 空闲时只自主认领分配给自己的可开始任务；`complete` 会计算并回报新解除阻塞的任务 |
| 后台执行 | s13 | `runtime/background.ts` 的注册表启动独立后台 Promise，结果写入 `.task_outputs/bg_xxxx.log`，通知使用真实 CC 的 `<task-notification>`（task-id / task-type / status / summary / output-file）；lead 在回合结束前也会排空通知。命令执行沿用全章模拟约定，但模拟结果同样落盘、可失败 |
| cron 调度器 | s14 | 解析与校验复用 `runtime/cron.ts`（`*/N` 从字段最小值起算、日/周 OR、非法表达式拒绝）；`setInterval`（`.unref()`）真实定时触发；`.scheduled_tasks.json` 持久化，启动时逐条校验恢复；按分钟标记去重；`cancel_cron` 会同时清掉已入队任务；本章只在 lead 运行期间消费队列（s14 有空闲队列处理器） |
| 队友循环 + 信箱 | s15 | 每个队友是一条独立 `runAgent` 子循环（真实并发 Promise）；`MessageBus` 以 `.mailboxes/s20/*.jsonl` 写入磁盘，`waitForMessage` 等待新消息，写入后 `completeWait` 结束等待；lead 每轮开始自动注入队友结果，计划请求仍留给 `check_inbox(expectType)` |
| request_id 协议状态机 | s16 | `protocol` store 登记请求；`settle` 按 `request_id` + 期望类型**双校验**，未知 / 错类型 / 重复一律拒绝，迟到的 `shutdown_response` 也会被分类落定；`pollForResponse` / `waitForMessage` 同步 |
| 计划审批关口（真关口） | s16 | 队友 `SubmitPlan` 把计划登记为待处理，并发 `plan_approval_request`，随后 `WaitForPlanResponse` **阻塞**直到 lead 用 `ReviewPlan` 先发回匹配的 `plan_approval_response`，成功后再落定请求（approved/rejected，汇总里保留该记录）；未批准（rejected/超时）时队友的工作类工具会被拒绝 |
| 自主 WORK/IDLE/SHUTDOWN | s17 | 队友空闲时 `IdlePoll` 阻塞等待；计划批准后按 `preferredOwner` 自主认领可开始任务，认领结果注入对话；收到 `shutdown_request` 立即回 `shutdown_response` 退出 |
| git worktree 隔离 | s18 | `spawnSync('git', ...)` 真实 `git worktree add/remove`；创建前先建 `.worktrees` 父目录；有未提交文件或未合并 commit 时拒绝删除，除非 `discard_changes`；`create_worktree` 带 `taskId` 会真实写回任务；`ensureGitRepo()` 在非 git 工作区自动 `git init` |
| MCP 工具池 | s19 | 宿主在 `leadLoop` 启动时连接进程内教学 MCP server（`docs`=search/fetch、`deploy`=status）；`AssembleToolPool` 把 `mcp__{server}__{tool}` 装配进工具池；`MCPToolCall` 路由调用 |
| 上下文压缩流水线 | s08 | 与 s08 共用 `runtime/compaction.ts`：L3 大输出写盘 → L1 snip（保留头部 + 配对边界）→ L2 micro（只清较旧的长结果）→ L4 LLM 摘要（保留原任务锚点）；`prompt_too_long` 走同样的摘要 + 尾部 + 锚点 |
| 系统提示装配 | s10 | `AssemblePrompt` 按运行时上下文拼装能力说明、队友/MCP 状态与记忆；本章没有本地缓存 |
| 错误恢复 | s11 | 与 s11 共用 `runtime/recovery.ts`：429 退避；连续 529 且有备用模型才切换，没有则明确继续重试；`max_tokens` 升级一次、最多续接 3 次，用尽即失败；lead、队友和子代理都走同一套上限，模型切换只在 lead 生效 |

---

## 代码结构

`s20_comprehensive/agent.ts` 只保留启动入口和收尾；其余按职责拆成小模块：

| 模块 | 职责 |
|------|------|
| `config.ts` / `util.ts` / `blocks.ts` | 常量、环境变量、路径、小工具、消息块构造 |
| `effects.ts` | 41 个 Effect 类型与 `S20Effect` union |
| `handlers.ts` | `s20Handlers`：把每个 Effect 路由到具体实现 |
| `lead-loop.ts` | lead 主循环：注入、压缩、提示词/工具池、错误恢复、工具派发 |
| `team.ts` | 队友/子代理循环、活跃队友注册表、宿主停止信号 |
| `mailbox.ts` / `protocol.ts` / `protocol-runtime.ts` | JSONL 信箱、协议状态机、request_id 生成与响应轮询 |
| `tasks.ts` / `worktree.ts` / `git.ts` | 任务图、worktree 管理、真实 git 调用 |
| `context.ts` / `knowledge.ts` / `background.ts` / `cron.ts` / `mcp.ts` / `recovery.ts` | 各章机制的适配层（共享算法在 `runtime/`，见下一行） |
| `runtime/cron.ts` / `runtime/compaction.ts` / `runtime/recovery.ts` / `runtime/background.ts` | 与 s14 / s08 / s11 / s13 共用的领域实现，避免同一机制各章各写一份 |
| `tools.ts` / `mock.ts` | 三套工具池、确定性 mock 剧本 |

这样 `agent.ts` 只负责“把模块接起来并跑一次”。拆分后最大的 `handlers.ts` 约 750 行，其余模块更小，不再有 2000+ 行的单文件。

---

## 41 个 Effect

| 维度 | Effect | 来源章节 |
|------|--------|----------|
| **Infra** | `Chat`, `AssemblePrompt`, `AssembleToolPool`, `PrepareContext`, `PersistOutput` | s01/s10/s08 |
| **Tools** | `BashExec`, `ReadFile`, `WriteFile`, `EditFile`, `GlobSearch` | s01/s02 |
| **Session** | `TodoWrite`, `SpawnSubagent`, `LoadSkill`, `ReadMemory`, `WriteMemory` | s05/s06/s07/s09 |
| **Tasks** | `CreateTask`, `ListTasks`, `GetTask`, `ClaimTask`, `CompleteTask`, `IdlePoll` | s12/s17 |
| **Background** | `StartBackground`, `CollectBackgroundResults` | s13 |
| **Cron** | `ScheduleCron`, `ListCrons`, `CancelCron` | s14 |
| **Team** | `SpawnTeammate`, `SendMessage`, `CheckInbox`, `SubmitPlan`, `WaitForPlanResponse`, `RequestPlan`, `ReviewPlan`, `RequestShutdown` | s15/s16/s17 |
| **Worktree** | `CreateWorktree`, `RemoveWorktree`, `KeepWorktree` | s18 |
| **MCP** | `MCPConnect`, `MCPToolCall` | s19 |
| **Recovery** | `RetryWithBackoff`, `SwitchModel` | s11 |

---

## 工具集

工具 schema 复用共享的 `runtime/tool-schemas.ts`（`schemasFor(...)`），并按角色装配。本章与共享 schema 不一致的字段在 `tools.ts` 本地覆盖：`glob` 只支持单层、`write_file` 增加 `worktreeId`、`create_task` 增加 `preferredOwner`、teammate/subagent 的 `bash` 不接受 `run_in_background`：

- **Lead（31 个工具）**：`bash, read_file, write_file, edit_file, glob, todo_write, task, load_skill, compact, read_memory, write_memory, create_task, list_tasks, get_task, claim_task, complete_task, schedule_cron, list_crons, cancel_cron, spawn_teammate, send_message, check_inbox, request_shutdown, request_plan, review_plan, create_worktree, remove_worktree, keep_worktree` + 装配后的 MCP 工具（`mcp__docs__search`, `mcp__docs__fetch`, `mcp__deploy__status`）。
- **Teammate（8 个）**：`bash, read_file, write_file, send_message, list_tasks, claim_task, complete_task, submit_plan`。
- **Subagent（5 个）**：`bash, read_file, write_file, edit_file, glob`。

---

## 确定性 mock 驱动的流程

`mockModel` 只替换模型调用（`callChat` 的第一个参数），其余全走真实 handler。脚本状态由模块级 `memo` 驱动（轮次计数器只在成功返回后自增，因此重试不推进脚本）；任务 id / 计划 request_id 由 handler 真实写回 `memo`（`CreateTask` 写 `taskIdBySubject`，`SubmitPlan` 写 `planRequestId`），mock 据此引用**真实** id，从而真实演示 blockedBy 依赖图与审批关口。任务 id 用“时间戳 + 自增序号”，保证 `listTasksOrdered` 的顺序稳定，自主认领才能确定地选中演示任务。

Lead 侧 **18 轮**端到端脚本（MCP 连接由宿主在循环开始前完成，不计入轮次）：

1. **R0 初始化**：`read_memory` / `load_skill` / `todo_write`
2. **R1 规划**：`spawn_teammate`（启动独立的队友循环）+ `request_plan`
3. **R2 任务根节点**：`create_task` D（编写迁移说明，`preferredOwner=worker`）、A（设计接口，`preferredOwner=lead`）、B（实现核心，`preferredOwner=lead`）
4. **R3 依赖 + 收计划**：`create_task` C（blockedBy A,B，用真实 id，`preferredOwner=lead`）+ `check_inbox`（等 `plan_approval_request`）
5. **R4 MCP + 审批**：`mcp__docs__search`、`get_task(c)`、`claim_task(c)`（**应失败：blocked**）、`review_plan`（批准 → 回发响应 → 请求落定 → 队友的关口允许执行）
6. **R5**：`claim_task` A、B + `bash`（后台监控，真实的后台任务）
7. **R6 完成 + 产出**：`complete_task` A、B（**回报 unblocked C**）、`write_file`、`glob`（本轮触发 **429** → 等待后重试）
8. **R7**：`edit_file`、`read_file`、`task`（派出子代理，嵌套 `runAgent`）
9. **R8**：250KB 大输出 `bash` → 下一轮 **PersistOutput** 写入磁盘，工具结果只留 `<persisted-output>` 引用
10. **R9**：`create_worktree`（绑定任务 C；本轮连发 **529×2** → **SwitchModel** 切到备用模型）
11. **R10**：在 worktree 内 `bash` 写入（制造未提交变更）
12. **R11**：`remove_worktree`（**应被拒绝**）+ `keep_worktree`
13. **R12**：`claim_task(c)`（依赖已解除，成功）+ `complete_task(c)` + `list_tasks`
14. **R13**：`schedule_cron` ×2（含需长期保留的任务）+ `cancel_cron`（真实定时触发、命中后送入队列）
15. **R14**：`list_crons` + `compact`（真实压缩流水线；compact 会丢弃同轮其余工具结果）
16. **R15**：`remove_worktree(discard_changes)` + `list_tasks`
17. **R16**：`request_shutdown`（等待队友 `shutdown_response`）
18. **R17**：队友结果已在轮首自动注入；mock 仍调一次 `check_inbox` 收尾 → 下一轮默认 `end_turn`（日志里是 R18）

队友侧脚本（t0–t4）：`submit_plan`（关闭关口）→ 等审批 → `list_tasks` → `end_turn` 进入空闲 → `IdlePoll` 按 `preferredOwner` 自主认领 D 并把认领结果注入 → `write_file` + `complete_task(D)` → 空闲等待 shutdown。子代理脚本：`bash` 扫描 → `end_turn`。

收尾：`stopTeammates` → `settleActiveWithin` → `stopCronScheduler` → `worktrees.cleanup()` → `flushBackground`，随后打印协议请求汇总（`plan_approval` 与 `shutdown` 均 `approved`）。全部成功时最后一行输出 **`[S20] 完成`**；任何失败路径输出 **`[S20] 失败`** 并以退出码 1 结束。

---

## 代数效应视角

```
                   Generator（业务逻辑，纯函数）
                   ↓        ↓        ↓
   ReadMemory   MCPConnect  CreateTask  SpawnTeammate  ...
        ↓            ↓           ↓            ↓
                   runAgent（效应路由器）
        ↓        ↓        ↓        ↓        ↓
   Memory      MCP      Task     Team    Worktree
   Handler   Handler  Handler  Handler  Handler
```

**每个 Handler 只关心自己的副作用，Generator 只做业务决策。** `runAgent` 统一路由 41 种 Effect，队友 / 子代理各自是嵌套的 `runAgent` 子循环——同一套 handler 表被复用，因此并发角色无需任何额外基础设施。

图中 `MCPConnect` 是宿主在 `leadLoop` 的 `while` 之前 yield 的一次性阶段（连接用户配置的服务器），不是模型可见的工具；模型只在后续轮次里发出 `mcp__...` 调用（触发 `MCPToolCall`）。

---

## 运行

```bash
npm run s20
```

默认 `AGENT_MODE=mock`，离线、结果稳定、约 2 秒结束，成功后末行输出 `[S20] 完成`。可用 `AGENT_WORKSPACE=/tmp/xxx` 指定工作区，重复运行验证持久化与恢复。real 模式（配置 `ANTHROPIC_AUTH_TOKEN`/`MODEL_ID`，可选 `ANTHROPIC_BASE_URL`）会走真实模型调用；需要 529 切换模型时再配置 `FALLBACK_MODEL_ID`，未配置时只打印“未配置，继续重试”。

本章的信箱落在 `.mailboxes/s20/`，启动时只清空这个子目录。real 模式下队友空闲等待默认 10 分钟、审批闸门与协议响应默认 5 分钟，可用 `S20_IDLE_TIMEOUT_MS` / `S20_GATE_TIMEOUT_MS` / `S20_RESPONSE_TIMEOUT_MS` 覆盖；cron 调度 tick 在 real 模式为 1 秒、mock 为 20ms；lead 结束后宿主的 `stopTeammates` 会标记宿主收尾，并让仍在等待的队友立即返回，最多再等 `S20_CLEANUP_WAIT_MS`（mock 1 秒 / real 3 秒）。如果队友正在一次模型请求里，进程可能还要等它完成；退出前仍有队友运行会按失败处理。

lead 每轮开始时自动消费自己的信箱：队友的 `result`/`message` 会作为 `<inbox>` 注入上下文，`plan_approval_request` 留在信箱里供 `check_inbox(expectType)` 使用。`check_inbox` 在 lead 侧默认先等活跃队友最多 300ms，可用 `waitMs` 覆盖；带 `expectType` 时会等到该类型消息到达（real 默认上限 5 分钟，mock 8 秒）。

real 模式的计划审批流程：`request_plan` 只投递请求；模型用 `check_inbox(expectType="plan_approval_request")` 等到计划请求，从返回消息的 `metadata.request_id` 取 requestId，再调用 `review_plan`。计划被拒绝或审批超时后，队友的工作类工具会被拒绝，必须重新提交计划。

18 轮脚本是 mock 的确定性演示；real 模式由模型自行决定步骤。本章的初始工作区没有预置业务代码，真实模型可能先探索或搭建文件，流程不一定与 mock 完全一致。失败路径（重试耗尽、max_tokens 用尽、队友异常、清理失败）会输出 `[S20] 失败` 并以退出码 1 结束。

工作区布局（`runtime/workspace.ts` 统一）：

```
<workspace>/
  .tasks/            # 任务 JSON（blockedBy 依赖图、owner 与 preferredOwner 持久化）
  .memory/           # 记忆文件
  .mailboxes/s20/    # 本章每个 agent 的 JSONL 信箱
  .worktrees/        # git worktree + events.jsonl
  .transcripts/      # 压缩前的对话转写
  .task_outputs/tool-results/  # 超大工具输出写入磁盘（PersistOutput）
  .task_outputs/bg_*.log       # 后台任务完整输出（task-notification 的 output-file）
  .scheduled_tasks.json        # durable cron 任务
```

---

## 项目小结

**代数效应 = 将副作用从声明中分离。Effect 是意图，Handler 是实现，runAgent 是路由。** 这三者的分离，让 Agent 的记忆、任务、工具、错误恢复、并发、协议可以独立演化、独立测试，又能在同一循环里自由组合。

从 s01 的 2 个 Effect 到 s20 的 41 个，每一章新增的 Effect 都是对新能力的精确建模：**用类型系统表达 Agent 的全部能力边界**——并且在本章第一次被真正接成一个能跑的整体。

---

<details>
<summary>CC 源码全景：Harness 的真实实现</summary>

### s01-s04：基础工具层

CC 的 `BashExec` 实现了完整的 PTY（伪终端）支持，能处理交互式程序（vim、python REPL）。`RequestPermission` 有 5 级权限模型（`auto`/`confirm`/`reject`/`allow_all`/`deny_all`），由用户在配置中设定。`FireHook` 对应 Claude Code 的用户可配置钩子（pre/post tool use 的 shell 命令）。

### s07：Skill Loading 的双层架构

CC 的 Skill 系统（`/figma-use`、`/remember` 等）分两层：
- Layer 1：`ListSkills` 返回名称+一行描述（注入 system prompt）
- Layer 2：`LoadSkill` 返回完整 Markdown 内容（工具调用时注入）

这正是教学版 s07 实现的双层架构，1:1 对应。

### s09：Memory 与 MEMORY.md 索引

CC 的 Memory 系统有一个 `MEMORY.md` 索引文件，每条 memory 对应 `/memory/` 目录下的一个文件。读取时先查索引选出相关条目，再按需加载全文。

### s13：7 种后台任务类型

见 s13 深入 CC 源码折叠块。

### s19：MCP 的 6 种 Transport 类型

见 s19 深入 CC 源码折叠块。

### 循环结构图

```
[宿主启动] 连接用户配置的 MCP 服务器（MCPConnect × N）——循环之前，模型不可见
  ↓
用户消息
  ↓
[自动注入] 队友消息 + cron 通知 + 后台通知（memory/MCP 分别进 system prompt 与工具池）
  ↓
PrepareContext（压缩流水线）→ AssemblePrompt → AssembleToolPool（MCP 工具在此并入）
  ↓
Chat(messages, tools, systemPrompt, model, maxTokens)
  ↓
LLM 响应 → stop_reason?
  ├── end_turn → 输出结果，结束
  ├── max_tokens → 升级上限 / 续接
  └── tool_use → 并行执行工具调用
                  ├── 本地工具（bash/read/write...）
                  ├── 团队工具（spawn/send/check_inbox/review_plan...）
                  └── MCP 工具（mcp__{server}__{tool}）
                  ↓
              工具结果追加 messages（大输出写入磁盘）
                  ↓
              [触发] RetryWithBackoff / SwitchModel
                  ↓
              回到 Chat（下一轮）
```

这个循环是所有 20 章的骨架，每章只是向 Harness 的某个维度增加新能力；s20 把所有维度接进同一条循环。

其中 `systemPrompt` 由 `AssemblePrompt` 按运行时上下文组装（能力说明、队友/MCP 状态、记忆）；本章没有本地缓存。

</details>
