# 20-Chapter Course Map

This repository preserves the original 20-chapter progression of Learn Claude Code and re-expresses it in TypeScript + Algebraic Effects. `sXX/agent.ts` is the main learning entry, and `src/modules` is the reusable mechanism reference implementation.

| Chapter | Theme | Harness Mechanism | Engineering Reference |
| --- | --- | --- | --- |
| s01 | Agent Loop | model decision, tool result feedback | `src/core/agent.ts`, `src/core/effects.ts` |
| s02 | Tool Use | tool pool, tool dispatch | `src/modules/tools.ts` |
| s03 | Permission | allow / ask / deny permission boundary | `src/modules/permission.ts` |
| s04 | Hooks | PreToolUse / PostToolUse / Stop extension points | `src/modules/hooks.ts` |
| s05 | TodoWrite | externalized short-term planning | `src/modules/todos.ts` |
| s06 | Subagent | independent context and summary return | `DelegateEffect` in `src/core/agent.ts` |
| s07 | Skill Loading | load capability descriptions on demand | `src/modules/skills.ts` |
| s08 | Context Compact | context compression and result downsampling | `src/modules/compact.ts` |
| s09 | Memory | cross-session long-term memory | `src/modules/memory.ts` |
| s10 | System Prompt | runtime prompt assembly | `src/modules/prompt.ts` |
| s11 | Error Recovery | error classification, retry, fallback | `src/modules/recovery.ts` |
| s12 | Task System | persistent task control plane | `src/modules/tasks.ts`, `src/modules/task-tools.ts` |
| s13 | Background Tasks | asynchronous tasks and notification feedback | `src/modules/background.ts` |
| s14 | Cron Scheduler | time-triggered work | `src/modules/cron.ts` |
| s15 | Agent Teams | persistent identity and JSONL inbox | `src/modules/team.ts` |
| s16 | Team Protocols | request-response collaboration protocol | `src/modules/protocol.ts` |
| s17 | Autonomous Agents | idle workers autonomously claim tasks | `src/modules/autonomous.ts` |
| s18 | Worktree Isolation | task and execution directory isolation | `src/modules/worktrees.ts` |
| s19 | MCP Plugin | standard integration of external tools | `src/modules/mcp.ts` |
| s20 | Comprehensive | all mechanisms returning to one loop | `src/modules/comprehensive.ts` |

## The relationship between the two code layers

`sXX/agent.ts` is intended for teaching, so each chapter often redefines that chapter's Effects, Handlers, and Agent Generator. This repetition is intentional: learners can see a complete mechanism loop in a single file.

`src/core` and `src/modules` are meant for engineering understanding. They extract repeated patterns and show how to organize boundaries for a real TypeScript project.

It is recommended to read the chapter first and then follow the shared modules. Otherwise, it is easy to see abstractions before you know which chapter problems they solve.
