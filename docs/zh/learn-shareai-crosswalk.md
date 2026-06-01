# 与 Learn Claude Code对照学习

建议把这个仓库当作 [Learn Claude Code](https://learn.shareai.run/zh/) 的 TypeScript + Algebraic Effects 对照读本，而不是替代原站。

原站提供主叙事：为什么这一章存在、它在 Claude Code harness 里的位置是什么。本仓库提供 TypeScript 版本：这一章如果用 Effect、Handler、State 来表达，代码会长什么样。

## 推荐学习节奏

每一章按这个顺序读：

1. 先读 Learn Claude Code对应章节，抓住原始问题和工程动机。
2. 再读本仓库对应 `sXX/README.md`，看第一性原理和代数效应解释。
3. 运行本仓库对应脚本，例如 `npm run s01`。
4. 读对应 `agent.ts`，找到本章新增的 Effect、Handler 和 State。
5. 学完一组章节后，再看 `src/core` 或 `src/modules` 的共享实现。

## 章节对照

Learn Claude Code当前展示为 19 章、4 个阶段。本仓库保留 20 个本地学习入口，其中 `s20_comprehensive` 是综合演示章。

| 中文站章节 | 中文站主题 | 本仓库对应章节 | 说明 |
| --- | --- | --- | --- |
| s01 | Agent 循环 | `s01_agent_loop` | 最小闭环：模型、工具、结果回灌 |
| s02 | 工具使用 | `s02_tool_use` | 工具池和工具路由 |
| s03 | 待办写入 | `s05_todo_write` | 本仓库把 Permission / Hooks 放在 Todo 前面 |
| s04 | 子代理 | `s06_subagent` | 独立上下文和摘要返回 |
| s05 | 技能系统 | `s07_skill_loading` | 按需加载知识 |
| s06 | 上下文压缩 | `s08_context_compact` | 上下文预算和压缩策略 |
| s07 | 权限系统 | `s03_permission` | 工具执行前的安全边界 |
| s08 | Hook 系统 | `s04_hooks` | 工具前后和停止阶段的扩展点 |
| s09 | 记忆系统 | `s09_memory` | 跨会话长期记忆 |
| s10 | 系统提示词 | `s10_system_prompt` | 运行时组装 prompt |
| s11 | 错误恢复 | `s11_error_recovery` | 错误分类、重试、降级 |
| s12 | 任务系统 | `s12_task_system` | 持久任务控制面 |
| s13 | 后台任务 | `s13_background_tasks` | 异步任务和通知回灌 |
| s14 | 定时调度 | `s14_cron_scheduler` | 时间触发任务 |
| s15 | Agent 团队 | `s15_agent_teams` | 多 Agent 身份和消息 |
| s16 | 团队协议 | `s16_team_protocols` | request-response 协作协议 |
| s17 | 自主代理 | `s17_autonomous_agents` | 空闲 worker 自主认领任务 |
| s18 | Worktree 隔离 | `s18_worktree_isolation` | 任务和执行目录隔离 |
| s19 | MCP 与插件 | `s19_mcp_plugin` | 外部工具标准接入 |
| - | 综合演示 | `s20_comprehensive` | 本仓库额外提供的总复盘章节 |

## 为什么顺序会不完全一致

这个仓库早期按“每章新增一个 Effect 类型”的教学节奏组织，所以 Permission、Hooks 被提前放到 `s03`、`s04`，TodoWrite 则是 `s05`。

中文站当前更强调从核心闭环到系统加固的阅读体验，所以 Todo、Subagent、Skill、Compact 排在 Permission / Hooks 前面。

两种顺序都能学习。推荐以中文站顺序建立整体认知，再用上表跳到本仓库对应章节读 TypeScript 实现。
