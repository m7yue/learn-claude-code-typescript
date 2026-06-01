# Chapter Study Workflow

This project recommends a three-track learning approach:

1. [Learn Claude Code](https://learn.shareai.run/zh/): understand the original problem and course narrative.
2. `s01_agent_loop/` to `s20_comprehensive/`: review the TypeScript + Algebraic Effects rewrite.
3. `src/`: explore shared TypeScript harness modules for reusable abstractions.

The Chinese site chapter order and this repository directory order differ slightly. Start with `learn-shareai-crosswalk.md` to see the mapping.

Read each chapter in this order:

## 0. Establish two basic intuitions first

If you are not yet familiar with Agent harness or algebraic effects, begin with:

- `first-principles.md`
- `algebraic-effects-primer.md`

Do not try to understand the full theory at first. Just hold two ideas:

- The Agent harness decides what the model can see, do, and remember.
- Algebraic effects separate “declaring intent” from “interpreting side effects.”

## 1. Read the corresponding chapter on the Chinese site first

Go to Learn Claude Code and focus on what each chapter adds compared to the previous one, and which harness problem it solves.

For example:

```txt
Chinese site: s08 Hook system
This repo: s04_hooks/agent.ts
Shared module: src/modules/hooks.ts
```

## 2. Read this chapter’s README next

Each chapter README follows the same structure:

- the original focus
- the TS rewrite
- the new Effect / Handler / State
- the reading path

This helps you avoid getting lost in code details and missing the chapter’s role in the harness architecture.

## 3. Run the chapter demo

```sh
npm run s01
npm run s02
# ...
npm run s20
```

These demos use the default `ScriptedModel`, so the output is stable. Understand the harness first, then consider replacing it with a real model.

## 4. Follow through to shared modules

Chapter code aims to remain “isomorphic and readable.” Shared implementation is in `src/modules`:

| Mechanism | Shared module |
| --- | --- |
| Algebraic Effects | `src/core/effects.ts` |
| Agent loop | `src/core/agent.ts` |
| Tools | `src/modules/tools.ts` |
| Permission | `src/modules/permission.ts` |
| Hooks | `src/modules/hooks.ts` |
| Todo | `src/modules/todos.ts` |
| Skills | `src/modules/skills.ts` |
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
| Comprehensive | `src/modules/comprehensive.ts` |

## 5. Practice rewriting it yourself

After reading each chapter, try answering these questions:

1. What real-world capability does this chapter add?
2. Should that capability be represented as an effect, a handler, or state?
3. If you plug in a real model API, do you change Agent logic or only handlers?

This mindset is more important than memorizing a code snippet.
