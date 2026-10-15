# 逐章学习工作流

这个项目建议按三条线对照学习：

1. [Learn Claude Code](https://learn.shareai.run/zh/)：先理解原始问题和课程主线内容。
2. `s01_agent_loop/` 到 `s20_comprehensive/`：看 TypeScript + Algebraic Effects 逐章改写。
3. `src/`：共享 TypeScript harness 模块，适合理解可复用抽象。

中文站现在是 20 章、5 大关注点，与本仓库 `s01`–`s20` 基本 1:1 对应，可以直接按章号对照；细节见 `learn-shareai-crosswalk.md`。

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
中文站: s04 Hook 系统
本项目: s04_hooks/agent.ts
共享模块: src/modules/hooks.ts
```

## 2. 再读本章 README

每章 README 共享一条主线骨架（不同章节会有少量差异）：

- 第一性原理
- 问题
- 代数效应视角
- 解决方案 / 工作原理
- 运行（输出示例）
- 本章小结

先抓住「这一章新增了什么 Effect / Handler / State」，能帮你避免只看代码细节，忘记它在 harness 架构中的位置。

## 3. 运行本章 demo

```sh
npm run s01
npm run s02
# ...
npm run s20
```

这些 demo 默认使用**各章自带的 mock/按脚本执行的 handler**，输出稳定、零配置、不访问网络。先理解 harness，再考虑切换真实模型。

## 4. 追到共享模块

章节代码会尽量保持“结构一致、方便对照阅读”，共享实现放在 `src/modules`：

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

## 6. 接入真实模型（可选）

章节的 `Chat` handler 通过 `runtime/model.ts` 的 `callChat()` 统一开关：mock 模式走各章自己的 mock，real 模式走真实模型。**没有改动 `ChatEffect` 的定义**——因为「能力属于 handler，意图属于 generator」。

```sh
cp .env.example .env        # 默认就是 DeepSeek 的 Anthropic 兼容端点
# 在 .env 里填 ANTHROPIC_AUTH_TOKEN（DeepSeek API Key）
npm run s01 -- --real       # 单章 real 模式
npm run harness:real        # 工程层 harness：真实模型 + 真实工具（bash/读写文件）
```

要点：

- 默认 `AGENT_MODE=mock`，零配置、不访问网络；只有 `--real` 或 `AGENT_MODE=real` 才会请求模型。
- 请求 real 但未配置 token 时，会打印警告并回退 mock，不会报错。
- `.env` 已被 gitignore，切勿把 key 写进代码或提交。
- 章节 real 模式下 **LLM 是真调用**；工具处理由各章自己的 handler 决定——bash 真执行的是 s03/s09/s12/s18/s20，其余章节为教学模拟。要一套完整真实的工具执行（bash + 读写 + glob），用 `npm run harness:real`。

更多配置见根 `README.md` 的「真实模型（可选）」一节。

