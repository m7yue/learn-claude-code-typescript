/**
 * s20 的全部 Effect 类型 —— 只描述“要做什么”，不包含实现。
 * 具体副作用在 handlers.ts，主循环在 lead-loop.ts / team.ts。
 */

import type { Effect } from '../runtime/core.ts';
import type { ToolSchema } from '../runtime/model.ts';
import type { LLMResponse, Message, TaskRecord, ToolUseBlock } from '../runtime/types.ts';
import type { AgentMessage } from './mailbox.ts';
import type { TodoItem } from './knowledge.ts';
import type { CronJob } from './cron.ts';
import type { ClaimResult, CompleteResult, WorktreeTask } from './tasks.ts';

export interface ChatEffect
  extends Effect<
    'Chat',
    { messages: Message[]; agentId: string; system: string; tools: ToolSchema[]; model?: string; maxTokens?: number },
    LLMResponse
  > {}

export interface PromptContext {
  memories: string;
  connectedMcp: string[];
  activeTeammates: string[];
}
export interface AssemblePromptEffect extends Effect<'AssemblePrompt', { context: PromptContext }, string> {}
export interface AssembleToolPoolEffect extends Effect<'AssembleToolPool', Record<string, never>, ToolSchema[]> {}

export interface PrepareContextEffect
  extends Effect<'PrepareContext', { messages: Message[]; force?: boolean; reactive?: boolean; reason?: string }, Message[]> {}
export interface PersistOutputEffect extends Effect<'PersistOutput', { toolUseId: string; content: string }, string> {}

export interface BashExecEffect extends Effect<'BashExec', { command: string; worktreeId?: string }, string> {}
export interface ReadFileEffect extends Effect<'ReadFile', { path: string; limit?: number }, string> {}
export interface WriteFileEffect extends Effect<'WriteFile', { path: string; content: string; worktreeId?: string }, string> {}
export interface EditFileEffect extends Effect<'EditFile', { path: string; oldText: string; newText: string }, string> {}
export interface GlobSearchEffect extends Effect<'GlobSearch', { pattern: string }, string> {}

export interface TodoWriteEffect extends Effect<'TodoWrite', { todos: TodoItem[] }, string> {}

export interface SpawnSubagentEffect extends Effect<'SpawnSubagent', { description: string }, string> {}
export interface LoadSkillEffect extends Effect<'LoadSkill', { name: string }, string> {}

export interface ReadMemoryEffect extends Effect<'ReadMemory', { query?: string; filename?: string }, string> {}
export interface WriteMemoryEffect extends Effect<'WriteMemory', { key: string; content: string }, string> {}

export interface CreateTaskEffect
  extends Effect<
    'CreateTask',
    { subject: string; description?: string; blockedBy?: string[]; preferredOwner?: string },
    TaskRecord
  > {}
export interface ListTasksEffect extends Effect<'ListTasks', Record<string, never>, TaskRecord[]> {}
export interface GetTaskEffect extends Effect<'GetTask', { taskId: string }, string> {}
export interface ClaimTaskEffect extends Effect<'ClaimTask', { taskId: string; owner: string }, ClaimResult> {}
export interface CompleteTaskEffect extends Effect<'CompleteTask', { taskId: string; owner: string }, CompleteResult> {}

export interface IdleOutcome {
  state: 'work' | 'shutdown' | 'timeout';
  trigger?: 'inbox' | 'claimed' | 'timeout';
  inbox?: AgentMessage[];
  task?: WorktreeTask;
}
export interface IdlePollEffect
  extends Effect<'IdlePoll', { agentId: string; pollIntervalMs?: number; autoClaim?: boolean }, IdleOutcome> {}

export interface StartBackgroundEffect extends Effect<'StartBackground', { block: ToolUseBlock }, { bgId: string }> {}
export interface CollectBackgroundResultsEffect
  extends Effect<'CollectBackgroundResults', { wait?: boolean }, string[]> {}

export interface ScheduleCronEffect
  extends Effect<
    'ScheduleCron',
    { cronId: string; cron: string; prompt: string; recurring?: boolean; durable?: boolean },
    CronJob
  > {}
export interface ListCronsEffect extends Effect<'ListCrons', Record<string, never>, CronJob[]> {}
export interface CancelCronEffect extends Effect<'CancelCron', { cronId: string }, { cancelled: boolean; cronId: string }> {}

