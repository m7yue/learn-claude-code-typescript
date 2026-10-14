# 与 Learn Claude Code 对照学习

建议把这个仓库当作 [Learn Claude Code](https://learn.shareai.run/zh/) 的 TypeScript + Algebraic Effects 对照读本，而不是替代原站。

原站提供主干内容：为什么这一章存在、它在 Claude Code harness 里的位置是什么。本仓库提供 TypeScript 版本：这一章如果用 Effect、Handler、State 来表达，代码会长什么样。

## 推荐学习节奏

每一章按这个顺序读：

1. 先读 Learn Claude Code 对应章节，抓住原始问题和工程动机。
2. 再读本仓库对应 `sXX/README.md`，看第一性原理和代数效应解释。
3. 运行本仓库对应脚本，例如 `npm run s01`。
4. 读对应 `agent.ts`，找到本章新增的 Effect、Handler 和 State。
5. 学完一组章节后，再看 `src/core` 或 `src/modules` 的共享实现。

## 章节对照

官方站点现在是 **20 章、5 大关注点**，与本仓库 `s01`–`s20` **基本 1:1 对应**（章节号、顺序都一致）。可以直接按章号对照：

| 官方关注点 | 官方章节 | 本仓库章节 |
| --- | --- | --- |
| Tools & Execution（工具与执行） | s01 Agent Loop | [s01_agent_loop](../../s01_agent_loop/) |
| | s02 Tool Use | [s02_tool_use](../../s02_tool_use/) |
| | s03 Permission | [s03_permission](../../s03_permission/) |
| | s04 Hooks | [s04_hooks](../../s04_hooks/) |
| Planning & Control（规划与控制） | s05 TodoWrite | [s05_todo_write](../../s05_todo_write/) |
| | s06 Subagent | [s06_subagent](../../s06_subagent/) |
| | s07 Skill Loading | [s07_skill_loading](../../s07_skill_loading/) |
| | s10 System Prompt | [s10_system_prompt](../../s10_system_prompt/) |
| | s11 Error Recovery | [s11_error_recovery](../../s11_error_recovery/) |
| Memory（记忆管理） | s08 Context Compact | [s08_context_compact](../../s08_context_compact/) |
| | s09 Memory | [s09_memory](../../s09_memory/) |
| Concurrency & Scheduling（并发与调度） | s13 Background Tasks | [s13_background_tasks](../../s13_background_tasks/) |
| | s14 Cron Scheduler | [s14_cron_scheduler](../../s14_cron_scheduler/) |
| Multi-Agent Platform（多 Agent 平台） | s12 Task System | [s12_task_system](../../s12_task_system/) |
| | s15 Agent Teams | [s15_agent_teams](../../s15_agent_teams/) |
| | s16 Team Protocols | [s16_team_protocols](../../s16_team_protocols/) |
| | s17 Autonomous Agents | [s17_autonomous_agents](../../s17_autonomous_agents/) |
| | s18 Worktree Isolation | [s18_worktree_isolation](../../s18_worktree_isolation/) |
| | s19 MCP Tools | [s19_mcp_plugin](../../s19_mcp_plugin/) |
| | s20 Comprehensive Agent | [s20_comprehensive](../../s20_comprehensive/) |

只有两处命名略有差异（内容相同）：

| 官方名称 | 本仓库目录 |
| --- | --- |
| MCP Tools | `s19_mcp_plugin` |
| Comprehensive Agent | `s20_comprehensive` |

## 关于章节顺序

本仓库目录顺序与官方站点的 20 章顺序完全一致：都按 s01–s20 排列，Permission/Hooks 在 `s03`/`s04`，TodoWrite 在 `s05`。因此**不需要做跨章节对照**，直接按章号阅读即可。

## 想跑真实模型？

本仓库默认使用各章自己的 mock/按脚本执行的 handler，零配置即可运行。若要接真实模型（默认 DeepSeek），见根目录 `README.md` 的「真实模型（可选）」一节。
