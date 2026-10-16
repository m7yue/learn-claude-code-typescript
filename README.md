# learn-claude-code-typescript

中文 ｜ [English]

[English]: ./README.en.md
[中文]: ./README.md

面向前端工程师的 Agent harness 学习项目：把 [Learn Claude Code](https://github.com/shareai-lab/learn-claude-code) 的 20 个递进课程，改写成 TypeScript + Algebraic Effects 版本。

这个仓库不是 Claude Code 的产品复刻，也不是一个完整 Coding Agent 框架。它更像一套可运行的学习笔记：用 TypeScript 代码把 Agent loop、工具调用、权限、hooks、todo、subagent、skill、compact、memory、task、team、MCP 等机制逐章拆开，再用代数效应视角解释它们共同的工程结构。

如果你还不了解代数效应，可以先把它理解成一句话：

```txt
Agent 逻辑只声明“我要做什么”，运行时 handler 再决定“怎么做”。
```

更完整的入门解释见 [docs/zh/algebraic-effects-primer.md](docs/zh/algebraic-effects-primer.md)。

## 为什么做这个项目

我做这个项目的动机很简单：很多前端工程师已经开始使用 Claude Code、Cursor、Codex 一类工具，但真正理解它们背后的 harness 工程并不容易。

原版 Learn Claude Code 用 Python 展示了这些机制。我希望把它翻译成前端工程师更熟悉的 TypeScript，同时进一步用第一性原理和代数效应重述：

```txt
Agent = 模型的 agency + harness
Harness = loop + tools + permissions + context + memory + state + protocols
```

模型负责产生意图，harness 负责解释意图、执行副作用、注入观察结果、维护边界和状态。工程师真正能设计的部分，主要就是 harness。

## AI 协作说明

这个项目是我和 AI 协作完成的学习型工程。

我负责提出问题、设定方向、判断抽象是否成立、校验课程结构和表达方式；AI 负责大量代码转换、章节草稿、重构建议和文档生成。这个过程本身也是项目想传达的一部分：我们不只是“使用 AI 写代码”，还可以用 AI 帮自己理解 AI coding agent 背后的工程原理。

所以这个仓库既是一份 TypeScript 教程，也是一份 AI 协作学习的样本。

## 核心视角：代数效应

原版 Python 课程里的核心循环大致是：

```python
while True:
    response = client.messages.create(...)
    if response.stop_reason != "tool_use":
        return
    for block in response.content:
        output = TOOL_HANDLERS[block.name](**block.input)
        results.append(output)
    messages.append(results)
```

用代数效应看，这个循环可以拆成三个部分：

| 机制 | 代数效应表达 | 含义 |
| --- | --- | --- |
| Tool use | `yield* perform(effect)` | Agent 声明“我要做什么” |
| Tool handler | `handlers[effect.type]` | 运行时决定“怎么做” |
| Agent loop | `runAgent()` | 把副作用结果送回 Agent |

在本项目里，Agent 逻辑通常写成 Generator：

```ts
function* agentLoop(perform: PerformFn<MyEffect>) {
  const output = yield* perform({
    type: "BashExec",
    input: { command: "ls" },
  });

  return output;
}
```

这段代码不直接执行 shell。它只是声明一个意图。真正执行、拦截、审批、mock、记录日志或替换成隔离环境，都由 handler 决定。

## 学习路径

更推荐的方式是结合 [Learn Claude Code](https://learn.shareai.run/zh/) 对照学习：先读原站对应章节理解动机，再回到本仓库看 TypeScript + Algebraic Effects 版本。

官方站点现在是 **20 章、5 大关注点**，与本仓库 `s01`–`s20` **基本 1:1 对应**（章节号、顺序一致），可以直接按章号对照，具体见 [docs/zh/learn-shareai-crosswalk.md](docs/zh/learn-shareai-crosswalk.md)。

主线课程仍然是 `s01_agent_loop/` 到 `s20_comprehensive/`。每章包含：

- `README.md`：第一性原理、代数效应视角、代码讲解
- `agent.ts`：本章 Effect、Handler、Agent Generator 和启动入口

建议按这个顺序读：

```txt
README.md
-> docs/zh/algebraic-effects-primer.md
-> docs/zh/learn-shareai-crosswalk.md
-> s01_agent_loop/README.md
-> s01_agent_loop/agent.ts
-> s02 ... s20
-> src/core 和 src/modules
```

### Tools & Execution（工具与执行）

| 章节 | 主题 | 新增机制 |
| --- | --- | --- |
| [s01](s01_agent_loop/) | Agent Loop | `Chat`, `BashExec` |
| [s02](s02_tool_use/) | Tool Use | `ReadFile`, `WriteFile`, `EditFile`, `GlobSearch` |
| [s03](s03_permission/) | Permission | `RequestPermission` |
| [s04](s04_hooks/) | Hooks | `FireHook` |

### Planning & Control（规划与控制）

| 章节 | 主题 | 新增机制 |
| --- | --- | --- |
| [s05](s05_todo_write/) | TodoWrite | `TodoWrite`, `TodoRead` |
| [s06](s06_subagent/) | Subagent | `Delegate` |
| [s07](s07_skill_loading/) | Skill Loading | `LoadSkill`, `ListSkills` |
| [s10](s10_system_prompt/) | System Prompt | `AssemblePrompt` |
| [s11](s11_error_recovery/) | Error Recovery | `RetryWithBackoff` |

### Memory（记忆管理）

| 章节 | 主题 | 新增机制 |
| --- | --- | --- |
| [s08](s08_context_compact/) | Context Compact | `Compact`, `PersistOutput` |
| [s09](s09_memory/) | Memory | `ReadMemory`, `WriteMemory`, `SelectMemory` |

### Concurrency & Scheduling（并发与调度）

| 章节 | 主题 | 新增机制 |
| --- | --- | --- |
| [s13](s13_background_tasks/) | Background Tasks | `StartBackground`, `CollectBackgroundResults` |
| [s14](s14_cron_scheduler/) | Cron Scheduler | `ScheduleCron`, `ListCrons`, `CancelCron` |

### Multi-Agent Platform（多 Agent 平台）

| 章节 | 主题 | 新增机制 |
| --- | --- | --- |
| [s12](s12_task_system/) | Task System | `CreateTask`, `ClaimTask`, `CompleteTask` |
| [s15](s15_agent_teams/) | Agent Teams | `SpawnTeammate`, `SendMessage`, `CheckInbox` |
| [s16](s16_team_protocols/) | Team Protocols | `RequestPlan`, `ReviewPlan` |
| [s17](s17_autonomous_agents/) | Autonomous Agents | `IdlePoll`, `ScanUnclaimed` |
| [s18](s18_worktree_isolation/) | Worktree Isolation | `CreateWorktree`, `BindWorktree`, `KeepWorktree`, `RemoveWorktree` |
| [s19](s19_mcp_plugin/) | MCP Tools | `MCPConnect`、`AssembleToolPool`（宿主循环前）, `MCPToolCall`（模型触发） |
| [s20](s20_comprehensive/) | Comprehensive Agent | 综合前 19 章机制 |

## 项目结构

```txt
learn-claude-code-typescript/
├── runtime/
│   ├── core.ts              # 逐章教学使用的最小代数效应运行时
│   ├── types.ts             # 课程共享类型
│   ├── env.ts               # 运行模式解析（mock/real）+ .env 加载
│   ├── model.ts             # Anthropic 兼容客户端 + callChat 开关（支持 model/maxTokens 覆盖）
│   ├── errors.ts            # 错误分类（按 name/message 字符串匹配）
│   ├── workspace.ts         # 工作区持久化路径（.tasks/.memory/... 的统一定义）
│   ├── locks.ts             # 异步互斥锁（同一时刻只允许一个操作）
│   └── tool-schemas.ts      # 各章工具的 JSON Schema（仅 real 模式使用）
├── s01_agent_loop/ ... s20_comprehensive/
│   ├── README.md            # 每章讲解
│   └── agent.ts             # 每章可运行代码
├── src/
│   ├── core/                # 更工程化的 Agent loop / Effect / ScriptedModel / AnthropicModel
│   ├── modules/             # 可复用 harness 模块参考实现
│   └── harness.ts           # 工程层可运行入口（真实工具 + 可选真实模型）
├── docs/                    # 学习地图、第一性原理、学习工作流
├── tests/                   # 共享模块行为测试 + 20 章端到端回归
└── .env.example             # real 模式配置模板（默认 DeepSeek）
```

这里有两层代码：

- `runtime/` + `sXX/` 是主线教学代码，强调逐章展开和可读性。
- `src/core` + `src/modules` 是工程化参考层，强调复用、测试和真实项目迁移。

这两层不是两套互相竞争的实现。主线章节故意保留一定重复，让学习者在单个文件里看到完整的来回流程；工程化参考层则把这些重复模式抽成模块，方便理解如何迁移到真实项目。

章节的运行时状态（任务、记忆、信箱、cron、worktree 事件）写到**当前工作目录**下的隐藏路径：`.tasks/`、`.memory/`、`.transcripts/`、`.task_outputs/`、`.mailboxes/`、`.worktrees/`、`.scheduled_tasks.json`。可用环境变量 `AGENT_WORKSPACE` 覆盖根目录（端到端测试用它把副作用隔离到临时目录）。

## 快速开始

```bash
npm install

# 运行任意章节（默认 mock，零配置）
npm run s01
npm run s02
npm run s20

# 工程层 harness（真实工具：bash / 读写文件）
npm run harness

# 类型检查
npm run typecheck

# 共享模块测试
npm test

# 20 章端到端回归（子进程、强制 mock、不触网）
npm run test:e2e
```

所有章节默认使用 mock / scripted handler，不需要真实 LLM API Key，也不产生任何网络请求。建议先理解 loop、effect、handler、state 的边界，再考虑接入真实模型。

### 真实模型（可选）

默认目标是 **DeepSeek** 的 Anthropic 兼容端点。开启方式：

```bash
cp .env.example .env
# 在 .env 里填入 ANTHROPIC_AUTH_TOKEN（DeepSeek API Key）
# 默认 MODEL_ID=deepseek-chat，也可改为 deepseek-reasoner

npm run s01 -- --real     # 单章 real 模式
npm run harness:real      # 工程层 harness：真实模型 + 真实 bash/文件工具
```

要点：

- **默认 mock**：只有 `--real` 或 `AGENT_MODE=real` 才会请求模型；未配置 token 时会警告并回退 mock，不会报错。
- 章节 real 模式下 **LLM 是真调用**；工具处理由各章自己的 handler 决定——bash 真执行的是 s01/s03/s06/s08/s09/s12/s18/s20，其余章节为教学模拟（这些章节会在 system prompt 里告诉模型 bash 是模拟的，免得它空转）。要一套完整真实的工具执行（bash + 读写 + glob）请用 `npm run harness:real`。
- 想换其他 provider（GLM / Kimi / Anthropic），只需改 `.env` 里的 `ANTHROPIC_BASE_URL` + `MODEL_ID`，示例见 `.env.example`。
- `.env` 已被 gitignore，**切勿把 key 写进代码或提交**。

## 推荐学习方式

1. 从 `s01_agent_loop` 开始，先跑代码，再读 README。
2. 每章只问一个问题：这一章给 harness 增加了什么能力？
3. 对照 `agent.ts` 找到本章新增的 Effect、Handler 和 State。
4. 学完若干章后，再看 `src/modules` 里的共享实现。
5. 最后读 `s20_comprehensive`，看这些机制如何回到同一个 loop。

更多说明见：

- [docs/zh/algebraic-effects-primer.md](docs/zh/algebraic-effects-primer.md)
- [docs/zh/learn-shareai-crosswalk.md](docs/zh/learn-shareai-crosswalk.md)
- [docs/zh/first-principles.md](docs/zh/first-principles.md)
- [docs/zh/chapter-map.md](docs/zh/chapter-map.md)
- [docs/zh/study-workflow.md](docs/zh/study-workflow.md)

## 致谢

本项目参考 [shareai-lab/learn-claude-code](https://github.com/shareai-lab/learn-claude-code) 的课程结构和核心思想，并以 TypeScript 和 Algebraic Effects 重新表达。

原项目中文站：[learn.shareai.run/zh](https://learn.shareai.run/zh/)
