# First Principles of Agent Harness

## 1. An Agent is not a mysterious object

A minimal Agent can be broken down into a loop:

```txt
user goal -> model decision -> tool execution -> results enter context -> model decides again
```

Without a loop, the model can only answer questions. With a loop, the model can observe the real world, take actions, and adjust based on the results.

## 2. Engineers design the harness, not the agency

The model's ability to act on its own comes from training and inference ability. External code cannot make a model without ability into a strong Agent.

What engineers actually design is the harness:

```txt
Harness = loop + tools + permissions + context + memory + state + protocols
```

In other words, we decide what the model can see, which tools it can call, which actions require approval, how context is compressed, where long-term memory is stored, and how multiple Agents collaborate.

## 3. Tool calls are controlled side effects

Reading files, writing files, executing shell commands, creating tasks, sending messages, and connecting to MCP servers all touch the outside world. They should not be scattered throughout Agent reasoning logic; they should be modeled explicitly:

```ts
const output = yield* perform({
  type: "BashExec",
  input: { command: "ls" },
});
```

This code expresses “I need a BashExec effect,” not “I execute the shell immediately.” The runtime handler can choose to execute it, simulate it, require approval, deny it, log it, or retry.

## 4. Algebraic Effects are a good fit for explaining the Agent loop

In this project:

| Concept | Meaning |
| --- | --- |
| Effect | intention declared by the Agent |
| Handler | runtime interpretation of the intention |
| `perform()` | entry point for issuing effects inside a Generator |
| `runAgent()` | drives the loop and sends handler results back to the Agent |

This separation keeps Agent logic clear and keeps side effects in one place at the edge. You can swap out a handler and run the same Agent logic in test, teaching, sandbox, or real-model environments.

## 5. The 20 chapters are really expanding the same harness

| Phase | Chapters | First principles |
| --- | --- | --- |
| Basic loop | s01 Agent Loop | the model needs tool result feedback to form an action loop |
| Tool capability | s02 Tool Use | tools expand what the model can do |
| Safety boundary | s03 Permission, s04 Hooks | real side effects require approval, interception, and auditing |
| Working memory | s05 TodoWrite | long-running work needs a plan written down outside the model |
| Context management | s06 Subagent, s08 Compact | exploration clutter and history cannot be stuffed into the main context forever |
| Knowledge and memory | s07 Skill, s09 Memory, s10 Prompt | knowledge should be loaded on demand, prompt should be assembled at runtime |
| Resilience | s11 Recovery | errors should be classified and handled instead of stopping everything |
| Always-on task control | s12 Task, s13 Background, s14 Cron | long-term work needs tasks, async, and time triggers |
| Multi-Agent collaboration | s15 Team, s16 Protocol, s17 Autonomous | collaboration needs identity, messaging, and explicit protocols |
| Execution isolation and extension | s18 Worktree, s19 MCP | parallel modifications need isolation, external capability needs standard integration |
| Comprehensive | s20 Comprehensive | there are many mechanisms, but there is still only one loop |

## 6. When learning, focus on three questions

After reading each chapter, ask:

1. What real-world capability does this chapter add to the Agent?
2. Should this capability be modeled as an Effect, a Handler, or persistent State?
3. If you replace the real LLM API, do you need to change Agent logic or only handlers?

If you can answer these three questions, you are understanding the harness engineering rather than memorizing code.
