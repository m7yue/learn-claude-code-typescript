# s20: Comprehensive — 代数效应系统的完整演示

[s19](../s19_mcp_plugin/) → **[s20]**

---

## 第一性原理

**问题的本质**：前19章每章展示一个机制。真实 Agent 需要同时使用所有这些机制——在一个连贯的工作流中，无缝切换记忆、任务、工具、协议、后台任务和错误恢复。

27 个 Effect 类型能否组合成一个优雅的整体？答案是肯定的，因为代数效应的核心属性：每个 Effect 是独立的声明，Generator 可以任意顺序 yield 任意 Effect，`runAgent()` 统一路由所有类型。

---

## 完整工作流

### Phase 1: 初始化

```typescript
// 读取历史记忆（有没有上次的经验？）
const memory = yield* perform({ type: 'ReadMemory', input: { query: '项目历史' } });

// 连接外部工具（GitHub MCP）
const server = yield* perform({ type: 'MCPConnect', input: { serverId: 'github-mcp' } });
```

### Phase 2: 规划

```typescript
// 请求执行计划（规划 Agent 生成步骤）
const plan = yield* perform({ type: 'RequestPlan', input: { goal: '重构认证模块' } });

// 启动后台监控（不阻塞主流程）
yield* perform({ type: 'SpawnBackground', input: { taskId: 'monitor', description: '监控构建' } });
```

### Phase 3: 执行

```typescript
// 创建任务（持久化到文件）
const task = yield* perform({ type: 'CreateTask', input: { subject: '重构认证', description: '...' } });

// 执行命令
yield* perform({ type: 'BashExec', input: { command: 'echo "执行中..."' } });
```

### Phase 4: 收尾

```typescript
// 收集后台通知（构建成功了吗？）
const notes = yield* perform({ type: 'CollectNotifications', input: {} });

// 保存经验到记忆（下次用得上）
yield* perform({ type: 'WriteMemory', input: { key: 'auth_refactor_complete', content: '成功...' } });
```

---

## 代数效应视角：为什么这一切能组合？

```
                   Generator（业务逻辑，纯函数）
                   ↓        ↓        ↓
ReadMemory    MCPConnect  RequestPlan  SpawnBackground
    ↓              ↓          ↓            ↓
                   runAgent（效应路由器）
                   ↓        ↓        ↓        ↓
             Memory     MCP      Planning  Background
             Handler   Handler   Handler    Handler
```

**每个 Handler 只关心自己的副作用**，Generator 只做业务决策。这是代数效应让复杂系统保持可理解性的原因。

---

## 全部 27 个 Effect 类型（按 Harness 维度分类）

| Harness 维度 | Effect | 章节 |
|------------|--------|------|
| **Tools**（能调用什么） | `Chat`, `BashExec` | s01 |
| | `ReadFile`, `WriteFile`, `EditFile`, `GlobSearch` | s02 |
| **Permissions**（能做什么需要授权） | `RequestPermission` | s03 |
| | `FireHook` | s04 |
| | `TodoWrite`, `TodoRead` | s05 |
| **Action**（能发起什么复杂动作） | `Delegate` | s06 |
| **Knowledge**（模型知道什么） | `LoadSkill`, `ListSkills` | s07 |
| **Observation**（模型看到多少上下文） | `Compact`, `PersistOutput` | s08 |
| **Knowledge** | `ReadMemory`, `WriteMemory`, `SelectMemory` | s09 |
| | `AssemblePrompt` | s10 |
| **Tools** | `RetryWithBackoff`, `SwitchModel` | s11 |
| **Action** | `CreateTask`, `ClaimTask`, `CompleteTask`, `ListTasks` | s12 |
| | `SpawnBackground`, `CollectNotifications`, `WaitBackground` | s13 |
| | `ScheduleCron`, `CancelCron`, `ProcessCronQueue` | s14 |
| | `SpawnTeammate`, `SendMessage`, `CheckInbox` | s15 |
| | `RequestPlan`, `ReviewPlan`, `RequestShutdown` | s16 |
| | `IdlePoll`, `ScanUnclaimed`, `AutoClaim` | s17 |
| | `CreateWorktree`, `RemoveWorktree`, `BindWorktree` | s18 |
| | `MCPConnect`, `MCPToolCall`, `AssembleToolPool` | s19 |

---

## 相对 s19 的变更

| 组件 | 之前 (s19) | 之后 (s20) |
|------|-----------|-----------|
| Effect 数量 | 本章 3 个（MCPConnect/MCPToolCall/AssembleToolPool） | 综合使用全部 27 个 |
| 工作流粒度 | 单机制演示 | 4 阶段端到端工作流 |
| Agent 数量 | 1 个 | 主 Agent + 多角色协作 |
| 测试覆盖 | 单 Effect 验证 | 全量 Effect 联调 |

---

## 运行

```bash
npm run s20
```

---

## 项目小结

**代数效应 = 将副作用从声明中分离。Effect 是意图，Handler 是实现，runAgent 是路由。这三者的分离让 Agent 的复杂行为——记忆、任务、工具、错误恢复、并发、协议——都可以独立演化、独立测试、自由组合。**

从 s01 的 2 个 Effect 到 s20 的 27 个 Effect，每一章新增的 Effect 类型都是对新能力的精确建模：**用类型系统表达 Agent 的全部能力边界**。

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

CC 的 Memory 系统有一个 `MEMORY.md` 索引文件，每条 memory 对应 `/memory/` 目录下的一个文件。读取时先查索引选出相关条目，再按需加载全文。教学版简化为 `Map<key, content>` 内存存储。

### s13：7 种后台任务类型

见 s13 深入 CC 源码折叠块。

### s19：MCP 的 6 种 Transport 类型

见 s19 深入 CC 源码折叠块。

### 循环结构图

```
用户消息
  ↓
[自动注入] memory + cron 通知 + MCP 推送
  ↓
Chat(messages, tools, systemPrompt)
  ↓
LLM 响应 → stop_reason?
  ├── end_turn → 输出结果，结束
  └── tool_use → 并行执行工具调用
                  ├── 本地工具（bash/read/write...）
                  └── MCP 工具（mcp__{server}__{tool}）
                  ↓
              工具结果追加 messages
                  ↓
              [触发] RequestPermission / FireHook
                  ↓
              回到 Chat（下一轮）
```

这个循环是所有 20 章的骨架，每章只是向 Harness 的某个维度增加新能力。

</details>
