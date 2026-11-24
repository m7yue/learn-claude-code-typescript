# learn-claude-code-typescript

English | [中文]

[English]: ./README.en.md
[中文]: ./README.md

[![CI](https://github.com/m7yue/learn-claude-code-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/m7yue/learn-claude-code-typescript/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A reference implementation of an Agent harness built from scratch in TypeScript with algebraic effects: chapters `s01`–`s20` progressively implement the agent loop, tool calls, permissions, hooks, todos, subagents, context compaction, memory, the task system, teams, MCP, and other mechanisms; `src/core` + `src/modules` distill the reusable parts into an engineering module layer shared by the CLI and the evals; the repository is backed by a full-repo typecheck, 26 test files, a 20-chapter end-to-end regression, and a self-checked eval system (`evals/`).

The chapter organization follows [Learn Claude Code](https://github.com/shareai-lab/learn-claude-code) as inspiration; the implementation is an independent TypeScript rewrite — not a port of that course, and not a reproduction of Claude Code. All chapters run offline in mock mode by default, with no API key; which side effects become real once a model is attached (bash, files, git), and which stay simulated for teaching, is documented in the boundary notes of the "Real model" section.

If you are not yet familiar with algebraic effects, you can think of it this way:

```txt
Agent logic declares "what I want to do", and the runtime decides "how to do it".
```

A more complete introduction is in [docs/en/algebraic-effects-primer.md](docs/en/algebraic-effects-primer.md).

## Why this project exists

The motivation for this project is simple: many frontend engineers already use tools such as Claude Code, Cursor, and Codex, but it is not easy to truly understand the harness engineering behind them.

The original Learn Claude Code used Python to demonstrate these mechanisms. I re-implemented them in TypeScript, which frontend engineers are more familiar with, and restated them using first principles and algebraic effects:

```txt
Agent = model agency + harness
Harness = loop + tools + permissions + context + memory + state + protocols
```

The model is responsible for generating intentions, while the harness is responsible for interpreting intentions, executing side effects, injecting results, maintaining boundaries, and preserving state. The part that engineers can really design is mainly the harness.

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

## Capability matrix: 20 chapters at a glance

The recommended way is to study alongside [Learn Claude Code](https://learn.shareai.run/zh/): first read the corresponding chapter on the original site to understand the motivation, then return to this repository to see the TypeScript + Algebraic Effects version.

The official site now shows **20 chapters across 5 concern groups** and maps **roughly 1:1** onto this repository's `s01`–`s20` (same numbers, same order), so you can pair chapters directly by number. See [docs/en/learn-shareai-crosswalk.md](docs/en/learn-shareai-crosswalk.md) for details.

The main line is `s01_agent_loop/` through `s20_comprehensive/`. Each chapter includes:

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
| [s09](s09_memory/) | Memory | `ReadMemory`, `WriteMemory`, `SelectMemory`, `ExtractMemories`, `ConsolidateMemories` |

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
| [s19](s19_mcp_plugin/) | MCP Tools | `MCPConnect`, `AssembleToolPool` (host, pre-loop), `MCPToolCall` (model-triggered) |
| [s20](s20_comprehensive/) | Comprehensive Agent | all previous mechanisms |

## Two-layer architecture and project structure

```txt
learn-claude-code-typescript/
├── runtime/
│   ├── core.ts              # minimal algebraic effects runtime used by the chapters
│   ├── types.ts             # shared types for the chapters
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
│   ├── harness-agent.ts     # reusable harness assembly shared by the CLI and evals
│   └── harness.ts           # runnable engineering starting point (real tools + optional real model)
├── evals/                   # capability evals for the engineering harness (tasks + judges + report)
├── docs/                    # study map, first principles, learning workflow
├── tests/                   # shared module behavior tests + full 20-chapter re-run
└── .env.example             # real-mode config template (DeepSeek by default)
```

The tree lists only the main files: `runtime/` actually contains 18 source files, and `s20_comprehensive/` splits its mechanisms into separate modules. The engineering layer consists of 7 files in `src/core` (agent loop, effect system, ScriptedModel, AnthropicModel, tool specs, etc.) plus 22 reusable modules in `src/modules`; `src/harness-agent.ts` is the single assembly shared by the CLI (`src/harness.ts`) and `evals/`, so the two cannot drift apart.

There are two layers of code:

- `runtime/` + `sXX/` is the main teaching code, emphasizing chapter-by-chapter progression and readability.
- `src/core` + `src/modules` is the engineering reference layer, emphasizing reuse, testing, and migration to real projects.

These two layers are not competing implementations. The teaching chapters intentionally keep some repetition so learners can see a complete closed loop in one file; the engineering layer abstracts repeatable patterns for real project migration.

Chapter runtime state (tasks, memory, mailboxes, cron, worktree events) is written under the **current working directory** in hidden paths: `.tasks/`, `.memory/`, `.transcripts/`, `.task_outputs/`, `.mailboxes/`, `.worktrees/`, `.scheduled_tasks.json`. Override the root with the `AGENT_WORKSPACE` env var (the E2E tests use it to isolate side effects into a temp dir).

## Quality assurance

Every change goes through a fixed acceptance pipeline, fully offline and without any API key:

| Layer | Command | Coverage |
| --- | --- | --- |
| Type check | `npm run typecheck` | full-repo `tsc --noEmit` with `strict` on |
| Unit tests | `npm test` | 26 test files (~2,900 lines): runtime shared code, src engineering modules, and the evals harness itself |
| E2E regression | `npm run test:e2e` | every chapter re-run as an isolated child process: forced mock, side effects quarantined into temp dirs, no network |
| Eval self-check | `npm run eval:check` | the eval harness's own correctness: correct turns must all pass, wrong turns must fail at least one required check |

Type check, unit tests, the E2E regression, and the eval self-check run in GitHub Actions on every push (see the badge at the top).

`evals/` is the eval system for the engineering harness: 3 fixed tasks (read a file and answer, fix a real code defect, permission boundaries), 6 programmatic check types (file content, file hash, command exit code, final answer, tool-call counts, etc.), two judges (keyword and LLM), reporting success rate, tokens, latency, and `report.md`. Its known limits are documented too: the tasks cover basic tools, permissions, and answers — not todos, teams, cron, or worktrees; real models are stochastic, so small samples show trends only. The usage manual is [evals/README.md](evals/README.md); for how each step works in the code and why it is designed that way, see [evals/EXPLAINED.md](evals/EXPLAINED.md).

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

# engineering-harness evals (mock; verifies the eval pipeline itself)
npm run eval

# eval self-check: correct must pass, wrong must fail at least one required check
npm run eval:check
```

All chapters use mock/scripted handlers by default and do not require a real LLM API key — and they make no network calls. It is recommended to understand the loop, effect, handler, and state boundaries before connecting a real model.

### Evals (optional)

`evals/` measures the **engineering harness** (`src/harness-agent.ts`), not the 20 chapters: three fixed tasks, programmatic checks plus a judge, success rate/tokens/latency, and a `report.md`. Changes to chapters still go through `npm test` + `npm run test:e2e`. See [evals/README.md](evals/README.md).

### Real model (optional)

The default target is **DeepSeek**'s Anthropic-compatible endpoint. To enable it:

```bash
cp .env.example .env
# set ANTHROPIC_AUTH_TOKEN (your DeepSeek API key) in .env
# MODEL_ID defaults to deepseek-chat; deepseek-reasoner is also available

npm run s01 -- --real     # real mode for a single chapter
npm run harness:real      # engineering harness: real model + real bash/file tools
npm run eval:real         # engineering-harness evals: real model, 3 tasks × 3 trials
```

Key points:

- **Mock by default**: only `--real` or `AGENT_MODE=real` triggers a model request; if no token is configured it warns and falls back to mock instead of failing.
- In a chapter's real mode the **LLM call is real**; whether a tool actually runs depends on that chapter's handler — bash is really executed in s01/s03/s06/s08/s09/s12/s18/s20 and simulated in the rest (those chapters tell the model so in their system prompt, so it doesn't spin). For a fully real tool set (bash + read/write + glob) use `npm run harness:real`.
- To switch providers (GLM / Kimi / Anthropic), just change `ANTHROPIC_BASE_URL` + `MODEL_ID` in `.env`; examples are in `.env.example`.
- `.env` is git-ignored — **never commit keys**.

## Recommended reading approach

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

## Working with AI

This project was built in collaboration with AI, with a fixed division of labor:

- I was responsible for: abstraction design and mechanism trade-offs (which Effect / Handler / State each chapter introduces, how the two code layers are split), correctness acceptance (the expected behavior of every mechanism was defined and checked by me), test and eval design (which chapters the regression covers, how eval tasks and their pass conditions are determined), and the structure and wording of the documentation.
- AI was responsible for: executing code conversion, chapter drafts, refactoring suggestions, and first drafts of the documents.

This division of labor also explains the share that tests and evals take in this repository: AI-assisted code only counts as done after passing the same type check, unit tests, and end-to-end regression.

## Acknowledgments

Chapter topics and overall structure follow [shareai-lab/learn-claude-code](https://github.com/shareai-lab/learn-claude-code), an open-source Python course (Chinese site: [learn.shareai.run/zh](https://learn.shareai.run/zh/)). The implementation is independent: the TypeScript code was written from scratch, and the `src/` engineering layer, the tests, and the eval system are additions of this project — it is not a port of that course.

This project is released under the MIT license; see [LICENSE](LICENSE).
