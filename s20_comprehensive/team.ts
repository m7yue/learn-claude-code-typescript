/**
 * s20 的队友与子代理循环 —— 独立 generator，由 runAgent 驱动。
 * activeTeammates / teammateFailures / hostStopping 是宿主侧的共享状态。
 */

import type { PerformFn } from '../runtime/core.ts';
import { classifyError } from '../runtime/errors.ts';
import { buildSystemPrompt } from '../runtime/system-prompt.ts';
import { extractText, getToolUseBlocks, toolErrorResult } from '../runtime/response.ts';
import { CONTINUATION_PROMPT } from '../runtime/recovery.ts';
import type { Message, ToolResultBlock } from '../runtime/types.ts';
import {
  DEFAULT_MAX_TOKENS,
  IDLE_POLL_INTERVAL_MS,
  LEAD_ID,
  MAX_CHAT_RETRIES,
  MAX_REACTIVE_COMPACTIONS,
  MAX_SUBAGENT_TURNS,
  MAX_TEAMMATE_TURNS,
  SUBAGENT_ID,
} from './config.ts';
import { microCompact, snipCompact } from './context.ts';
import { BUS, type AgentMessage } from './mailbox.ts';
import { RecoveryState, readRetryAfterMs } from './recovery.ts';
import { SUBAGENT_TOOLS, TEAMMATE_TOOLS } from './tools.ts';
import { formatTaskList } from './tasks.ts';
import type { ChatEffect, S20Effect } from './effects.ts';

export const activeTeammates = new Map<string, Promise<string>>();
// 队友失败会影响退出码；不要让 lead 的最终文本掩盖队友异常。
export const teammateFailures = new Set<string>();
export let hostStopping = false;

/** 标记宿主收尾，并让仍在等待的队友立即返回；正常路径由 shutdown 协议结束。 */
export function stopTeammates(): void {
  hostStopping = true;
  for (const agentId of activeTeammates.keys()) BUS.completeWait(agentId);
}

function teammateSystemPrompt(agentId: string, role: string): string {
  return `你是 '${agentId}'，一名${role}。收到 lead（信箱 '${LEAD_ID}'）的计划请求后，直接用 submit_plan 提交计划（这会关闭审批闸门，直到 lead 返回 plan_approval_response）；计划要写成编号步骤（1. 2. 3. ...），不要先用 bash 或 read_file 探索。计划未批准（rejected/超时）时不要执行 bash、写文件或任务操作，修改后重新提交。收到 shutdown_request 时优雅退出。`;
}

/**
 * 带错误恢复的 Chat：429/529 退避重试，prompt_too_long 做一次反应式裁剪。
 *
 * lead 的恢复逻辑在 lead-loop.ts；队友和子代理不能让一次瞬时错误直接退出，
 * 否则整次运行会被 teammateFailures 标记为失败。恢复动作仍然通过 Effect 完成。
 */
function* chatWithRecovery(
  perform: PerformFn<S20Effect>,
  input: ChatEffect['input'],
  messages: Message[],
) {
  let retries = 0;
  let compactions = 0;
  const state = new RecoveryState();
  let maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  // 队友/子代理也走同一套上下文裁剪；它们没有 lead 的落盘管线，只做纯函数部分。
  messages.splice(0, messages.length, ...microCompact(snipCompact(messages)));

  while (true) {
    try {
      const response = yield* perform({
        type: 'Chat',
        input: { ...input, messages, maxTokens },
      });
      if (response.stop_reason === 'max_tokens') {
        const decision = state.onMaxTokens();
        if (decision.action === 'escalate') {
          maxTokens = state.maxTokens;
          continue;
        }
        messages.push({ role: 'assistant', content: response.content });
        if (decision.action === 'continue') {
          messages.push({ role: 'user', content: CONTINUATION_PROMPT });
          continue;
        }
        // 不把半截计划/摘要当成最终答案。
        throw new Error('max_tokens recovery limit reached');
      }
      return response;
    } catch (error: unknown) {
      const kind = classifyError(error);
      if (kind === 'rate_limit' || kind === 'overloaded') {
        if (retries >= MAX_CHAT_RETRIES) throw error;
        yield* perform({
          type: 'RetryWithBackoff',
          input: {
            attempt: retries,
            errorType: kind === 'rate_limit' ? '429' : '529',
            retryAfterMs: readRetryAfterMs(error),
          },
        });
        retries += 1;
        continue;
      }
      if (kind === 'prompt_too_long' && compactions < MAX_REACTIVE_COMPACTIONS) {
        const compacted = yield* perform({
          type: 'PrepareContext',
          input: { messages, reactive: true },
        });
        messages.splice(0, messages.length, ...compacted);
        compactions += 1;
        continue;
      }
      throw error;
    }
  }
}

