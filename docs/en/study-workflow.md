# Chapter Study Workflow

This project recommends a three-track learning approach:

1. [Learn Claude Code](https://learn.shareai.run/zh/): understand the original problem and course narrative.
2. `s01_agent_loop/` to `s20_comprehensive/`: review the TypeScript + Algebraic Effects rewrite.
3. `src/`: explore shared TypeScript harness modules for reusable building blocks.

The official site now has 20 chapters across 5 concern groups and lines up almost one-to-one with this repository's `s01`–`s20`, so you can pair chapters directly by number. See `learn-shareai-crosswalk.md` for details.

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
Chinese site: s04 Hook system
This repo: s04_hooks/agent.ts
Shared module: src/modules/hooks.ts
```

## 2. Read this chapter’s README next

Each chapter README shares a common outline (with minor per-chapter variation):

- First principles
- The problem
- Algebraic-effects view
- Solution / How it works
- Run (sample output)
- Chapter summary

First identify "what new Effect / Handler / State this chapter adds" — that keeps you from getting lost in code details and missing the chapter's role in the harness architecture.

## 3. Run the chapter demo

```sh
npm run s01
npm run s02
# ...
npm run s20
```

These demos use **each chapter's own mock/scripted handler** by default, so the output is stable, needs zero configuration, and makes no network calls. Understand the harness first, then consider switching to a real model.

## 4. Follow through to shared modules

Chapter code aims to remain “consistent in shape and readable.” Shared implementation is in `src/modules`:

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

## 6. Plug in a real model (optional)

Each chapter's `Chat` handler goes through a single switch, `callChat()` in `runtime/model.ts`: in mock mode it calls the chapter's own mock, in real mode it calls a real model. **The `ChatEffect` definition is unchanged** — because capabilities belong to the handler while intent belongs to the generator.

```sh
cp .env.example .env        # defaults to DeepSeek's Anthropic-compatible endpoint
# set ANTHROPIC_AUTH_TOKEN (your DeepSeek API key) in .env
npm run s01 -- --real       # real mode for a single chapter
npm run harness:real        # engineering harness: real model + real tools (bash/files)
```

Key points:

- The default is `AGENT_MODE=mock`: zero config, no network. Only `--real` or `AGENT_MODE=real` triggers a model request.
- If real is requested but no token is configured, it warns and falls back to mock instead of failing.
- `.env` is git-ignored — never commit keys.
- In a chapter's real mode the **LLM call is real**; whether a tool actually runs depends on that chapter's handler — bash is really executed in s03/s09/s12/s18/s20 and simulated in the rest. For a fully real tool set (bash + read/write + glob) use `npm run harness:real`.

See the "Real model (optional)" section in the root `README.en.md` for details.