export interface SpawnTeammateEffect
  extends Effect<'SpawnTeammate', { agentId: string; role: string }, { agentId: string; status: 'spawned' }> {}
export interface SendMessageEffect
  extends Effect<
    'SendMessage',
    { from: string; to: string; body: string; type?: string; metadata?: Record<string, unknown> },
    { messageId: string }
  > {}
export interface CheckInboxResult {
  /** 只含普通消息（以及 lead 需要看到的 plan_approval_request）。 */
  messages: AgentMessage[];
  /** 读到并回复了 shutdown_request；调用方应结束当前 agent 的循环。 */
  shutdown: boolean;
}
export interface CheckInboxEffect
  extends Effect<
    'CheckInbox',
    { agentId: string; expectType?: string; waitMs?: number; drain?: boolean },
    CheckInboxResult
  > {}

export interface SubmitPlanEffect extends Effect<'SubmitPlan', { from: string; plan: string }, { requestId: string }> {}
export interface GateOutcome {
  kind: 'approved' | 'rejected' | 'shutdown' | 'timeout';
  feedback?: string;
}
export interface WaitForPlanResponseEffect
  extends Effect<'WaitForPlanResponse', { agentId: string; requestId: string }, GateOutcome> {}

export interface Plan {
  requestId: string;
  goal: string;
  steps: string[];
  status: 'pending' | 'approved' | 'rejected';
  feedback: string;
}
export interface RequestPlanEffect extends Effect<'RequestPlan', { goal: string; requestId?: string; context?: string }, Plan> {}
export interface ReviewPlanEffect
  extends Effect<'ReviewPlan', { requestId: string; reviewerId: string; planText?: string }, { ok: boolean; approved: boolean; error?: string }> {}
export interface RequestShutdownEffect
  extends Effect<'RequestShutdown', { agentId: string; reason?: string }, { acknowledged: boolean; requestId: string; responder: string }> {}

export interface CreateWorktreeEffect
  extends Effect<'CreateWorktree', { worktreeId: string; taskId?: string }, { ok: boolean; worktreeId: string; path?: string; reason?: string }> {}
export interface RemoveWorktreeEffect
  extends Effect<'RemoveWorktree', { worktreeId: string; discardChanges?: boolean }, { removed: boolean; reason?: string }> {}
export interface KeepWorktreeEffect
  extends Effect<'KeepWorktree', { worktreeId: string }, { kept: boolean; reason?: string }> {}

export interface MCPConnectEffect
  extends Effect<'MCPConnect', { serverId: string }, { serverId: string; toolNames: string[] }> {}
export interface MCPToolCallEffect
  extends Effect<'MCPToolCall', { serverId: string; toolName: string; args: Record<string, unknown> }, string> {}

export interface RetryWithBackoffEffect
  extends Effect<'RetryWithBackoff', { attempt: number; errorType: '429' | '529'; retryAfterMs?: number }, void> {}
export interface SwitchModelEffect extends Effect<'SwitchModel', { reason: string; fromModel: string }, string> {}

export type S20Effect =
  | ChatEffect
  | AssemblePromptEffect
  | AssembleToolPoolEffect
  | PrepareContextEffect
  | PersistOutputEffect
  | BashExecEffect
  | ReadFileEffect
  | WriteFileEffect
  | EditFileEffect
  | GlobSearchEffect
  | TodoWriteEffect
  | SpawnSubagentEffect
  | LoadSkillEffect
  | ReadMemoryEffect
  | WriteMemoryEffect
  | CreateTaskEffect
  | ListTasksEffect
  | GetTaskEffect
  | ClaimTaskEffect
  | CompleteTaskEffect
  | IdlePollEffect
  | StartBackgroundEffect
  | CollectBackgroundResultsEffect
  | ScheduleCronEffect
  | ListCronsEffect
  | CancelCronEffect
  | SpawnTeammateEffect
  | SendMessageEffect
  | CheckInboxEffect
  | SubmitPlanEffect
  | WaitForPlanResponseEffect
  | RequestPlanEffect
  | ReviewPlanEffect
  | RequestShutdownEffect
  | CreateWorktreeEffect
  | RemoveWorktreeEffect
  | KeepWorktreeEffect
  | MCPConnectEffect
  | MCPToolCallEffect
  | RetryWithBackoffEffect
  | SwitchModelEffect;