export function* teammateLoop(perform: PerformFn<S20Effect>, agentId: string, role: string) {
  const messages: Message[] = [
    {
      role: 'user',
      content: `你是团队成员 '${agentId}'（${role}）。等待 lead（信箱 '${LEAD_ID}'）通过信箱派发任务：先提交计划等待审批，批准后执行任务，最后等待关闭。`,
    },
  ];
  let phase: 'await' | 'work' | 'done' = 'await';
  let workTurns = 0;
  let finalText = '';
  // 计划批准前只允许读、沟通和重新提交计划；工作类工具会被拒绝。
  let planApproved = false;
  const WORK_TOOLS = new Set(['bash', 'write_file', 'claim_task', 'complete_task']);

  const finish = function* (why: string): Generator<S20Effect, string, { messageId: string }> {
    yield* perform({
      type: 'SendMessage',
      input: { from: agentId, to: LEAD_ID, body: finalText || why, type: 'result', metadata: {} },
    });
    console.log(`  \x1b[32m[teammate] ${agentId} finished (${why})\x1b[0m`);
    return finalText || why;
  };

  while (workTurns < MAX_TEAMMATE_TURNS) {
    if (hostStopping) return yield* finish('shutdown');
    if (phase === 'await' || phase === 'done') {
      const inboxResult = yield* perform({ type: 'CheckInbox', input: { agentId } });
      if (inboxResult.shutdown) return yield* finish('shutdown');
      const inbox = inboxResult.messages;
      let groomed: AgentMessage[] = inbox;
      let autoClaimed = false;
      if (inbox.length === 0) {
        const outcome = yield* perform({
          type: 'IdlePoll',
          input: {
            agentId,
            pollIntervalMs: IDLE_POLL_INTERVAL_MS,
            // 计划批准后才允许自主认领；批准前不能绕过审批直接开工。
            autoClaim: planApproved,
          },
        });
        if (outcome.state === 'shutdown') return yield* finish('shutdown');
        if (outcome.state === 'timeout') break;
        if (outcome.trigger === 'claimed' && outcome.task) {
          // 认领结果必须进入上下文，否则模型不知道自己刚接了什么任务。
          autoClaimed = true;
          messages.push({
            role: 'user',
            content: `<auto-claimed>${outcome.task.id}: ${outcome.task.subject}</auto-claimed>`,
          });
          phase = 'work';
          groomed = [];
        } else if (outcome.inbox && outcome.inbox.length > 0) {
          groomed = outcome.inbox;
        } else {
          groomed = [];
        }
      }
      if (groomed.length > 0) {
        messages.push({ role: 'user', content: `<inbox>${JSON.stringify(groomed)}</inbox>` });
        if (phase === 'done') phase = 'await';
      } else if (phase === 'done' && !autoClaimed) {
        continue; // 没有新消息，继续空闲等待
      }
    }

    workTurns += 1;
    const response = yield* chatWithRecovery(
      perform,
      { messages, agentId, system: teammateSystemPrompt(agentId, role), tools: TEAMMATE_TOOLS },
      messages,
    );
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      finalText = extractText(response);
      phase = 'done';
      continue;
    }

    // 模型决定继续调用工具：它正在处理本轮任务，下一步带着工具结果继续 Chat。
    phase = 'work';

    const toolResults: ToolResultBlock[] = [];
    let shutdownNow = false;
    let gateMessage: string | null = null;
    for (const block of getToolUseBlocks(response)) {
      try {
        if (block.name === 'submit_plan') {
          planApproved = false;
          const { requestId } = yield* perform({
            type: 'SubmitPlan',
            input: { from: agentId, plan: String(block.input['plan'] ?? '') },
          });
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Plan submitted (${requestId}); 等待审批中` });
          // 真的会在这里等：一直到 lead 返回匹配的 plan_approval_response 才继续
          const gate = yield* perform({ type: 'WaitForPlanResponse', input: { agentId, requestId } });
          if (gate.kind === 'shutdown') {
            shutdownNow = true;
            break;
          }
          planApproved = gate.kind === 'approved';
          gateMessage =
            gate.kind === 'approved'
              ? '[Plan approved] 继续执行。'
              : gate.kind === 'timeout'
                ? '[Plan approval timed out] 审批超时，计划未批准；请重新提交计划，不要执行工作。'
                : `[Plan rejected] ${gate.feedback ?? ''}；计划未批准，请修改后重新提交。`;
          phase = 'work';
          break; // 审批后的工具属于后续轮次，忽略本次响应里其余 block
        }
        if (!planApproved && WORK_TOOLS.has(block.name)) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: '[错误] 计划尚未批准，不能执行工作类工具。',
            is_error: true,
          });
          continue;
        }
        let output: string;
        switch (block.name) {
          case 'bash': {
            if (block.input['run_in_background'] === true) {
              output = '[错误] teammate 不支持 run_in_background；请在前台执行。';
              break;
            }
            const input: { command: string; worktreeId?: string } = {
              command: String(block.input['command'] ?? ''),
            };
            if (block.input['worktreeId'] !== undefined) {
              input.worktreeId = String(block.input['worktreeId']);
            }
            output = yield* perform({ type: 'BashExec', input });
            break;
          }
          case 'read_file': {
            const input: { path: string; limit?: number } = { path: String(block.input['path'] ?? '') };
            if (block.input['limit'] !== undefined) input.limit = Number(block.input['limit']);
            output = yield* perform({ type: 'ReadFile', input });
            break;
          }
          case 'write_file': {
            const input: { path: string; content: string; worktreeId?: string } = {
              path: String(block.input['path'] ?? ''),
              content: String(block.input['content'] ?? ''),
            };
            if (block.input['worktreeId'] !== undefined) {
              input.worktreeId = String(block.input['worktreeId']);
            }
            output = yield* perform({ type: 'WriteFile', input });
            break;
          }
          case 'send_message': {
            const { messageId } = yield* perform({
              type: 'SendMessage',
              input: { from: agentId, to: String(block.input['to'] ?? ''), body: String(block.input['body'] ?? '') },
            });
            output = `已发送 (${messageId})`;
            break;
          }
          case 'list_tasks': {
            const tasks = yield* perform({ type: 'ListTasks', input: {} });
            output = formatTaskList(tasks);
            break;
          }
          case 'claim_task': {
            const res = yield* perform({ type: 'ClaimTask', input: { taskId: String(block.input['taskId'] ?? ''), owner: agentId } });
            output = res.ok ? `Claimed ${res.task?.id}` : `[错误] ${res.error}`;
            break;
          }
          case 'complete_task': {
            const res = yield* perform({ type: 'CompleteTask', input: { taskId: String(block.input['taskId'] ?? ''), owner: agentId } });
            output = res.ok
              ? `Completed ${res.task?.id}${res.unblocked.length ? `; unblocked: ${res.unblocked.join(', ')}` : ''}`
              : `[错误] ${res.error}`;
            break;
          }
          default:
            output = `[未知工具] ${block.name}`;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: output });
      } catch (err) {
        toolResults.push(toolErrorResult(block.id, err));
      }
    }
    if (shutdownNow) return yield* finish('shutdown');
    if (toolResults.length > 0) messages.push({ role: 'user', content: toolResults });
    if (gateMessage) messages.push({ role: 'user', content: gateMessage });
  }
  return yield* finish('idle-exit');
}

export function* subagentLoop(perform: PerformFn<S20Effect>, description: string) {
  const messages: Message[] = [{ role: 'user', content: `子任务：${description}` }];
  for (let turn = 0; turn < MAX_SUBAGENT_TURNS; turn += 1) {
    const response = yield* chatWithRecovery(
      perform,
      {
        messages,
        agentId: SUBAGENT_ID,
        system: buildSystemPrompt('你是子代理，只返回最终摘要，不要冗长解释。'),
        tools: SUBAGENT_TOOLS,
      },
      messages,
    );
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason !== 'tool_use') return extractText(response);
    const toolResults: ToolResultBlock[] = [];
    for (const block of getToolUseBlocks(response)) {
      try {
        let output: string;
        switch (block.name) {
          case 'bash': {
            if (block.input['run_in_background'] === true) {
              output = '[错误] 子代理不支持 run_in_background；请在前台执行。';
              break;
            }
            const input: { command: string; worktreeId?: string } = {
              command: String(block.input['command'] ?? ''),
            };
            if (block.input['worktreeId'] !== undefined) {
              input.worktreeId = String(block.input['worktreeId']);
            }
            output = yield* perform({ type: 'BashExec', input });
            break;
          }
          case 'read_file': {
            const input: { path: string; limit?: number } = { path: String(block.input['path'] ?? '') };
            if (block.input['limit'] !== undefined) input.limit = Number(block.input['limit']);
            output = yield* perform({ type: 'ReadFile', input });
            break;
          }
          case 'write_file': {
            const input: { path: string; content: string; worktreeId?: string } = {
              path: String(block.input['path'] ?? ''),
              content: String(block.input['content'] ?? ''),
            };
            if (block.input['worktreeId'] !== undefined) {
              input.worktreeId = String(block.input['worktreeId']);
            }
            output = yield* perform({ type: 'WriteFile', input });
            break;
          }
          case 'edit_file':
            output = yield* perform({
              type: 'EditFile',
              input: {
                path: String(block.input['path'] ?? ''),
                oldText: String(block.input['old_text'] ?? ''),
                newText: String(block.input['new_text'] ?? ''),
              },
            });
            break;
          case 'glob':
            output = yield* perform({ type: 'GlobSearch', input: { pattern: String(block.input['pattern'] ?? '') } });
            break;
          default:
            output = `[未知工具] ${block.name}`;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: output });
      } catch (err) {
        toolResults.push(toolErrorResult(block.id, err));
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  const summary = `[subagent] 达到最大轮数 ${MAX_SUBAGENT_TURNS}，返回部分结果`;
  console.log(`\x1b[33m${summary}\x1b[0m`);
  return summary;
}
