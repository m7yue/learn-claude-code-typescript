# Agent Harness 第一性原理

## 1. Agent 不是一个神秘对象

最小 Agent 可以拆成一个循环：

```txt
用户目标 -> 模型决策 -> 工具执行 -> 结果进入上下文 -> 模型再次决策
```

没有循环，模型只能回答问题；有了循环，模型才能观察真实世界、采取行动、根据行动结果继续调整。

## 2. 工程师设计的是 harness，不是 agency

模型的 agency 来自训练和推理能力。外部代码不能把一个没有能力的模型“编排”成强 agent。

工程师真正能设计的是 harness：

```txt
Harness = loop + tools + permissions + context + memory + state + protocols
```

也就是说，我们决定模型能看到什么、能调用哪些工具、哪些动作需要审批、上下文如何压缩、长期记忆放在哪里、多 Agent 如何协作。

## 3. 工具调用本质上是受控副作用

读文件、写文件、执行 shell、创建任务、发消息、连接 MCP server 都会碰到外部世界。它们不应该散落在 Agent 推理逻辑里，而应该被显式建模：

```ts
const output = yield* perform({
  type: "BashExec",
  input: { command: "ls" },
});
```

这段代码表达的是“我需要一个 BashExec 效应”，不是“我立刻执行 shell”。运行时 handler 可以选择真实执行、模拟执行、要求审批、拒绝、记录日志或重试。

## 4. Algebraic Effects 适合解释 Agent loop

在这个项目里：

| 概念 | 含义 |
| --- | --- |
| Effect | Agent 声明的意图 |
| Handler | 运行时对意图的解释 |
| `perform()` | Generator 内部发起效应的入口 |
| `runAgent()` | 驱动循环，把 handler 结果送回 Agent |

这个拆分让 Agent 逻辑保持清楚，也让副作用集中在边界处。你可以换一套 handler，把同一个 Agent 逻辑放到测试环境、教学环境、沙盒环境或真实模型环境。

## 5. 20 章其实是在扩展同一个 harness

| 阶段 | 章节 | 第一性原理 |
| --- | --- | --- |
| 基础循环 | s01 Agent Loop | 模型需要工具结果回灌，才能形成行动闭环 |
| 工具能力 | s02 Tool Use | 工具扩展模型可触达的行动空间 |
| 安全边界 | s03 Permission, s04 Hooks | 真实副作用必须有审批、拦截和审计 |
| 工作记忆 | s05 TodoWrite | 长任务需要把计划外部化 |
| 上下文管理 | s06 Subagent, s08 Compact | 探索噪声和历史结果不能无限塞进主上下文 |
| 知识与记忆 | s07 Skill, s09 Memory, s10 Prompt | 知识要按需加载，prompt 要运行时组装 |
| 韧性 | s11 Recovery | 错误要分类处理，而不是一失败就停止 |
| 持久控制面 | s12 Task, s13 Background, s14 Cron | 长期工作需要任务、异步和时间触发 |
| 多 Agent 协作 | s15 Team, s16 Protocol, s17 Autonomous | 协作需要身份、消息和显式协议 |
| 执行隔离与扩展 | s18 Worktree, s19 MCP | 并行修改要隔离，外部能力要标准接入 |
| 综合 | s20 Comprehensive | 机制很多，但循环仍然只有一个 |

## 6. 学习时抓住三个问题

每章读完后，可以问：

1. 这一章给 Agent 增加了哪种真实世界能力？
2. 这个能力应该表达成 Effect、Handler，还是持久 State？
3. 如果替换成真实 LLM API，需要改 Agent 逻辑，还是只改 handler？

能回答这三个问题，就不是在背代码，而是在理解 harness 工程。
