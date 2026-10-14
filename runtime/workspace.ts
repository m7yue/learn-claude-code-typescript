/**
 * 工作区路径助手 —— 全仓这些路径都在这里统一定义。
 *
 * 各章以工作区根目录为基准，把状态写到其下的隐藏路径，而不是系统临时目录：
 *   .tasks/            —— 任务持久化（s12/s14/s16/s17/s20）
 *   .memory/           —— 记忆文件与 MEMORY.md 索引（s09）
 *   .transcripts/      —— 会话 transcript（s08）
 *   .task_outputs/     —— 工具结果写入磁盘（s08，tool-results/*.txt）
 *   .mailboxes/        —— 队友信箱 *.jsonl（s15/s16/s17/s20）
 *   .worktrees/        —— worktree 事件日志 events.jsonl（s18）
 *   .scheduled_tasks.json —— durable cron 任务（s14）
 *
 * 这些都是工作区相对路径，机制产生的文件在学习者选定的工作目录里可见。
 *
 * 环境变量 AGENT_WORKSPACE 可覆盖根目录：e2e 测试用它把副作用隔离到临时目录，
 * 避免污染仓库；默认使用当前工作目录。
 */

import * as path from "node:path";

/** 工作区根目录：默认 process.cwd()，可用 AGENT_WORKSPACE 覆盖。 */
export const WORKSPACE_ROOT: string = process.env.AGENT_WORKSPACE
  ? path.resolve(process.env.AGENT_WORKSPACE)
  : process.cwd();

export const TASKS_DIR: string = path.join(WORKSPACE_ROOT, ".tasks");
export const MEMORY_DIR: string = path.join(WORKSPACE_ROOT, ".memory");
export const MEMORY_INDEX_PATH: string = path.join(MEMORY_DIR, "MEMORY.md");
export const TRANSCRIPTS_DIR: string = path.join(WORKSPACE_ROOT, ".transcripts");
export const TASK_OUTPUTS_DIR: string = path.join(WORKSPACE_ROOT, ".task_outputs");
export const TOOL_RESULTS_DIR: string = path.join(TASK_OUTPUTS_DIR, "tool-results");
export const MAILBOXES_DIR: string = path.join(WORKSPACE_ROOT, ".mailboxes");
export const WORKTREES_DIR: string = path.join(WORKSPACE_ROOT, ".worktrees");
export const WORKTREE_EVENTS_PATH: string = path.join(WORKTREES_DIR, "events.jsonl");
export const SCHEDULED_TASKS_PATH: string = path.join(WORKSPACE_ROOT, ".scheduled_tasks.json");
