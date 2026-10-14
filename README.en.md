# learn-claude-code-typescript

English | [中文]

[English]: ./README.en.md
[中文]: ./README.md

A learning project about Agent harnesses for frontend engineers: this repo rewrites the 20 progressive lessons from [Learn Claude Code](https://github.com/shareai-lab/learn-claude-code) into TypeScript + Algebraic Effects.

This repository is not a product reproduction of Claude Code, nor is it a complete coding agent framework. It is more like a set of runnable learning notes: it uses TypeScript code to break apart agent loop, tool calls, permission, hooks, todo, subagent, skill, compact, memory, task, team, MCP, and other mechanisms chapter by chapter, then explains their shared engineering structure from an algebraic effects perspective.

If you are not yet familiar with algebraic effects, you can think of it this way:

```txt
Agent logic declares "what I want to do", and the runtime decides "how to do it".
```

A more complete introduction is in [docs/en/algebraic-effects-primer.md](docs/en/algebraic-effects-primer.md).

## Why this project exists

The motivation for this project is simple: many frontend engineers already use tools such as Claude Code, Cursor, and Codex, but it is not easy to truly understand the harness engineering behind them.

The original Learn Claude Code used Python to demonstrate these mechanisms. I wanted to translate it into TypeScript, which frontend engineers are more familiar with, and further restate it using first principles and algebraic effects:

```txt
Agent = model agency + harness
Harness = loop + tools + permissions + context + memory + state + protocols
```

The model is responsible for generating intentions, while the harness is responsible for interpreting intentions, executing side effects, injecting results, maintaining boundaries, and preserving state. The part that engineers can really design is mainly the harness.

## AI collaboration explanation

This project is a learning-oriented engineering project completed through collaboration with AI.

I am responsible for asking questions, setting direction, judging whether the abstractions are right, checking course structure, and verifying expression. AI is responsible for large-scale code transformation, chapter drafts, refactoring suggestions, and document generation. This process itself is also part of what the project intends to convey: we are not just "using AI to write code", we can also use AI to help ourselves understand the engineering principles behind AI coding agents.

So this repository is both a TypeScript tutorial and an example of AI-assisted learning.

## Core perspective: Algebraic Effects

The core loop in the original Python lessons is roughly:

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

From the algebraic effects point of view, this loop can be broken into three parts:

| Mechanism | Algebraic Effects Expression | Meaning |
| --- | --- | --- |
| Tool use | `yield* perform(effect)` | Agent declares "what I want to do" |
| Tool handler | `handlers[effect.type]` | Runtime decides "how to do it" |
| Agent loop | `runAgent()` | Send side effect results back into the Agent |

In this project, Agent logic is usually written as a Generator:

```ts
function* agentLoop(perform: PerformFn<MyEffect>) {
  const output = yield* perform({
    type: "BashExec",
    input: { command: "ls" },
  });

  return output;
}
```

This code does not execute the shell directly. It only declares an intention. The real execution, interception, approval, mock, logging, or sandboxing is decided by the handler.

## Study path

The recommended path is to use [Learn Claude Code](https://learn.shareai.run/zh/) for comparison: first read the corresponding chapter on the original site to understand the motivation, then return to this repository to see the TypeScript + Algebraic Effects version.

The official site now shows **20 chapters across 5 concern groups** and maps **roughly 1:1** onto this repository's `s01`–`s20` (same numbers, same order), so you can pair chapters directly by number. See [docs/en/learn-shareai-crosswalk.md](docs/en/learn-shareai-crosswalk.md) for details.

The main learning path is still `s01_agent_loop/` through `s20_comprehensive/`. Each chapter includes:

- `README.md`: first principles, algebraic effects perspective, code explanation
- `agent.ts`: the chapter's effects, handlers, agent generator, and startup entry

Recommended reading order:

```txt
README.en.md
-> docs/en/algebraic-effects-primer.md
-> docs/en/learn-shareai-crosswalk.md
-> s01_agent_loop/README.md
-> s01_agent_loop/agent.ts
-> s02 ... s20
-> src/core and src/modules
```

### Tools & Execution

| Chapter | Theme | Added mechanism |
| --- | --- | --- |
| [s01](s01_agent_loop/) | Agent Loop | `Chat`, `BashExec` |
| [s02](s02_tool_use/) | Tool Use | `ReadFile`, `WriteFile`, `EditFile`, `GlobSearch` |
| [s03](s03_permission/) | Permission | `RequestPermission` |
| [s04](s04_hooks/) | Hooks | `FireHook` |

### Planning & Control

| Chapter | Theme | Added mechanism |
| --- | --- | --- |
| [s05](s05_todo_write/) | TodoWrite | `TodoWrite`, `TodoRead` |
| [s06](s06_subagent/) | Subagent | `Delegate` |
| [s07](s07_skill_loading/) | Skill Loading | `LoadSkill`, `ListSkills` |
| [s10](s10_system_prompt/) | System Prompt | `AssemblePrompt` |
| [s11](s11_error_recovery/) | Error Recovery | `RetryWithBackoff` |

### Memory

| Chapter | Theme | Added mechanism |
| --- | --- | --- |
| [s08](s08_context_compact/) | Context Compact | `Compact`, `PersistOutput` |
| [s09](s09_memory/) | Memory | `ReadMemory`, `WriteMemory`, `SelectMemory` |

### Concurrency & Scheduling

| Chapter | Theme | Added mechanism |
| --- | --- | --- |
| [s13](s13_background_tasks/) | Background Tasks | `StartBackground`, `CollectBackgroundResults` |
| [s14](s14_cron_scheduler/) | Cron Scheduler | `ScheduleCron`, `ListCrons`, `CancelCron` |

### Multi-Agent Platform

| Chapter | Theme | Added mechanism |
| --- | --- | --- |
| [s12](s12_task_system/) | Task System | `CreateTask`, `ClaimTask`, `CompleteTask` |
| [s15](s15_agent_teams/) | Agent Teams | `SpawnTeammate`, `SendMessage`, `CheckInbox` |
| [s16](s16_team_protocols/) | Team Protocols | `RequestPlan`, `ReviewPlan` |
| [s17](s17_autonomous_agents/) | Autonomous Agents | `IdlePoll`, `ScanUnclaimed` |
| [s18](s18_worktree_isolation/) | Worktree Isolation | `CreateWorktree`, `BindWorktree`, `KeepWorktree`, `RemoveWorktree` |
| [s19](s19_mcp_plugin/) | MCP Tools | `MCPConnect`, `MCPToolCall` |
| [s20](s20_comprehensive/) | Comprehensive Agent | all previous mechanisms |

## Project structure

```txt
learn-claude-code-typescript/
├── runtime/
│   ├── core.ts              # minimal algebraic effects runtime used by the chapters
│   ├── types.ts             # shared types for the lessons
│   ├── env.ts               # mode resolution (mock/real) + .env loading
│   ├── model.ts             # Anthropic-compatible client + callChat switch (model/maxTokens overrides)
│   ├── errors.ts            # error classification by name/message
│   ├── workspace.ts         # workspace-relative paths where state is saved (.tasks/.memory/...)
│   ├── locks.ts             # async mutex (one operation at a time)
│   └── tool-schemas.ts      # JSON schemas for chapter tools (real mode only)
├── s01_agent_loop/ ... s20_comprehensive/
│   ├── README.md            # chapter explanation
│   └── agent.ts             # runnable code for the chapter
├── src/
│   ├── core/                # more engineering-oriented Agent loop / Effect / ScriptedModel / AnthropicModel
│   ├── modules/             # reusable example implementations of harness mechanisms
│   └── harness.ts           # runnable engineering starting point (real tools + optional real model)
├── docs/                    # study map, first principles, learning workflow
├── tests/                   # shared module behavior tests + full 20-chapter re-run
└── .env.example             # real-mode config template (DeepSeek by default)
```

There are two layers of code:

- `runtime/` + `sXX/` is the main teaching code, emphasizing chapter-by-chapter progression and readability.
- `src/core` + `src/modules` is the engineering reference layer, emphasizing reuse, testing, and migration to real projects.

These two layers are not competing implementations. The teaching chapters intentionally keep some repetition so learners can see a complete closed loop in one file; the engineering layer abstracts repeatable patterns for real project migration.

Chapter runtime state (tasks, memory, mailboxes, cron, worktree events) is written under the **current working directory** in hidden paths: `.tasks/`, `.memory/`, `.transcripts/`, `.task_outputs/`, `.mailboxes/`, `.worktrees/`, `.scheduled_tasks.json`. Override the root with the `AGENT_WORKSPACE` env var (the E2E tests use it to isolate side effects into a temp dir).

## Quick start

```bash
npm install

# run any chapter (mock by default, zero config)
npm run s01
npm run s02
npm run s20

# engineering harness (real tools: bash / file read-write)
npm run harness

# type check
npm run typecheck

# shared module tests
npm test

# full 20-chapter re-run (child processes, forced mock, no network)
npm run test:e2e
```

All chapters use mock/scripted handlers by default and do not require a real LLM API key — and they make no network calls. It is recommended to understand the loop, effect, handler, and state boundaries before connecting a real model.

### Real model (optional)

The default target is **DeepSeek**'s Anthropic-compatible endpoint. To enable it:

```bash
cp .env.example .env
# set ANTHROPIC_AUTH_TOKEN (your DeepSeek API key) in .env
# MODEL_ID defaults to deepseek-chat; deepseek-reasoner is also available

npm run s01 -- --real     # real mode for a single chapter
npm run harness:real      # engineering harness: real model + real bash/file tools
```

Key points:

- **Mock by default**: only `--real` or `AGENT_MODE=real` triggers a model request; if no token is configured it warns and falls back to mock instead of failing.
- In a chapter's real mode the **LLM call is real, but tool handling stays with the chapter's teaching handler**; for fully real tool execution use `npm run harness:real`.
- To switch providers (GLM / Kimi / Anthropic), just change `ANTHROPIC_BASE_URL` + `MODEL_ID` in `.env`; examples are in `.env.example`.
- `.env` is git-ignored — **never commit keys**.

## Recommended learning approach

1. Start with `s01_agent_loop`, run the code, then read the README.
2. Ask one question per chapter: what capability does this chapter add to the harness?
3. Find the new Effect, Handler, and State in `agent.ts`.
4. After several chapters, read the shared implementation in `src/modules`.
5. Finally read `s20_comprehensive` to see how the mechanisms return to a single loop.

For more details, see:

- [docs/en/algebraic-effects-primer.md](docs/en/algebraic-effects-primer.md)
- [docs/en/learn-shareai-crosswalk.md](docs/en/learn-shareai-crosswalk.md)
- [docs/en/first-principles.md](docs/en/first-principles.md)
- [docs/en/chapter-map.md](docs/en/chapter-map.md)
- [docs/en/study-workflow.md](docs/en/study-workflow.md)

## Acknowledgments

This project is inspired by [shareai-lab/learn-claude-code](https://github.com/shareai-lab/learn-claude-code) and re-expresses the core ideas in TypeScript and Algebraic Effects.

The original project Chinese site is [learn.shareai.run/zh](https://learn.shareai.run/zh/).
