# Crosswalk with Learn Claude Code

It is recommended to treat this repository as a TypeScript + Algebraic Effects companion to [Learn Claude Code](https://learn.shareai.run/zh/) rather than as a replacement.

The original site provides the main narrative: why a chapter exists and where it fits in the Claude Code harness. This repository provides the TypeScript version: if that chapter is expressed with Effects, Handlers, and State, what does the code look like?

## Recommended study rhythm

Read each chapter in this order:

1. Read the corresponding chapter on Learn Claude Code to understand the original problem and engineering motivation.
2. Read the corresponding `sXX/README.md` in this repository to see the first-principles and algebraic effects explanation.
3. Run the corresponding script in this repository, for example `npm run s01`.
4. Read the corresponding `agent.ts`, find that chapter's new Effect, Handler, and State.
5. After finishing a group of chapters, read the shared implementation in `src/core` or `src/modules`.

## Chapter correspondence

The official site now shows **20 chapters across 5 concern groups**, and it lines up **almost one-to-one** with this repository's `s01`–`s20` (same numbers, same order). You can pair chapters directly by number:

| Official concern | Official chapter | This repo chapter |
| --- | --- | --- |
| Tools & Execution | s01 Agent Loop | [s01_agent_loop](../../s01_agent_loop/) |
| | s02 Tool Use | [s02_tool_use](../../s02_tool_use/) |
| | s03 Permission | [s03_permission](../../s03_permission/) |
| | s04 Hooks | [s04_hooks](../../s04_hooks/) |
| Planning & Control | s05 TodoWrite | [s05_todo_write](../../s05_todo_write/) |
| | s06 Subagent | [s06_subagent](../../s06_subagent/) |
| | s07 Skill Loading | [s07_skill_loading](../../s07_skill_loading/) |
| | s10 System Prompt | [s10_system_prompt](../../s10_system_prompt/) |
| | s11 Error Recovery | [s11_error_recovery](../../s11_error_recovery/) |
| Memory | s08 Context Compact | [s08_context_compact](../../s08_context_compact/) |
| | s09 Memory | [s09_memory](../../s09_memory/) |
| Concurrency & Scheduling | s13 Background Tasks | [s13_background_tasks](../../s13_background_tasks/) |
| | s14 Cron Scheduler | [s14_cron_scheduler](../../s14_cron_scheduler/) |
| Multi-Agent Platform | s12 Task System | [s12_task_system](../../s12_task_system/) |
| | s15 Agent Teams | [s15_agent_teams](../../s15_agent_teams/) |
| | s16 Team Protocols | [s16_team_protocols](../../s16_team_protocols/) |
| | s17 Autonomous Agents | [s17_autonomous_agents](../../s17_autonomous_agents/) |
| | s18 Worktree Isolation | [s18_worktree_isolation](../../s18_worktree_isolation/) |
| | s19 MCP Tools | [s19_mcp_plugin](../../s19_mcp_plugin/) |
| | s20 Comprehensive Agent | [s20_comprehensive](../../s20_comprehensive/) |

Only two names differ slightly (same content):

| Official name | This repo directory |
| --- | --- |
| MCP Tools | `s19_mcp_plugin` |
| Comprehensive Agent | `s20_comprehensive` |

## About chapter order

This repository's folder order matches the official site's 20-chapter order: both run s01–s20, with Permission/Hooks at `s03`/`s04` and TodoWrite at `s05`. So there is **no need to map between chapter numbers**; just read by number.

## Want to run a real model?

By default this repository uses each chapter's own mock/scripted handlers, so it runs with zero configuration. To plug in a real model (DeepSeek by default), see the "Real model (optional)" section in the root `README.en.md`.
