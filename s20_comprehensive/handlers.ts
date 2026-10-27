/**
 * s20 的所有 Effect Handler —— 副作用集中在这里。
 * 具体领域逻辑在 tasks/knowledge/context/background/cron/mcp/worktree 等模块，
 * 本文件只负责把 Effect 路由到对应实现。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { runAgent } from '../runtime/core.ts';
import type { EffectHandlers } from '../runtime/core.ts';
import { callChat } from '../runtime/model.ts';
import type { ToolSchema } from '../runtime/model.ts';
import { getToolUseBlocks } from '../runtime/response.ts';
import { buildSystemPrompt } from '../runtime/system-prompt.ts';
import { resolveWithin } from '../runtime/paths.ts';
import { truncate } from '../runtime/text.ts';
import type { LLMResponse, Message, TaskRecord } from '../runtime/types.ts';
import { settleActiveWithin } from '../runtime/wait.ts';
import { MEMORY_INDEX_PATH, TOOL_RESULTS_DIR, WORKSPACE_ROOT } from '../runtime/workspace.ts';
import { collectBackgroundResults, startBackground } from './background.ts';
import { compactHistory, estimateSize, microCompact, reactiveCompact, snipCompact } from './context.ts';
import { cancelCron, listCrons, scheduleCron, validateCron } from './cron.ts';
import type { CronJob } from './cron.ts';
import {
  CONTEXT_LIMIT,
  CRON_TICK_MS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  FALLBACK_MODEL,
  GATE_TIMEOUT_MS,
  IDLE_POLL_INTERVAL_MS,
  IDLE_TIMEOUT_MS,
  LEAD_ID,
  MODE,
  POLL_MS,
  SUBAGENT_ID,
  WORKER_ID,
} from './config.ts';
import type {
  AssemblePromptEffect,
  AssembleToolPoolEffect,
  BashExecEffect,
  CancelCronEffect,
  ChatEffect,
  CheckInboxEffect,
  CheckInboxResult,
  ClaimTaskEffect,
  CollectBackgroundResultsEffect,
  CompleteTaskEffect,
  CreateTaskEffect,
  CreateWorktreeEffect,
  EditFileEffect,
  GateOutcome,
  GetTaskEffect,
  GlobSearchEffect,
  IdleOutcome,
  IdlePollEffect,
  KeepWorktreeEffect,
  ListCronsEffect,
  ListTasksEffect,
  LoadSkillEffect,
  MCPConnectEffect,
  MCPToolCallEffect,
  PersistOutputEffect,
  Plan,
  PrepareContextEffect,
  PromptContext,
  ReadFileEffect,
  ReadMemoryEffect,
  RemoveWorktreeEffect,
  RequestPlanEffect,
  RequestShutdownEffect,
  RetryWithBackoffEffect,
  ReviewPlanEffect,
  S20Effect,
  ScheduleCronEffect,
  SendMessageEffect,
  SpawnSubagentEffect,
  SpawnTeammateEffect,
  StartBackgroundEffect,
  SubmitPlanEffect,
  SwitchModelEffect,
  TodoWriteEffect,
  WaitForPlanResponseEffect,
  WriteFileEffect,
  WriteMemoryEffect,
} from './effects.ts';
import { worktrees } from './git.ts';
import { loadSkill, readMemoryFile, runTodoWrite, writeMemory } from './knowledge.ts';
import { BUS, type AgentMessage, validateAgentId } from './mailbox.ts';
import {
  buildMcpToolName,
  callMcpTool,
  connectMcp,
  mcpClients,
  mcpToolIndex,
} from './mcp.ts';
import { memo, mockModel } from './mock.ts';
import { classifyInboxMessage, handleProtocolInbox } from './protocol.ts';
import {
  newRequestId,
  pollForResponse,
  protocol,
  protocolInboxDeps,
} from './protocol-runtime.ts';
import { retryDelayMs } from './recovery.ts';
import {
  type ClaimResult,
  type CompleteResult,
  type WorktreeTask,
  bindTaskToWorktree,
  blockingDeps,
  canStart,
  claimTask,
  completeTask,
  createTask,
  listTasksOrdered,
  loadTask,
  unbindTasksFromWorktree,
} from './tasks.ts';
import {
  activeTeammates,
  hostStopping,
  subagentLoop,
  teammateFailures,
  teammateLoop,
} from './team.ts';
import { LEAD_LOCAL_TOOLS } from './tools.ts';
import { commandOutput, replaceFirstLiteral, sanitizeFilePart, sleep } from './util.ts';

const execAsync = promisify(exec);

function startTeammate(agentId: string, role: string): Promise<string> {
  const promise = runAgent<S20Effect, string>((perform) => teammateLoop(perform, agentId, role), s20Handlers)
    .catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      teammateFailures.add(agentId);
      console.log(`  \x1b[31m[teammate] ${agentId} 异常: ${message}\x1b[0m`);
      try {
        await BUS.send(agentId, LEAD_ID, `[teammate error] ${message}`, 'result');
      } catch {
        // 错误结果本身写不进去时只保留上面的日志。
      }
      return '[teammate error]';
    })
    .finally(() => {
      if (activeTeammates.get(agentId) === promise) activeTeammates.delete(agentId);
    });
  activeTeammates.set(agentId, promise);
  return promise;
}

export function updateContext(): PromptContext {
  let memories = '';
  if (fs.existsSync(MEMORY_INDEX_PATH)) memories = fs.readFileSync(MEMORY_INDEX_PATH, 'utf8').slice(0, 600);
  return { memories, connectedMcp: [...mcpClients.keys()], activeTeammates: [...activeTeammates.keys()] };
}

// ============================================================
// Part 14: Handler 实现（所有副作用在此）
// ============================================================

/** 把相对路径解析到 base 之下；越界（含同前缀兄弟目录）即抛错。 */
function safeChildPath(base: string, p: string): string {
  return resolveWithin(base, p);
}

