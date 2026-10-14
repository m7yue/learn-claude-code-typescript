# s20: Comprehensive — 一个真实整合的 Agent Harness

[s19](../s19_mcp_plugin/) → **[s20]**

---

## 第一性原理

**问题的本质**：前 19 章各展示一个机制。真实 Agent 需要在一个连贯的工作流里同时驱动它们——任务图、队友协议、后台执行、cron、worktree 隔离、MCP 工具池、错误恢复、上下文压缩。

本章把这些机制**真正组合**进一个可运行的 Harness：`s20_comprehensive/agent.ts` 声明 **41 个 Effect**，全部由 `s20Handlers` 提供真实实现（`EffectHandlers<S20Effect>` 的类型映射强制“每个 Effect 都必须有 handler”，避免出现声明了却接不上的无用代码）。**唯一被 mock 替换的是“模型调用”这一步**——并发任务、定时器、锁、持久化、git、协议全部是真实副作用。

---

## 目录

- [真实机制清单](#真实机制清单)
- [41 个 Effect](#41-个-effect)
- [工具集](#工具集)
- [确定性 mock 驱动的流程](#确定性-mock-驱动的流程)
- [代数效应视角](#代数效应视角)
- [运行](#运行)
- [已知的共享 schema 缺口](#已知的共享-schema-缺口)
- [项目小结](#项目小结)

---

## 真实机制清单

| 机制 | 章节 | 本实现（不是写死的占位） |
|------|------|----------------------|
| 任务系统 + blockedBy 依赖图 | s12 / s17 | 每个任务一个 JSON 文件持久化到 `.tasks/`；`blockingDeps`/`canStart` 真实判定依赖；`complete` 会计算并回报新解除阻塞的任务 |
| 后台执行 | s13 | `startBackground()` 启动独立的后台异步任务，登记到注册表；`collectBackgroundResults()` 在后续轮次收取 `task_notification`；收尾 `flushBackground()` 等待/清理 |
| cron 调度器 | s14 | `setInterval`（`.unref()`）真实定时触发；`.scheduled_tasks.json` 持久化需要长期保留的任务，启动时 `loadDurableJobs()` 恢复；按分钟标记去重；被命中后进入队列，由主循环送入 |
| 队友循环 + 信箱 | s15 | 每个队友是一条独立 `runAgent` 子循环（真实并发 Promise）；`MessageBus` 以 `.mailboxes/*.jsonl` 写入磁盘 + `Mutex` 加锁、同一时刻只允许一个写入 + `waitForMailbox` 唤醒 |
| request_id 协议状态机 | s16 | `pendingRequests` 登记中的请求；`matchResponse` 按 `request_id` + 期望类型**双校验**，未知 / 错类型 / 重复一律拒绝；`pollForResponse` / `waitForMailbox` 同步 |
| 计划审批关口（真关口） | s16 | 队友 `SubmitPlan` 把计划登记为待处理，并发 `plan_approval_request`，随后 `WaitForPlanResponse` **阻塞**直到 lead 用 `ReviewPlan` 发回匹配的 `plan_approval_response`（并清除该待处理记录） |
| 自主 WORK/IDLE/SHUTDOWN | s17 | 队友空闲时 `IdlePoll` 阻塞等待；可 `autoClaim` 主动认领可以开始的待处理任务；收到 `shutdown_request` 立即回 `shutdown_response` 退出 |
| git worktree 隔离 | s18 | `spawnSync('git', ...)` 真实 `git worktree add/remove`；有未提交变更时拒绝删除，除非 `discard_changes`；`ensureGitRepo()` 在非 git 工作区自动 `git init` |
| MCP 工具池 | s19 | 进程内教学 MCP server（`docs`=search/fetch、`deploy`=status）；`AssembleToolPool` 把 `mcp__{server}__{tool}` 装配进工具池；`MCPToolCall` 路由调用 |
| 上下文压缩流水线 | s08 | `toolResultBudget → snipCompact → microCompact → LLM 摘要(compactHistory)`；`prompt_too_long` 触发被动压缩；超大输出走 `PersistOutput` 写入磁盘 |
| 系统提示装配 | s10 | `AssemblePrompt` 按上下文分段拼装（identity/tools/workspace/memory/compaction/time），相同上下文命中缓存 |
| 错误恢复 | s11 | `classifyError`（按 name/message/status 字符串分类）；429 等待后重试、连续 529 切换到备用模型、`max_tokens` 升级上限后继续 |

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

工具 schema 复用共享的 `runtime/tool-schemas.ts`（`schemasFor(...)`），并按角色装配：

- **Lead（32 个工具）**：`bash, read_file, write_file, edit_file, glob, todo_write, task, load_skill, compact, read_memory, write_memory, create_task, list_tasks, get_task, claim_task, complete_task, schedule_cron, list_crons, cancel_cron, spawn_teammate, send_message, check_inbox, request_shutdown, request_plan, review_plan, create_worktree, remove_worktree, keep_worktree, mcp_connect` + 装配后的 MCP 工具（`mcp__docs__search`, `mcp__docs__fetch`, `mcp__deploy__status`）。
- **Teammate（8 个）**：`bash, read_file, write_file, send_message, list_tasks, claim_task, complete_task, submit_plan`。
- **Subagent（5 个）**：`bash, read_file, write_file, edit_file, glob`。

---

## 确定性 mock 驱动的流程

`mockModel` 只替换模型调用（`callChat` 的第一个参数），其余全走真实 handler。脚本状态由模块级 `memo` 驱动（轮次计数器只在成功返回后自增，因此重试不推进脚本）；任务 id / 计划 request_id 由 handler 真实写回 `memo`（`CreateTask` 写 `taskIdBySubject`，`SubmitPlan` 写 `planRequestId`），mock 据此引用**真实** id，从而真实演示 blockedBy 依赖图与审批关口。

Lead 侧 **18 轮**端到端脚本：

1. **R0 初始化**：`read_memory` / `load_skill` / `todo_write` / `mcp_connect×2`
2. **R1 规划**：`spawn_teammate`（启动独立的队友循环）+ `request_plan`
3. **R2 任务根节点**：`create_task` A（设计接口）、B（实现核心）、D（编写迁移说明）
4. **R3 依赖 + 收计划**：`create_task` C（blockedBy A,B，用真实 id）+ `check_inbox`（等 `plan_approval_request`）
5. **R4 MCP + 审批**：`mcp__docs__search`、`get_task(c)`、`claim_task(c)`（**应失败：blocked**）、`review_plan`（批准 → 待处理记录清除 → 队友的关口允许执行）
6. **R5**：`claim_task` A、B + `bash`（后台监控，真实的后台任务）
7. **R6 完成 + 产出**：`complete_task` A、B（**回报 unblocked C**）、`write_file`、`glob`（本轮触发 **429** → 等待后重试）
8. **R7**：`edit_file`、`read_file`、`task`（派出子代理，嵌套 `runAgent`）
9. **R8**：大输出 `bash` → **PersistOutput** 写入磁盘
10. **R9**：`create_worktree`（本轮连发 **529×2** → **SwitchModel** 切到备用模型）
11. **R10**：在 worktree 内 `bash` 写入（制造未提交变更）
12. **R11**：`remove_worktree`（**应被拒绝**）+ `keep_worktree`
13. **R12**：`claim_task(c)`（依赖已解除，成功）+ `complete_task(c)` + `list_tasks`
14. **R13**：`schedule_cron` ×2（含需长期保留的任务）+ `cancel_cron`（真实定时触发、命中后送入队列）
15. **R14**：`list_crons` + `compact`（真实压缩流水线）
16. **R15**：`remove_worktree(discard_changes)` + `list_tasks`
17. **R16**：`request_shutdown`（等待队友 `shutdown_response`）
18. **R17**：`check_inbox` 收尾 → 默认轮 `end_turn`

队友侧脚本（t0–t4）：`submit_plan`（关闭关口）→ 等审批 → `list_tasks` → `claim_task(D)` + `write_file` → `complete_task(D)` → 空闲等待 shutdown。子代理脚本：`bash` 扫描 → `end_turn`。

收尾：`awaitTeammates` → `stopCronScheduler` → `cleanupAllWorktrees` → `flushBackground`，随后打印协议请求汇总（`plan_approval` 与 `shutdown` 均 `approved`）、协议状态机负向自检（未知 request_id / 错类型 / 重复响应均被拒绝），最后一行固定输出 **`[S20] 完成`**。

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

---

## 运行

```bash
npm run s20
```

默认 `AGENT_MODE=mock`，离线、结果稳定、约 2 秒结束，末行输出 `[S20] 完成`。可用 `AGENT_WORKSPACE=/tmp/xxx` 指定工作区，重复运行验证持久化与恢复。real 模式（配置 `ANTHROPIC_AUTH_TOKEN`/`MODEL_ID`）会走真实 Anthropic 调用。

工作区布局（`runtime/workspace.ts` 统一）：

```
<workspace>/
  .tasks/            # 任务 JSON（blockedBy 依赖图与 owner 持久化）
  .memory/           # 记忆文件
  .mailboxes/        # 每个 agent 的 JSONL 信箱
  .worktrees/        # git worktree + events.jsonl
  .transcripts/      # 压缩前的对话转写
  .task_outputs/tool-results/  # 超大工具输出写入磁盘（PersistOutput）
  .scheduled_tasks.json        # durable cron 任务
```

---

## 已知的共享 schema 缺口

为保证 `tests/chapter-specs.test.ts`（扫描 `schemasFor(...)` 字面量并要求命中 `TOOL_SPECS`）通过，本章把两个**共享层缺失**的工具 schema 以本地 `ToolSchema` 内联定义（不经 `schemasFor`）：

- `keep_worktree`（s18 的“保留 worktree”动作）
- `submit_plan`（s16 的“提交计划并关闭关口”动作）

建议后续在 `runtime/tool-schemas.ts` 中补齐这两个工具定义，本章即可改用 `schemasFor`。**共享文件未做改动**（按要求只报不改）。

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
用户消息
  ↓
[自动注入] memory + cron 通知 + 后台通知 + MCP 推送
  ↓
PrepareContext（压缩流水线）→ AssemblePrompt → AssembleToolPool
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

其中 `systemPrompt` 由 `AssemblePrompt` 在运行时分段组装（identity（含工作目录与运行环境）/tools/workspace/memory/compaction/time），相同上下文命中缓存。

</details>
