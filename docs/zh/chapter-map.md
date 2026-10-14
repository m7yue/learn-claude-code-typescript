# 20 章课程地图

这个仓库保留 Learn Claude Code 原版 20 章递进结构，并用 TypeScript + Algebraic Effects 重新表达。`sXX/agent.ts` 是主线学习入口，`src/modules` 是可复用机制的参考实现。

## 5 大关注点

官方站点把 20 章归为 5 个相互独立的关注点，本仓库与此一一对应：

| 关注点 | 章节 |
| --- | --- |
| Tools & Execution（工具与执行） | s01–s04 |
| Planning & Control（规划与控制） | s05、s06、s07、s10、s11 |
| Memory（记忆管理） | s08、s09 |
| Concurrency & Scheduling（并发与调度） | s13、s14 |
| Multi-Agent Platform（多 Agent 平台） | s12、s15、s16、s17、s18、s19、s20 |

> 想跑真实模型？默认 mock 零配置可运行，real 模式见根 `README.md` 的「真实模型（可选）」一节。

## 逐章对照

| 章节 | 主题 | Harness 机制 | 工程化参考 |
| --- | --- | --- | --- |
| s01 | Agent Loop | 模型决策、工具结果送回 | `src/core/agent.ts`, `src/core/effects.ts` |
| s02 | Tool Use | 工具池、工具分发 | `src/modules/tools.ts` |
| s03 | Permission | allow / ask / deny 权限边界 | `src/modules/permission.ts` |
| s04 | Hooks | PreToolUse / PostToolUse / Stop 扩展点 | `src/modules/hooks.ts` |
| s05 | TodoWrite | 把短期计划写到外部文件 | `src/modules/todos.ts` |
| s06 | Subagent | 独立上下文与摘要返回 | `DelegateEffect` in `src/core/agent.ts` |
| s07 | Skill Loading | 按需加载能力说明 | `src/modules/skills.ts` |
| s08 | Context Compact | 上下文压缩与结果裁剪 | `src/modules/compact.ts` |
| s09 | Memory | 跨会话长期记忆 | `src/modules/memory.ts` |
| s10 | System Prompt | 运行时 prompt 组装 | `src/modules/prompt.ts` |
| s11 | Error Recovery | 错误分类、重试、降级 | `src/modules/recovery.ts` |
| s12 | Task System | 持久任务的管理层 | `src/modules/tasks.ts`, `src/modules/task-tools.ts` |
| s13 | Background Tasks | 异步任务与通知送回 | `src/modules/background.ts` |
| s14 | Cron Scheduler | 时间触发工作 | `src/modules/cron.ts` |
| s15 | Agent Teams | 持久身份与 JSONL 邮箱 | `src/modules/team.ts` |
| s16 | Team Protocols | request-response 协作协议 | `src/modules/protocol.ts` |
| s17 | Autonomous Agents | 空闲的工作者主动认领任务 | `src/modules/autonomous.ts` |
| s18 | Worktree Isolation | 任务与执行目录隔离 | `src/modules/worktrees.ts` |
| s19 | MCP Plugin | 外部工具标准接入 | `src/modules/mcp.ts` |
| s20 | Comprehensive | 所有机制回到同一个循环 | `src/modules/comprehensive.ts` |

## 两层代码的关系

`sXX/agent.ts` 优先服务教学，所以每章会重复定义本章 Effect、Handler 和 Agent Generator。这种重复是有意的：学习者能在一个文件里看完机制的完整流程。

`src/core` 和 `src/modules` 优先服务工程化理解。它们把重复模式抽出来，展示如果要把这些机制迁移到真实 TypeScript 项目里，可以如何组织边界。

建议先读章节，再追共享模块。否则很容易先看到抽象，却还不知道它解决了哪一章里的具体问题。