export const s20Handlers: EffectHandlers<S20Effect> = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages, agentId, system, tools, model = DEFAULT_MODEL, maxTokens = DEFAULT_MAX_TOKENS } = effect.input;
    // mock 用脚本计数器，保证压缩前后都对应 README 的 R0/t0/S0 剧本；
    // real 模式 memo 不会推进，改用对话历史里的 assistant 条数（0 基）做粗略标签。
    const round =
      MODE === 'mock'
        ? agentId === LEAD_ID
          ? memo.leadRound
          : agentId === SUBAGENT_ID
            ? memo.subagentRound
            : memo.teammateRound
        : messages.filter((m) => m.role === 'assistant').length;
    const tag = agentId === LEAD_ID ? `R${round}` : agentId === SUBAGENT_ID ? `S${round}` : `t${round}`;
    console.log(`\n[Chat:${agentId}] ${tag} (model=${model}, maxTokens=${maxTokens}, tools=${tools.length})`);
    // 让出一拍，令后台/定时器/队友有机会推进（教学版确定性）
    await sleep(15);
    const response = await callChat((m) => mockModel(agentId, m), messages, { tools, system, model, maxTokens });
    const used = getToolUseBlocks(response).map((b) => b.name).join(', ');
    console.log(`[Chat:${agentId}] ← ${response.stop_reason}${used ? `, 工具: ${used}` : ''}`);
    return response;
  },

  AssemblePrompt: async (effect: AssemblePromptEffect): Promise<string> => {
    const { memories, connectedMcp, activeTeammates } = effect.input.context;
    const clauses = [
      '你可以调度任务图、后台任务、cron、队友与隔离 worktree，并可通过 MCP 调用外部工具。',
      `队友的 agentId 用 '${WORKER_ID}'（request_plan / request_shutdown 固定发给它）。`,
      'request_plan 只负责投递请求；随后用 check_inbox(expectType="plan_approval_request") 等待 plan_approval_request，从返回消息的 metadata.request_id 取 requestId，再调用 review_plan。',
      connectedMcp.length ? `已连接 MCP 服务器：${connectedMcp.join('、')}` : '',
      activeTeammates.length ? `活跃队友：${activeTeammates.join('、')}` : '',
      memories ? `记忆：\n${memories}` : '',
    ];
    return buildSystemPrompt(...clauses);
  },

  AssembleToolPool: async (): Promise<ToolSchema[]> => {
    mcpToolIndex.clear();
    const pool: ToolSchema[] = [...LEAD_LOCAL_TOOLS];
    for (const [serverId, server] of mcpClients) {
      for (const tool of server.tools) {
        const full = buildMcpToolName(serverId, tool.name);
        mcpToolIndex.set(full, { serverId, toolName: tool.name });
        pool.push({
          name: full,
          description: `[MCP:${serverId}] ${tool.description}`,
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string' }, id: { type: 'string' } },
            required: [],
          },
        });
      }
    }
    return pool;
  },

  PrepareContext: async (effect: PrepareContextEffect): Promise<Message[]> => {
    let msgs = effect.input.messages;
    if (effect.input.reactive) {
      console.log('  [reactive compact] 摘要 + 保留最近 5 条消息');
      return await reactiveCompact(msgs);
    }
    if (effect.input.force) {
      console.log(`  [compact] 触发压缩: ${effect.input.reason ?? 'manual'}`);
      return await compactHistory(msgs);
    }
    msgs = snipCompact(msgs);
    msgs = microCompact(msgs);
    if (estimateSize(msgs) > CONTEXT_LIMIT) {
      console.log('  [compact] 超过上下文上限，执行 LLM 摘要压缩');
      msgs = await compactHistory(msgs);
    }
    return msgs;
  },

  PersistOutput: async (effect: PersistOutputEffect): Promise<string> => {
    fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
    const file = path.join(TOOL_RESULTS_DIR, `${sanitizeFilePart(effect.input.toolUseId)}.txt`);
    fs.writeFileSync(file, effect.input.content, 'utf8');
    console.log(`  \x1b[33m[PersistOutput] ${effect.input.content.length} 字符 → ${file}\x1b[0m`);
    return `<persisted-output>\nFull output: ${file}\nPreview:\n${effect.input.content.slice(0, 2000)}\n</persisted-output>`;
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    const wtId = effect.input.worktreeId;
    const wtPath = wtId ? worktrees.getPath(wtId) : undefined;
    // worktreeId 必须是本次运行创建过的名字，否则报错（交给外层标 is_error）。
    if (wtId && !wtPath) {
      throw new Error(`unknown worktreeId '${wtId}'（已知: ${worktrees.paths().join(', ') || '无'}）`);
    }
    const cwd = wtPath ?? WORKSPACE_ROOT;
    console.log(`[BashExec] → ${effect.input.command}${wtPath ? ` (cwd=${wtPath})` : ''}`);
    // 用异步 exec，长命令期间事件循环仍能推进 cron、队友和后台任务。
    try {
      const { stdout, stderr } = await execAsync(effect.input.command, {
        cwd,
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return commandOutput(0, null, stdout, stderr);
    } catch (error) {
      const err = error as {
        code?: number | string;
        signal?: NodeJS.Signals | null;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      // spawn 失败（cwd 不存在、命令无法启动）给的是字符串 code，直接报原因。
      if (typeof err.code === 'string') {
        throw new Error(`command failed (${err.code}): ${err.message ?? err.code}`);
      }
      const status = typeof err.code === 'number' ? err.code : null;
      // 非零退出码（含超时/信号）抛错，让模型同时看到输出和失败状态。
      return commandOutput(status, err.signal ?? null, err.stdout ?? '', err.stderr ?? '');
    }
  },

  ReadFile: async (effect: ReadFileEffect): Promise<string> => {
    // 错误交给外层派发统一转成 is_error 的 tool_result；不要在 handler 内吞掉。
    const target = safeChildPath(WORKSPACE_ROOT, effect.input.path);
    const lines = fs.readFileSync(target, 'utf8').split('\n');
    if (effect.input.limit && effect.input.limit < lines.length) {
      return [...lines.slice(0, effect.input.limit), `... (${lines.length - effect.input.limit} more lines)`].join('\n');
    }
    return lines.join('\n');
  },

  WriteFile: async (effect: WriteFileEffect): Promise<string> => {
    const base = effect.input.worktreeId ? worktrees.getPath(effect.input.worktreeId) : undefined;
    if (effect.input.worktreeId && !base) {
      throw new Error(`unknown worktreeId '${effect.input.worktreeId}'`);
    }
    const target = safeChildPath(base ?? WORKSPACE_ROOT, effect.input.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, effect.input.content, 'utf8');
    return `Wrote ${effect.input.content.length} bytes to ${effect.input.path}`;
  },

  EditFile: async (effect: EditFileEffect): Promise<string> => {
    const target = safeChildPath(WORKSPACE_ROOT, effect.input.path);
    const content = fs.readFileSync(target, 'utf8');
    if (!content.includes(effect.input.oldText)) {
      throw new Error(`old_text not found in ${effect.input.path}`);
    }
    // 函数形式替换：newText 里的 $& / $' 按字面写入，不会被当成替换模式。
    fs.writeFileSync(target, replaceFirstLiteral(content, effect.input.oldText, effect.input.newText), 'utf8');
    return `Edited ${effect.input.path}`;
  },

  GlobSearch: async (effect: GlobSearchEffect): Promise<string> => {
    const pattern = effect.input.pattern;
    const dir = pattern.includes('/') ? pattern.slice(0, pattern.lastIndexOf('/')) : '.';
    const filePattern = pattern.includes('/') ? pattern.slice(pattern.lastIndexOf('/') + 1) : pattern;
    const re = new RegExp(
      '^' + filePattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    );
    try {
      const base = safeChildPath(WORKSPACE_ROOT, dir);
      const hits = fs.readdirSync(base).filter((f) => re.test(f));
      return hits.length ? hits.map((h) => path.join(dir, h)).join('\n') : `No files matching ${pattern}`;
    } catch {
      return `No files matching ${pattern}`;
    }
  },

  TodoWrite: async (effect: TodoWriteEffect): Promise<string> => runTodoWrite(effect.input.todos),
  SpawnSubagent: async (effect: SpawnSubagentEffect): Promise<string> => {
    console.log(`\x1b[35m[SpawnSubagent] ${truncate(effect.input.description, 60)}\x1b[0m`);
    return runAgent<S20Effect, string>((perform) => subagentLoop(perform, effect.input.description), s20Handlers);
  },
  LoadSkill: async (effect: LoadSkillEffect): Promise<string> => loadSkill(effect.input.name),

  ReadMemory: async (effect: ReadMemoryEffect): Promise<string> => readMemoryFile(effect.input.query, effect.input.filename),
  WriteMemory: async (effect: WriteMemoryEffect): Promise<string> => writeMemory(effect.input.key, effect.input.content),

  CreateTask: async (effect: CreateTaskEffect): Promise<TaskRecord> => {
    const task = createTask(
      effect.input.subject,
      effect.input.description ?? '',
      effect.input.blockedBy ?? [],
      effect.input.preferredOwner,
    );
    memo.taskIdBySubject[task.subject] = task.id; // 回填真实 id 供 mock 脚本引用
    console.log(`[CreateTask] ${task.id}: ${task.subject}${task.blockedBy.length ? ` (blockedBy ${task.blockedBy.join(',')})` : ''}`);
    return task;
  },
  ListTasks: async (): Promise<TaskRecord[]> => listTasksOrdered(),
  GetTask: async (effect: GetTaskEffect): Promise<string> => {
    const task = loadTask(effect.input.taskId);
    if (!task) return `task ${effect.input.taskId} not found`;
    return JSON.stringify({ ...task, blocked: blockingDeps(task) }, null, 2);
  },
  ClaimTask: async (effect: ClaimTaskEffect): Promise<ClaimResult> => {
    const res = claimTask(effect.input.taskId, effect.input.owner);
    console.log(`[ClaimTask] ${effect.input.taskId} by ${effect.input.owner}: ${res.ok ? 'ok' : res.error}`);
    return res;
  },
  CompleteTask: async (effect: CompleteTaskEffect): Promise<CompleteResult> => {
    const res = completeTask(effect.input.taskId, effect.input.owner);
    console.log(
      `[CompleteTask] ${effect.input.taskId}: ${res.ok ? `ok${res.unblocked.length ? ` (unblocked ${res.unblocked.join(',')})` : ''}` : res.error}`,
    );
    return res;
  },

  IdlePoll: async (effect: IdlePollEffect): Promise<IdleOutcome> => {
    const agentId = effect.input.agentId;
    const interval = effect.input.pollIntervalMs ?? IDLE_POLL_INTERVAL_MS;
    const autoClaim = effect.input.autoClaim !== false;
    const deadline = Date.now() + IDLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const handled = await handleProtocolInbox(agentId, await BUS.readInbox(agentId), protocolInboxDeps);
      if (handled.shutdown) {
        if (handled.messages.length > 0) await BUS.requeue(agentId, handled.messages);
        return { state: 'shutdown', trigger: 'inbox' };
      }
      // 先处理真实的 shutdown_request，再处理宿主收尾标记。
      if (hostStopping) {
        console.log(`  \x1b[35m[idle] ${agentId} 宿主收尾，退出空闲轮询\x1b[0m`);
        return { state: 'shutdown', trigger: 'timeout' };
      }
      if (handled.messages.length > 0) {
        return { state: 'work', trigger: 'inbox', inbox: handled.messages };
      }
      if (autoClaim) {
        const unclaimed = listTasksOrdered().find(
          (t) =>
            t.status === 'pending' &&
            !t.owner &&
            canStart(t.id) &&
            (!t.preferredOwner || t.preferredOwner === agentId),
        );
        if (unclaimed) {
          const res = claimTask(unclaimed.id, agentId);
          if (res.ok && res.task) {
            console.log(`  \x1b[36m[autonomous] ${agentId} auto-claimed ${res.task.id}\x1b[0m`);
            return { state: 'work', trigger: 'claimed', task: res.task as WorktreeTask };
          }
        }
      }
      await BUS.waitForMessage(agentId, Math.min(interval, Math.max(1, deadline - Date.now())));
    }
    return { state: 'timeout', trigger: 'timeout' };
  },

  StartBackground: async (effect: StartBackgroundEffect): Promise<{ bgId: string }> => ({
    bgId: startBackground(effect.input.block),
  }),
  CollectBackgroundResults: async (
    effect: CollectBackgroundResultsEffect,
  ): Promise<string[]> => collectBackgroundResults(effect.input.wait ?? false),

  ScheduleCron: async (effect: ScheduleCronEffect): Promise<CronJob> => {
    const err = validateCron(effect.input.cron);
    if (err) throw new Error(err);
    const job: CronJob = {
      id: effect.input.cronId,
      cron: effect.input.cron,
      prompt: effect.input.prompt,
      recurring: effect.input.recurring ?? true,
      durable: effect.input.durable ?? false,
    };
    scheduleCron(job);
    console.log(`[ScheduleCron] ${job.id} "${job.cron}" recurring=${job.recurring} durable=${job.durable}`);
    await sleep(CRON_TICK_MS + 40); // 让调度器真实 tick 一次，命中的任务进入队列
    return job;
  },
  ListCrons: async (): Promise<CronJob[]> => listCrons(),
  CancelCron: async (effect: CancelCronEffect): Promise<{ cancelled: boolean; cronId: string }> => {
    const result = cancelCron(effect.input.cronId);
    console.log(`[CancelCron] ${result.cronId}: ${result.cancelled ? 'cancelled' : 'not found'}`);
    return result;
  },

  SpawnTeammate: async (effect: SpawnTeammateEffect): Promise<{ agentId: string; status: 'spawned' }> => {
    const { agentId, role } = effect.input;
    validateAgentId(agentId);
    if (agentId === LEAD_ID || agentId === SUBAGENT_ID) {
      throw new Error(`'${agentId}' 是保留名（lead / subagent）`);
    }
    if (!role.trim()) throw new Error('role 不能为空');
    if (activeTeammates.has(agentId)) throw new Error(`队友 '${agentId}' 仍在运行`);

    BUS.ensureInbox(agentId);
    // 同名队友上一轮的结果/关机消息不能带进新实例。
    BUS.clearInbox(agentId);
    teammateFailures.delete(agentId);
    console.log(`\x1b[36m[SpawnTeammate] ${agentId} (${role})\x1b[0m`);
    startTeammate(agentId, role);
    await sleep(0);
    return { agentId, status: 'spawned' };
  },
  SendMessage: async (effect: SendMessageEffect): Promise<{ messageId: string }> => {
    const { from, to, body, type, metadata } = effect.input;
    // 不能向已退出/从未 spawn 的 id 静默投递：消息会进一个没人读的信箱。
    if (to !== LEAD_ID && !activeTeammates.has(to)) {
      throw new Error(`目标 '${to}' 不是运行中的队友`);
    }
    if (from === LEAD_ID && to === LEAD_ID) {
      throw new Error('不能给自己发消息');
    }
    return { messageId: await BUS.send(from, to, body, type ?? 'message', metadata ?? {}) };
  },
  CheckInbox: async (effect: CheckInboxEffect): Promise<CheckInboxResult> => {
    const { agentId, expectType, waitMs, drain } = effect.input;

    if (drain) {
      // lead 每轮开始时的自动注入：普通队友消息进入上下文，
      // 计划请求留在信箱供 check_inbox(expectType) 使用。
      const handled = await handleProtocolInbox(agentId, await BUS.readInbox(agentId), protocolInboxDeps);
      if (handled.shutdown) {
        if (handled.messages.length > 0) await BUS.requeue(agentId, handled.messages);
        return { messages: [], shutdown: true };
      }
      const planRequests = handled.messages.filter((m) => m.type === 'plan_approval_request');
      const inject = handled.messages.filter((m) => m.type !== 'plan_approval_request');
      if (planRequests.length > 0) await BUS.requeue(agentId, planRequests);
      if (inject.length > 0) {
        console.log(`  \x1b[35m[Inbox] ${inject.length} 条队友消息注入 lead 上下文\x1b[0m`);
      }
      return { messages: inject, shutdown: false };
    }

    if (expectType) {
      const deadline = Date.now() + (waitMs ?? GATE_TIMEOUT_MS);
      while (Date.now() < deadline) {
        const raw = await BUS.readInbox(agentId);
        const hit = raw.find((m) => m.type === expectType);
        if (hit) {
          // response 类型先落定，再把命中的消息交给调用方（通常是 review 流程）。
          if (expectType.endsWith('_response')) {
            const reqId = String(hit.metadata['request_id'] ?? '');
            protocol.settle(hit.type, reqId, Boolean(hit.metadata['approve']));
          }
          const rest = raw.filter((m) => m !== hit);
          const handled = await handleProtocolInbox(agentId, rest, protocolInboxDeps);
          if (handled.shutdown) {
            // 关机时也不要吞掉同批消息：放回信箱，交给下一个实例/收尾流程。
            await BUS.requeue(agentId, [hit, ...handled.messages]);
            return { messages: [], shutdown: true };
          }
          if (handled.messages.length > 0) await BUS.requeue(agentId, handled.messages);
          console.log(`[CheckInbox:${agentId}] 等到 ${expectType}`);
          return { messages: [hit], shutdown: false };
        }

        const handled = await handleProtocolInbox(agentId, raw, protocolInboxDeps);
        if (handled.shutdown) {
          if (handled.messages.length > 0) await BUS.requeue(agentId, handled.messages);
          return { messages: [], shutdown: true };
        }
        if (handled.messages.length > 0) await BUS.requeue(agentId, handled.messages);
        await BUS.waitForMessage(agentId, POLL_MS);
      }
      console.log(`[CheckInbox:${agentId}] 等待 ${expectType} 超时`);
      return { messages: [], shutdown: false };
    }

    // lead 收信前短暂等待活跃队友，保证它们的收尾消息已经写进信箱；
    // waitMs 让这个等待显式、可配置，而不是藏在 handler 里的魔法数字。
    if (agentId === LEAD_ID) await settleActiveWithin(activeTeammates, waitMs ?? 300);

    const handled = await handleProtocolInbox(agentId, await BUS.readInbox(agentId), protocolInboxDeps);
    if (handled.shutdown) {
      if (handled.messages.length > 0) await BUS.requeue(agentId, handled.messages);
      return { messages: [], shutdown: true };
    }
    console.log(`[CheckInbox:${agentId}] 收到 ${handled.messages.length} 条消息`);
    handled.messages.forEach((m) => console.log(`  ✉ [${m.type}] ${m.from}: ${truncate(m.body, 70)}`));
    return handled;
  },

  SubmitPlan: async (effect: SubmitPlanEffect): Promise<{ requestId: string }> => {
    const requestId = newRequestId('plan');
    protocol.register({
      requestId,
      type: 'plan_approval',
      sender: effect.input.from,
      target: LEAD_ID,
      status: 'pending',
      payload: effect.input.plan,
      createdAt: Date.now(),
    });
    await BUS.send(effect.input.from, LEAD_ID, effect.input.plan, 'plan_approval_request', { request_id: requestId });
    memo.planRequestId = requestId; // 供 lead 侧 mock 审批时引用同一 request_id
    console.log(`[SubmitPlan] ${effect.input.from} 提交计划 ${requestId}（闸门关闭，等待审批）`);
    return { requestId };
  },
  WaitForPlanResponse: async (effect: WaitForPlanResponseEffect): Promise<GateOutcome> => {
    const { agentId, requestId } = effect.input;
    const deadline = Date.now() + GATE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const msgs = await BUS.readInbox(agentId);
      const keep: AgentMessage[] = [];
      let shutdownNow = false;
      let outcome: GateOutcome | null = null;
      for (const msg of msgs) {
        const kind = classifyInboxMessage(msg);
        const reqId = String(msg.metadata['request_id'] ?? '');
        if (kind === 'shutdown_request') {
          await BUS.send(agentId, LEAD_ID, 'Shutting down gracefully.', 'shutdown_response', {
            request_id: reqId,
            approve: true,
            responder: agentId,
          });
          protocol.settleIfPending('plan_approval_response', requestId, false);
          shutdownNow = true;
          continue;
        }
        if (kind === 'shutdown_response') {
          protocol.settle(msg.type, reqId, Boolean(msg.metadata['approve']));
          continue;
        }
        if (kind === 'plan_approval_response' && reqId === requestId) {
          const approved = Boolean(msg.metadata['approve']);
          // 正常路径由 lead 的 ReviewPlan 先落定；这里兜底响应先到的情况。
          protocol.settleIfPending('plan_approval_response', requestId, approved);
          const settled = protocol.get(requestId);
          const status = settled?.status === 'approved' ? 'approved' : 'rejected';
          outcome = { kind: status, feedback: String(msg.metadata['feedback'] ?? '') };
          console.log(`  \x1b[32m[gate] ${agentId} 收到审批 ${requestId}: ${status}\x1b[0m`);
          continue;
        }
        keep.push(msg);
      }
      if (keep.length > 0) await BUS.requeue(agentId, keep);
      if (shutdownNow) return { kind: 'shutdown' };
      if (outcome) return outcome;
      // 先处理真实的 shutdown_request / 审批响应，再处理宿主收尾标记。
      if (hostStopping) {
        console.log(`  \x1b[35m[gate] ${agentId} 宿主收尾，放弃等待审批\x1b[0m`);
        protocol.settleIfPending('plan_approval_response', requestId, false);
        return { kind: 'shutdown' };
      }
      await BUS.waitForMessage(agentId, POLL_MS);
    }
    // 超时也要落定，保证协议汇总与返回值一致。
    protocol.settleIfPending('plan_approval_response', requestId, false);
    return { kind: 'timeout' };
  },

  RequestPlan: async (effect: RequestPlanEffect): Promise<Plan> => {
    const { goal } = effect.input;

    // 没有运行中的队友时直接返回失败，避免 lead 在 check_inbox 里空等。
    if (!activeTeammates.has(WORKER_ID)) {
      console.log(`[RequestPlan] 没有运行中的队友 '${WORKER_ID}'，直接返回 rejected`);
      return { requestId: '', goal, steps: [], status: 'rejected', feedback: `队友 '${WORKER_ID}' 未在运行` };
    }

    console.log(`[RequestPlan] 请求 ${WORKER_ID} 提交计划: ${goal}`);
    await BUS.send(
      LEAD_ID,
      WORKER_ID,
      `请为下列目标提交执行计划：${goal}${effect.input.context ? `\n背景：${effect.input.context}` : ''}`,
      'message',
    );
    // 这里是异步投递：请求只是发出，真实 requestId 要等队友 submit_plan 后才存在；
    // 不要在返回值里回显模型可能传入的 requestId，避免把假 id 当成协议状态。
    return { requestId: '', goal, steps: [], status: 'pending', feedback: '已发出计划请求' };
  },
  ReviewPlan: async (effect: ReviewPlanEffect): Promise<{ ok: boolean; approved: boolean; error?: string }> => {
    const { requestId, reviewerId } = effect.input;
    if (reviewerId !== LEAD_ID) {
      console.log(`[ReviewPlan] 警告: reviewerId=${reviewerId} 不是 lead，拒绝`);
      return { ok: false, approved: false, error: `只有 '${LEAD_ID}' 能审批计划` };
    }

    const state = protocol.get(requestId);
    if (!state) return { ok: false, approved: false, error: `request ${requestId} not found` };
    if (state.type !== 'plan_approval' || state.status !== 'pending') {
      return { ok: false, approved: false, error: `request ${requestId} not pending (type=${state.type}, status=${state.status})` };
    }

    // 真实审批规则：计划里至少列出 3 个编号步骤才批准，否则要求补充。
    const stepLines = state.payload.split('\n').filter((l) => /^\d+[.)、]/.test(l.trim()));
    const approved = stepLines.length >= 3;
    const feedback = approved ? `计划含 ${stepLines.length} 步，批准` : `仅 ${stepLines.length} 步，要求补充`;

    // 先回发响应，成功后再落定：发送失败时请求保持 pending，由等待方超时兜底。
    // 队友也可能先读到响应并自行落定；duplicate 时以最终状态为准。
    await BUS.send(reviewerId, state.sender, feedback, 'plan_approval_response', {
      request_id: requestId,
      approve: approved,
      feedback,
      reviewer: reviewerId,
    });

    const settled = protocol.settle('plan_approval_response', requestId, approved);
    if (settled !== 'settled' && settled !== 'duplicate') {
      return { ok: false, approved: false, error: `request ${requestId} was not settled (${settled})` };
    }
    const final = protocol.get(requestId);
    const expected = approved ? 'approved' : 'rejected';
    if (final?.status !== expected) {
      return { ok: false, approved: false, error: `request ${requestId} was settled as ${final?.status}` };
    }
    console.log(`[ReviewPlan] ${requestId}: ${approved ? '批准' : '拒绝'} → 回传 ${state.sender}`);
    return { ok: true, approved };
  },
  RequestShutdown: async (
    effect: RequestShutdownEffect,
  ): Promise<{ acknowledged: boolean; requestId: string; responder: string }> => {
    const { agentId } = effect.input;
    const requestId = newRequestId('shutdown');

    // 目标已经不在了：直接返回，不发出会永久留在信箱里的 shutdown_request。
    if (!activeTeammates.has(agentId)) {
      console.log(`[RequestShutdown] 没有运行中的队友 '${agentId}'，直接返回 acknowledged=false`);
      return { acknowledged: false, requestId, responder: agentId };
    }

    protocol.register({
      requestId,
      type: 'shutdown',
      sender: LEAD_ID,
      target: agentId,
      status: 'pending',
      payload: effect.input.reason ?? '',
      createdAt: Date.now(),
    });
    await BUS.send(LEAD_ID, agentId, effect.input.reason ? `请优雅关闭：${effect.input.reason}` : '请优雅关闭。', 'shutdown_request', {
      request_id: requestId,
    });
    console.log(`[RequestShutdown] ${agentId} ${requestId}（等待 shutdown_response）`);
    const resp = await pollForResponse(requestId, 'shutdown_response', agentId);
    if (!resp) protocol.settleIfPending('shutdown_response', requestId, false);
    const settled = protocol.get(requestId);
    return {
      acknowledged: settled?.status === 'approved',
      requestId,
      responder: resp?.from ?? agentId,
    };
  },

  CreateWorktree: async (
    effect: CreateWorktreeEffect,
  ): Promise<{ ok: boolean; worktreeId: string; path?: string; reason?: string }> => {
    const res = worktrees.create(effect.input.worktreeId, effect.input.taskId ?? '');
    if (res.ok && effect.input.taskId) {
      const bound = bindTaskToWorktree(effect.input.taskId, res.worktreeId);
      if (!bound.ok) {
        console.warn(`[CreateWorktree] 绑定任务失败: ${bound.reason}`);
        return { ...res, ok: false, reason: `worktree created but bind failed: ${bound.reason}` };
      }
      console.log(`[CreateWorktree] ${res.worktreeId} bound task ${effect.input.taskId}`);
    }
    console.log(`[CreateWorktree] ${effect.input.worktreeId}: ${res.ok ? res.path : res.reason}`);
    return res;
  },
  RemoveWorktree: async (effect: RemoveWorktreeEffect): Promise<{ removed: boolean; reason?: string }> => {
    const res = worktrees.remove(effect.input.worktreeId, Boolean(effect.input.discardChanges));
    if (res.removed) unbindTasksFromWorktree(effect.input.worktreeId);
    console.log(`[RemoveWorktree] ${effect.input.worktreeId}: ${res.removed ? 'removed' : res.reason}`);
    return res;
  },
  KeepWorktree: async (effect: KeepWorktreeEffect): Promise<{ kept: boolean; reason?: string }> => {
    const res = worktrees.keep(effect.input.worktreeId);
    console.log(`[KeepWorktree] ${effect.input.worktreeId}: kept`);
    return res;
  },

  MCPConnect: async (effect: MCPConnectEffect): Promise<{ serverId: string; toolNames: string[] }> =>
    connectMcp(effect.input.serverId),
  MCPToolCall: async (effect: MCPToolCallEffect): Promise<string> => {
    console.log(`[MCPToolCall] ${effect.input.serverId}.${effect.input.toolName}`);
    return callMcpTool(effect.input.serverId, effect.input.toolName, effect.input.args);
  },

  RetryWithBackoff: async (effect: RetryWithBackoffEffect): Promise<void> => {
    const delay = retryDelayMs(effect.input.attempt, effect.input.retryAfterMs);
    console.log(`  \x1b[33m[Retry] ${effect.input.errorType} 第 ${effect.input.attempt + 1} 次，等待 ${delay}ms\x1b[0m`);
    await sleep(delay);
  },
  SwitchModel: async (effect: SwitchModelEffect): Promise<string> => {
    const next = FALLBACK_MODEL || effect.input.fromModel;
    console.log(`  \x1b[35m[SwitchModel] ${effect.input.fromModel} → ${next} (${effect.input.reason})\x1b[0m`);
    return next;
  },
};
