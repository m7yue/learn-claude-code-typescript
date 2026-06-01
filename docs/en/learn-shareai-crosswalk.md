# Crosswalk with Learn Claude Code

It is recommended to treat this repository as a TypeScript + Algebraic Effects companion to [Learn Claude Code](https://learn.shareai.run/zh/) rather than as a replacement.

The original site provides the main narrative: why a chapter exists and where it fits in the Claude Code harness. This repository provides the TypeScript version: if that chapter is expressed with Effects, Handlers, and State, what does the code look like?

## Recommended study rhythm

Read each chapter in this order:

1. Read the corresponding chapter on Learn Claude Code to understand the original problem and engineering motivation.
2. Read the corresponding `sXX/README.md` in this repository to see the first-principles and algebraic effects explanation.
3. Run the corresponding script in this repository, for example `npm run s01`.
4. Read the corresponding `agent.ts`, find that chapter’s new Effect, Handler, and State.
5. After finishing a group of chapters, read the shared implementation in `src/core` or `src/modules`.

## Chapter correspondence

The Learn Claude Code site currently shows 19 chapters in 4 stages. This repository preserves 20 local learning entries, with `s20_comprehensive` serving as the comprehensive review chapter.

| Chinese site chapter | Chinese site theme | This repo chapter | Notes |
| --- | --- | --- | --- |
| s01 | Agent loop | `s01_agent_loop` | minimal loop: model, tool, result feedback |
| s02 | Tool use | `s02_tool_use` | tool pool and tool routing |
| s03 | Todo writing | `s05_todo_write` | this repo places Permission / Hooks before Todo |
| s04 | Subagent | `s06_subagent` | independent context and summary return |
| s05 | Skill system | `s07_skill_loading` | load knowledge on demand |
| s06 | Context compression | `s08_context_compact` | context budget and compression strategy |
| s07 | Permission system | `s03_permission` | safety boundary before tool execution |
| s08 | Hook system | `s04_hooks` | pre-tool, post-tool, and stop extension points |
| s09 | Memory system | `s09_memory` | cross-session long-term memory |
| s10 | System prompts | `s10_system_prompt` | runtime prompt assembly |
| s11 | Error recovery | `s11_error_recovery` | error classification, retry, fallback |
| s12 | Task system | `s12_task_system` | persistent task control plane |
| s13 | Background tasks | `s13_background_tasks` | async tasks and notification feedback |
| s14 | Timed scheduling | `s14_cron_scheduler` | time-triggered tasks |
| s15 | Agent team | `s15_agent_teams` | multi-Agent identity and messaging |
| s16 | Team protocols | `s16_team_protocols` | request-response collaboration protocols |
| s17 | Autonomous agents | `s17_autonomous_agents` | idle workers autonomously claim tasks |
| s18 | Worktree isolation | `s18_worktree_isolation` | task and execution directory isolation |
| s19 | MCP and plugin | `s19_mcp_plugin` | standard external tool integration |
| - | Comprehensive review | `s20_comprehensive` | this repo’s extra wrap-up chapter |

## Why the order differs slightly

This repository was initially organized with a teaching rhythm of “add one Effect type per chapter,” so Permission and Hooks were placed at `s03` and `s04`, while TodoWrite became `s05`.

The Chinese site currently emphasizes reading from core loop to system hardening, so Todo, Subagent, Skill, and Compact come before Permission / Hooks.

Both orders are valid. The recommendation is to build overall understanding from the Chinese site order and then use this table to jump to the corresponding chapter in this repository.
