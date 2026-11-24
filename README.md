# learn-claude-code-typescript

中文 ｜ [English]

[English]: ./README.en.md
[中文]: ./README.md

[![CI](https://github.com/m7yue/learn-claude-code-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/m7yue/learn-claude-code-typescript/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

用 TypeScript + 代数效应从零实现的 Agent Harness 参考实现：`s01`–`s20` 二十个章节递进实现 Agent loop、工具调用、权限、hooks、todo、subagent、context 压缩、memory、任务系统、团队协作、MCP 等机制；`src/core` + `src/modules` 把其中可复用的部分抽取成工程模块层，由 CLI 与评测共用；配套全仓库类型检查、26 个测试文件、20 章端到端回归，以及一套带自检的评测系统（`evals/`）。

章节组织参考了 [Learn Claude Code](https://github.com/shareai-lab/learn-claude-code) 的课程结构，实现是独立的 TypeScript 重写：不是该课程的复刻或翻译版，也不是 Claude Code 的产品复刻。所有章节默认 mock 模式离线运行，不需要 API Key；接入真实模型后哪些副作用是真的（bash、文件、git）、哪些是教学模拟，见「真实模型」一节的边界说明。

如果你还不了解代数效应，可以先把它理解成一句话：

```txt
Agent 逻辑只声明“我要做什么”，运行时 handler 再决定“怎么做”。
```

更完整的入门解释见 [docs/zh/algebraic-effects-primer.md](docs/zh/algebraic-effects-primer.md)。

## 为什么做这个项目

我做这个项目的动机很简单：很多前端工程师已经开始使用 Claude Code、Cursor、Codex 一类工具，但真正理解它们背后的 harness 工程并不容易。

原版 Learn Claude Code 用 Python 展示了这些机制。我用前端工程师更熟悉的 TypeScript 把这些机制重新实现了一遍，同时用第一性原理和代数效应重述：

```txt
Agent = 模型的 agency + harness
Harness = loop + tools + permissions + context + memory + state + protocols
```

模型负责产生意图，harness 负责解释意图、执行副作用、注入观察结果、维护边界和状态。工程师真正能设计的部分，主要就是 harness。

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

## 能力矩阵：20 章机制一览

更推荐的方式是结合 [Learn Claude Code](https://learn.shareai.run/zh/) 对照学习：先读原站对应章节理解动机，再回到本仓库看 TypeScript + Algebraic Effects 版本。

官方站点现在是 **20 章、5 大关注点**，与本仓库 `s01`–`s20` **基本 1:1 对应**（章节号、顺序一致），可以直接按章号对照，具体见 [docs/zh/learn-shareai-crosswalk.md](docs/zh/learn-shareai-crosswalk.md)。

主线章节是 `s01_agent_loop/` 到 `s20_comprehensive/`。每章包含：

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
| [s09](s09_memory/) | Memory | `ReadMemory`, `WriteMemory`, `SelectMemory`, `ExtractMemories`, `ConsolidateMemories` |

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

## 两层架构与项目结构

```txt
learn-claude-code-typescript/
├── runtime/
│   ├── core.ts              # 逐章教学使用的最小代数效应运行时
│   ├── types.ts             # 章节共享类型
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
│   ├── harness-agent.ts     # 工程层 harness 的可复用组装（CLI 与 evals 共用）
│   └── harness.ts           # 工程层可运行入口（真实工具 + 可选真实模型）
├── evals/                   # 工程层能力评测（固定任务 + 裁判 + 报告）
├── docs/                    # 学习地图、第一性原理、学习工作流
├── tests/                   # 共享模块行为测试 + 20 章端到端回归
└── .env.example             # real 模式配置模板（默认 DeepSeek）
```

目录树只列出主要文件：`runtime/` 实际有 18 个源文件，`s20_comprehensive/` 把各机制拆成了独立模块。工程层的具体构成是 `src/core` 7 个文件（Agent loop、Effect 系统、ScriptedModel、AnthropicModel、工具规格等）加 `src/modules` 22 个可复用模块；`src/harness-agent.ts` 由 CLI（`src/harness.ts`）和 `evals/` 共用同一套组装，避免两份实现漂移。

这里有两层代码：

- `runtime/` + `sXX/` 是主线教学代码，强调逐章展开和可读性。
- `src/core` + `src/modules` 是工程化参考层，强调复用、测试和真实项目迁移。

这两层不是两套互相竞争的实现。主线章节故意保留一定重复，让学习者在单个文件里看到完整的来回流程；工程化参考层则把这些重复模式抽成模块，方便理解如何迁移到真实项目。

章节的运行时状态（任务、记忆、信箱、cron、worktree 事件）写到**当前工作目录**下的隐藏路径：`.tasks/`、`.memory/`、`.transcripts/`、`.task_outputs/`、`.mailboxes/`、`.worktrees/`、`.scheduled_tasks.json`。可用环境变量 `AGENT_WORKSPACE` 覆盖根目录（端到端测试用它把副作用隔离到临时目录）。

## 质量保障

改动有一套固定的验收流程，全部离线完成，不需要 API Key：

| 层 | 命令 | 覆盖内容 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 全仓库 `tsc --noEmit`，开启 `strict` |
| 单元测试 | `npm test` | 26 个测试文件（约 2,900 行）：runtime 共享代码、src 工程模块、evals 评测器本身 |
| 端到端回归 | `npm run test:e2e` | 20 个章节逐章以独立子进程重跑：强制 mock，副作用隔离进临时目录，不访问网络 |
| 评测自检 | `npm run eval:check` | 评测器自身的正确性：正确回合必须全部通过，错误回合必须至少失败一项检查 |

类型检查、单元测试、端到端回归、评测自检已接入 GitHub Actions，每次提交自动运行（见顶部徽章）。

`evals/` 是工程层 harness 的评测系统：3 个固定任务（读文件并回答、修复真实代码缺陷、权限边界），6 种程序化检查（文件内容、文件哈希、命令退出码、最终回答、工具调用次数等），Keyword / LLM 两种裁判，输出成功率、token、延迟和 `report.md`。它的已知边界同样写在文档里：任务只覆盖基础工具、权限和回答，不覆盖 todo、团队、cron、worktree；真实模型有随机性，小样本只看趋势。使用手册见 [evals/README.md](evals/README.md)，每一步在代码里怎么走、为什么这样设计见 [evals/EXPLAINED.md](evals/EXPLAINED.md)。

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

# 工程层评测（mock，验证评测链路）
npm run eval

# 评测器自检：correct 必须全过、wrong 必须至少失败一项
npm run eval:check
```

所有章节默认使用 mock / scripted handler，不需要真实 LLM API Key，也不产生任何网络请求。建议先理解 loop、effect、handler、state 的边界，再考虑接入真实模型。

### 评测（可选）

`evals/` 评的是**工程层 harness**（`src/harness-agent.ts`），不是 s01–s20：固定 3 个任务、程序化检查 + 裁判、成功率/token/延迟和 `report.md`。改章节仍然跑 `npm test` + `npm run test:e2e`。详见 [evals/README.md](evals/README.md)。

### 真实模型（可选）

默认目标是 **DeepSeek** 的 Anthropic 兼容端点。开启方式：

```bash
cp .env.example .env
# 在 .env 里填入 ANTHROPIC_AUTH_TOKEN（DeepSeek API Key）
# 默认 MODEL_ID=deepseek-chat，也可改为 deepseek-reasoner

npm run s01 -- --real     # 单章 real 模式
npm run harness:real      # 工程层 harness：真实模型 + 真实 bash/文件工具
npm run eval:real         # 工程层评测：真实模型 + 3 个任务 × 3 次
```

要点：

- **默认 mock**：只有 `--real` 或 `AGENT_MODE=real` 才会请求模型；未配置 token 时会警告并回退 mock，不会报错。
- 章节 real 模式下 **LLM 是真调用**；工具处理由各章自己的 handler 决定——bash 真执行的是 s01/s03/s06/s08/s09/s12/s18/s20，其余章节为教学模拟（这些章节会在 system prompt 里告诉模型 bash 是模拟的，免得它空转）。要一套完整真实的工具执行（bash + 读写 + glob）请用 `npm run harness:real`。
- 想换其他 provider（GLM / Kimi / Anthropic），只需改 `.env` 里的 `ANTHROPIC_BASE_URL` + `MODEL_ID`，示例见 `.env.example`。
- `.env` 已被 gitignore，**切勿把 key 写进代码或提交**。

## 建议阅读方式

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

## AI 协作方式

这个项目由我和 AI 协作完成，分工如下：

- 我负责：抽象设计与机制取舍（每一章拆出哪些 Effect / Handler / State、两层代码如何分层）、正确性验收（每个机制的预期行为由我定义和检查）、测试与评测设计（回归测试覆盖哪些章节、评测任务和通过条件如何确定）、文档结构与表达把关。
- AI 负责：代码转换、章节草稿、重构建议和文档初稿的执行。

这套分工也解释了测试和评测在这个仓库里的占比：AI 参与产出的代码，必须通过同一套类型检查、单元测试和端到端回归才算完成。

## 致谢

章节主题与组织结构参考 [shareai-lab/learn-claude-code](https://github.com/shareai-lab/learn-claude-code)（Python 编写的开源课程，中文站点：[learn.shareai.run/zh](https://learn.shareai.run/zh/)）。实现是独立的：TypeScript 代码从零编写，`src/` 工程模块层、测试与评测体系为本项目独立增加，不是该课程的复刻或翻译版。

本项目以 MIT 许可证发布，见 [LICENSE](LICENSE)。
