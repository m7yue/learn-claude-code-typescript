/**
 * s20 的 lead 主循环 —— 注入 cron/后台通知、压缩上下文、组装提示词/工具池、
 * 处理 429/529/过长与 max_tokens 恢复，然后把工具派发到对应 Effect。
 */

import type { PerformFn } from '../runtime/core.ts';
import { classifyError } from '../runtime/errors.ts';
import { extractText, getToolUseBlocks, toolErrorResult } from '../runtime/response.ts';
import type { LLMResponse, Message, ToolResultBlock } from '../runtime/types.ts';
import { textBlock } from './blocks.ts';
import { CONTINUATION_PROMPT } from '../runtime/recovery.ts';
import {
  COMPACTED_MARKER,
  DEFAULT_MAX_TOKENS,
  FALLBACK_MODEL,
  LEAD_ID,
  MAX_CHAT_RETRIES,
  MAX_REACTIVE_COMPACTIONS,
} from './config.ts';
import { applyPersist, planPersists } from './context.ts';
import { consumeCronQueue } from './cron.ts';
import type { S20Effect } from './effects.ts';
import { updateContext } from './handlers.ts';
import type { TodoItem } from './knowledge.ts';
import { CONFIGURED_MCP_SERVERS, mcpToolIndex } from './mcp.ts';
import { RecoveryState, readRetryAfterMs } from './recovery.ts';
import { formatTaskList } from './tasks.ts';
import type { WorktreeTask } from './tasks.ts';

