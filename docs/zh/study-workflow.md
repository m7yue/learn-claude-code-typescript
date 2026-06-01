# 逐章学习工作流

这个项目建议按三条线对照学习：

1. [Learn Claude Code](https://learn.shareai.run/zh/)：先理解原始问题和课程主叙事。
2. `s01_agent_loop/` 到 `s20_comprehensive/`：看 TypeScript + Algebraic Effects 逐章改写。
3. `src/`：共享 TypeScript harness 模块，适合理解可复用抽象。

中文站当前章节顺序和本仓库目录有少量差异，先看 `learn-shareai-crosswalk.md` 的对照表会更顺。

建议每章按这个顺序学习：

## 0. 先建立两个基本直觉

如果你还不熟悉 Agent harness 或代数效应，建议先读：

- `first-principles.md`
- `algebraic-effects-primer.md`

先不用追求理解完整理论，只要先抓住两句话：

- Agent harness 决定模型能看什么、做什么、记住什么。
- 代数效应把“声明意图”和“解释副作用”分开。

## 1. 先读中文站对应章节

到 Learn Claude Code读对应章节，重点看这一章相对上一章新增了什么，以及它解决了哪一个 harness 问题。

例如：

```txt
中文站: s08 Hook 系统
本项目: s04_hooks/agent.ts
共享模块: src/modules/hooks.ts
```

## 2. 再读本章 README

每章 README 都按同一结构写：

- 原版关注点
- TS 改写
- 新增 Effect / Handler / State
- 阅读路径

这能帮你避免只看代码细节，忘记这一章在 harness 架构中的位置。

## 3. 运行本章 demo

```sh
npm run s01
npm run s02
# ...
npm run s20
```

这些 demo 默认使用 `ScriptedModel`，输出稳定。先理解 harness，再替换真实模型。

## 4. 追到共享模块

章节代码会尽量保持“同构可读”，共享实现放在 `src/modules`：

| 机制 | 共享模块 |
| --- | --- |
| Algebraic Effects | `src/core/effects.ts` |
| Agent loop | `src/core/agent.ts` |
| 工具 | `src/modules/tools.ts` |
| 权限 | `src/modules/permission.ts` |
| Hooks | `src/modules/hooks.ts` |
| Todo | `src/modules/todos.ts` |
| Skill | `src/modules/skills.ts` |
| Compact | `src/modules/compact.ts` |
| Memory | `src/modules/memory.ts` |
| Prompt | `src/modules/prompt.ts` |
| Recovery | `src/modules/recovery.ts` |
| Task | `src/modules/tasks.ts` |
| Background | `src/modules/background.ts` |
| Cron | `src/modules/cron.ts` |
| Team | `src/modules/team.ts` |
| Protocol | `src/modules/protocol.ts` |
| Autonomous | `src/modules/autonomous.ts` |
| Worktree | `src/modules/worktrees.ts` |
| MCP | `src/modules/mcp.ts` |
| 综合 Harness | `src/modules/comprehensive.ts` |

## 5. 做自己的改写练习

每章读完后，可以尝试回答三个问题：

1. 这一章新增的真实世界能力是什么？
2. 这个能力应该是 effect、handler，还是 state？
3. 如果接入真实模型 API，需要替换哪一个 handler？

这个思维方式比记住某段代码更重要。