export function* leadLoop(perform: PerformFn<S20Effect>) {
  let messages: Message[] = [
    { role: 'user', content: '使用全部 Harness 机制完成一次认证模块重构：初始化 → 规划 → 计划审批 → 执行 → 隔离验证 → 收尾。' },
  ];
  const state = new RecoveryState();
  let maxTokens = DEFAULT_MAX_TOKENS;
  let reactiveCompactions = 0;
  let endTurnDrains = 0;
  const MAX_END_TURN_DRAINS = 3;

  // 宿主阶段（循环外）：连接用户配置的 MCP 服务器。
  // 模型看不到连接过程——它只在后续轮次里调用已装配的 mcp__ 工具。
  for (const serverId of CONFIGURED_MCP_SERVERS) {
    yield* perform({ type: 'MCPConnect', input: { serverId } });
  }

  while (true) {
    // ── 注入：队友消息 + cron 队列 + 后台通知 ──
    const inboxResult = yield* perform({
      type: 'CheckInbox',
      input: { agentId: LEAD_ID, drain: true },
    });
    if (inboxResult.messages.length > 0) {
      const lines = inboxResult.messages
        .map((m) => `[${m.type}] ${m.from}: ${m.body}`)
        .join('\n');
      messages.push({ role: 'user', content: `<inbox>\n${lines}\n</inbox>` });
    }
    for (const job of consumeCronQueue()) {
      messages.push({ role: 'user', content: `[Scheduled] ${job.prompt}` });
      console.log(`  \x1b[35m[cron inject] ${job.prompt}\x1b[0m`);
    }
    const bgNotes = yield* perform({ type: 'CollectBackgroundResults', input: {} });
    if (bgNotes.length > 0) {
      messages.push({ role: 'user', content: bgNotes.map((n) => textBlock(n)) });
      console.log(`  [inject] ${bgNotes.length} 条后台通知`);
      for (const note of bgNotes) console.log(note);
    }

    // ── 上下文预算管线（L3 落盘 → L1 snip → L2 micro → L4 摘要）+ 提示词/工具池装配 ──
    for (const item of planPersists(messages)) {
      const reference = yield* perform({ type: 'PersistOutput', input: item });
      applyPersist(messages, item.toolUseId, reference);
    }
    messages = yield* perform({ type: 'PrepareContext', input: { messages } });
    const system = yield* perform({ type: 'AssemblePrompt', input: { context: updateContext() } });
    const tools = yield* perform({ type: 'AssembleToolPool', input: {} });

    // ── LLM 调用（含 429/529/过长 恢复）──
    let response: LLMResponse | undefined;
    let attempts = 0;
    while (!response && attempts < MAX_CHAT_RETRIES) {
      try {
        response = yield* perform({
          type: 'Chat',
          input: { messages, agentId: LEAD_ID, system, tools, model: state.currentModel, maxTokens },
        });
        state.onSuccess();
        reactiveCompactions = 0;
      } catch (error: unknown) {
        const kind = classifyError(error);
        if (kind === 'rate_limit') {
          yield* perform({
            type: 'RetryWithBackoff',
            input: { attempt: attempts, errorType: '429', retryAfterMs: readRetryAfterMs(error) },
          });
          attempts += 1;
          continue;
        }
        if (kind === 'overloaded') {
          const decision = state.onOverloaded(Boolean(FALLBACK_MODEL));
          if (decision.action === 'switch-model') {
            state.currentModel = yield* perform({
              type: 'SwitchModel',
              input: {
                reason: `连续 ${state.maxConsecutive529} 次 529 过载`,
                fromModel: state.currentModel,
              },
            });
          } else if (decision.action === 'retry-no-fallback') {
            console.log(`  [529 x${state.maxConsecutive529}] 未配置 FALLBACK_MODEL_ID，继续重试`);
          }
          yield* perform({
            type: 'RetryWithBackoff',
            input: { attempt: attempts, errorType: '529', retryAfterMs: readRetryAfterMs(error) },
          });
          attempts += 1;
          continue;
        }
        if (kind === 'prompt_too_long') {
          if (reactiveCompactions >= MAX_REACTIVE_COMPACTIONS) {
            throw new Error('压缩后仍然超出上下文');
          }
          reactiveCompactions += 1;
          console.log(
            `  [reactive compact] 第 ${reactiveCompactions}/${MAX_REACTIVE_COMPACTIONS} 次`,
          );
          messages = yield* perform({ type: 'PrepareContext', input: { messages, reactive: true } });
          continue;
        }
        throw error;
      }
    }
    if (!response) {
      throw new Error('重试耗尽');
    }

    // ── max_tokens 恢复路径 ──
    if (response.stop_reason === 'max_tokens') {
      const decision = state.onMaxTokens();
      if (decision.action === 'escalate') {
        maxTokens = state.maxTokens;
        console.log(`  [max_tokens] 升级到 ${maxTokens}`);
        continue;
      }
      messages.push({ role: 'assistant', content: response.content });
      if (decision.action === 'continue') {
        messages.push({ role: 'user', content: CONTINUATION_PROMPT });
        console.log(`  [max_tokens] 续接 ${state.recoveryCount}/${state.maxRecoveryRetries}`);
        continue;
      }
      throw new Error('max_tokens recovery limit reached');
    }
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      const finalText = extractText(response);
      if (endTurnDrains >= MAX_END_TURN_DRAINS) return finalText;
      // 模型可能启动后台任务后直接结束回合：先等完在途任务，把通知注入后再走一轮。
      const drained = yield* perform({ type: 'CollectBackgroundResults', input: { wait: true } });
      if (drained.length === 0) return finalText;
      endTurnDrains += 1;
      messages.push({ role: 'user', content: drained.map((text) => textBlock(text)) });
      console.log(`  [inject] 注入 ${drained.length} 条后台通知（回合结束排空）`);
      continue;
    }

    // ── 工具派发 ──
    const toolResults: ToolResultBlock[] = [];
    let compactedNow = false;
    for (const block of getToolUseBlocks(response)) {
      try {
        if (block.name === 'compact') {
          messages = yield* perform({
            type: 'PrepareContext',
            input: { messages, force: true, reason: String(block.input['reason'] ?? 'manual') },
          });
          // compactHistory 已经插入了标记；只有 short-history 分支返回原消息时才补。
          if (!messages.some((m) => m.content === COMPACTED_MARKER)) {
            messages.push({ role: 'user', content: COMPACTED_MARKER });
          }
          if (toolResults.length > 0) {
            console.log(`  [compact] 丢弃本轮 ${toolResults.length} 条工具结果`);
          }
          compactedNow = true;
          break;
        }
        if (block.name.startsWith('mcp__')) {
          const mapped = mcpToolIndex.get(block.name);
          if (!mapped) {
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `[MCP] 未知工具 ${block.name}（未装配）` });
            continue;
          }
          const out = yield* perform({
            type: 'MCPToolCall',
            input: { serverId: mapped.serverId, toolName: mapped.toolName, args: block.input },
          });
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: out });
          continue;
        }

        let output: string;
        switch (block.name) {
          case 'bash': {
            const command = String(block.input['command'] ?? '');
            if (block.input['run_in_background'] === true) {
              const { bgId } = yield* perform({ type: 'StartBackground', input: { block } });
              output = `[Background task ${bgId} started] 结果将以 task_notification 到达。`;
              break;
            }
            const input: { command: string; worktreeId?: string } = { command };
            if (block.input['worktreeId'] !== undefined) input.worktreeId = String(block.input['worktreeId']);
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
            if (block.input['worktreeId'] !== undefined) input.worktreeId = String(block.input['worktreeId']);
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
          case 'todo_write': {
            const todos = Array.isArray(block.input['todos']) ? (block.input['todos'] as TodoItem[]) : [];
            output = yield* perform({ type: 'TodoWrite', input: { todos } });
            break;
          }
          case 'task':
            output = yield* perform({ type: 'SpawnSubagent', input: { description: String(block.input['task'] ?? '') } });
            break;
          case 'load_skill':
            output = yield* perform({ type: 'LoadSkill', input: { name: String(block.input['name'] ?? '') } });
            break;
          case 'read_memory': {
            // schema 同时服务两套方言：s09 按 filename 读单条，s20 按 query 检索；两种都接
            const input: { query?: string; filename?: string } = {};
            if (block.input['query'] !== undefined) input.query = String(block.input['query']);
            if (block.input['filename'] !== undefined) input.filename = String(block.input['filename']);
            output = yield* perform({ type: 'ReadMemory', input });
            break;
          }
          case 'write_memory':
            output = yield* perform({
              type: 'WriteMemory',
              input: {
                // 同样接两套方言：s09 的 name/body 与 s20 的 key/content
                key: String(block.input['key'] ?? block.input['name'] ?? 'note'),
                content: String(block.input['content'] ?? block.input['body'] ?? ''),
              },
            });
            break;
          case 'create_task': {
            const input: {
              subject: string;
              description?: string;
              blockedBy?: string[];
              preferredOwner?: string;
            } = {
              subject: String(block.input['subject'] ?? ''),
            };
            if (block.input['description'] !== undefined) input.description = String(block.input['description']);
            if (Array.isArray(block.input['blockedBy'])) input.blockedBy = block.input['blockedBy'] as string[];
            if (block.input['preferredOwner'] !== undefined) {
              input.preferredOwner = String(block.input['preferredOwner']);
            }
            const task = yield* perform({ type: 'CreateTask', input });
            output = `Created ${task.id}: ${task.subject}`;
            break;
          }
          case 'list_tasks': {
            const tasks = yield* perform({ type: 'ListTasks', input: {} });
            output = formatTaskList(tasks as WorktreeTask[]);
            break;
          }
          case 'get_task':
            output = yield* perform({
              type: 'GetTask',
              input: { taskId: String(block.input['taskId'] ?? block.input['id'] ?? '') },
            });
            break;
          case 'claim_task': {
            const res = yield* perform({
              type: 'ClaimTask',
              input: { taskId: String(block.input['taskId'] ?? ''), owner: LEAD_ID },
            });
            output = res.ok ? `Claimed ${res.task?.id}` : `[错误] ${res.error}`;
            break;
          }
          case 'complete_task': {
            const res = yield* perform({
              type: 'CompleteTask',
              input: { taskId: String(block.input['taskId'] ?? ''), owner: LEAD_ID },
            });
            output = res.ok
              ? `Completed ${res.task?.id}${res.unblocked.length ? `; unblocked: ${res.unblocked.join(', ')}` : ''}`
              : `[错误] ${res.error}`;
            break;
          }
          case 'schedule_cron': {
            const input: { cronId: string; cron: string; prompt: string; recurring?: boolean; durable?: boolean } = {
              cronId: String(block.input['cronId'] ?? ''),
              cron: String(block.input['cron'] ?? ''),
              prompt: String(block.input['prompt'] ?? ''),
            };
            if (block.input['recurring'] !== undefined) input.recurring = Boolean(block.input['recurring']);
            if (block.input['durable'] !== undefined) input.durable = Boolean(block.input['durable']);
            const job = yield* perform({ type: 'ScheduleCron', input });
            output = `Scheduled ${job.id} (${job.cron})`;
            break;
          }
          case 'list_crons': {
            const jobs = yield* perform({ type: 'ListCrons', input: {} });
            output = jobs.length
              ? jobs.map((j) => `  ${j.id}: "${j.cron}" recurring=${j.recurring} durable=${j.durable}`).join('\n')
              : 'No cron jobs.';
            break;
          }
          case 'cancel_cron': {
            const res = yield* perform({ type: 'CancelCron', input: { cronId: String(block.input['cronId'] ?? '') } });
            output = res.cancelled ? `Cancelled ${res.cronId}` : `Not found: ${res.cronId}`;
            break;
          }
          case 'spawn_teammate': {
            const { agentId } = yield* perform({
              type: 'SpawnTeammate',
              input: { agentId: String(block.input['agentId'] ?? ''), role: String(block.input['role'] ?? '') },
            });
            output = `队友已创建: ${agentId}`;
            break;
          }
          case 'send_message': {
            const { messageId } = yield* perform({
              type: 'SendMessage',
              input: { from: LEAD_ID, to: String(block.input['to'] ?? ''), body: String(block.input['body'] ?? '') },
            });
            output = `消息已发送 (${messageId})`;
            break;
          }
          case 'check_inbox': {
            const input: { agentId: string; expectType?: string; waitMs?: number } = { agentId: LEAD_ID };
            if (block.input['expectType'] !== undefined) input.expectType = String(block.input['expectType']);
            if (block.input['waitMs'] !== undefined) input.waitMs = Number(block.input['waitMs']);
            const inboxResult = yield* perform({ type: 'CheckInbox', input });
            const msgs = inboxResult.messages;
            output = msgs.length
              ? msgs
                  .map((m) => {
                    // 协议响应要靠 metadata.request_id 关联，必须让模型看得见。
                    const meta = Object.keys(m.metadata).length > 0 ? ` ${JSON.stringify(m.metadata)}` : '';
                    return `[${m.type}] ${m.from}: ${m.body}${meta}`;
                  })
                  .join('\n')
              : '信箱为空';
            break;
          }
          case 'request_plan': {
            const input: { goal: string; requestId?: string; context?: string } = { goal: String(block.input['goal'] ?? '') };
            if (block.input['context'] !== undefined) input.context = String(block.input['context']);
            const plan = yield* perform({ type: 'RequestPlan', input });
            output =
              plan.status === 'rejected'
                ? `计划请求失败: ${plan.feedback}`
                : `已请求计划: ${plan.goal}。下一步用 check_inbox(expectType="plan_approval_request") 等待计划请求，并从返回消息的 metadata.request_id 取 requestId 后调用 review_plan。`;
            break;
          }
          case 'review_plan': {
            const input: { requestId: string; reviewerId: string; planText?: string } = {
              requestId: String(block.input['requestId'] ?? ''),
              reviewerId: String(block.input['reviewerId'] ?? LEAD_ID),
            };
            const res = yield* perform({ type: 'ReviewPlan', input });
            output = res.ok ? `计划 ${res.approved ? '已批准' : '被拒绝'}` : `[错误] ${res.error}`;
            break;
          }
          case 'request_shutdown': {
            const input: { agentId: string; reason?: string } = { agentId: String(block.input['agentId'] ?? '') };
            if (block.input['reason'] !== undefined) input.reason = String(block.input['reason']);
            const ack = yield* perform({ type: 'RequestShutdown', input });
            output = `关闭确认 (${ack.requestId}): acknowledged=${ack.acknowledged} ← ${ack.responder}`;
            break;
          }
          case 'create_worktree': {
            const res = yield* perform({
              type: 'CreateWorktree',
              input: {
                worktreeId: String(block.input['worktreeId'] ?? ''),
                taskId: block.input['taskId'] !== undefined ? String(block.input['taskId']) : undefined,
              },
            });
            output = res.ok ? `worktree ${res.worktreeId} created at ${res.path}` : `[错误] ${res.reason}`;
            break;
          }
          case 'remove_worktree': {
            const res = yield* perform({
              type: 'RemoveWorktree',
              input: {
                worktreeId: String(block.input['worktreeId'] ?? ''),
                discardChanges: Boolean(block.input['discard_changes']),
              },
            });
            output = res.removed ? 'worktree removed' : `[拒绝] ${res.reason}`;
            break;
          }
          case 'keep_worktree': {
            const res = yield* perform({
              type: 'KeepWorktree',
              input: { worktreeId: String(block.input['worktreeId'] ?? '') },
            });
            output = res.kept ? `worktree kept: ${res.reason}` : `[错误] ${res.reason}`;
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

    if (compactedNow) continue;
    if (toolResults.length > 0) messages.push({ role: 'user', content: toolResults });
  }
}
