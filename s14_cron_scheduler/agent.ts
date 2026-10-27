/**
 * s14: Cron Scheduler — 定时任务是时间维度的效应
 *
 * 本章新增 3 个 Effect（对应 schedule_cron / list_crons / cancel_cron 三个工具）：
 *   ScheduleCron — 注册定时任务（返回创建的 CronJob）
 *   ListCrons    — 列出所有已注册任务
 *   CancelCron   — 取消定时任务
 *
 * 核心思想：时间触发 = 效应延迟分发。
 * 主 Generator 不轮询时钟，它只声明"要注册/取消什么"；真正的时间机制是
 * 两个独立于对话的定时器：
 *   1. cron 调度器：setInterval 默认每秒检查 cron 表达式，命中则入队（分钟级去重）
 *   2. 队列处理器：setInterval 默认每 200ms 检查队列，空闲时唤醒 Agent 消费队列
 *
 * 两段式时间触发：
 *
 *   setInterval(1s)  cronSchedulerTick ── 命中表达式且本分钟未触发 ──► cronQueue[]
 *                                                                         │
 *   setInterval(200ms) queueProcessorTick ◄────────────────────────────────┘
 *        │  队列非空，且 agentLock 空闲（tryAcquire 成功）
 *        ▼
 *   runAgentTurn() → agentTurn：每轮 Chat 前先 consumeCronQueue()，把 [Scheduled] 注入会话
 *
 * 演示分两段：第一个用户 turn 注册任务；turn 结束后再启动调度器，
 * 让空闲的 Agent 由队列处理器唤醒。真实 agent 会在启动时同时开启两个定时器，
 * 这里分开只是为了让演示顺序确定。
 *
 * 这两层定时器 + 队列 + agentLock（保护单个 Agent turn）+ durable 持久化都是真实实现，
 * mock 只替换 LLM 调用（callChat 的 mockFn），不替换任何基础设施。
 */

import { runAgent } from '../runtime/core.ts';
import type { Effect, EffectHandlers, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolResultBlock } from '../runtime/types.ts';
import { extractText, getToolUseBlocks } from '../runtime/response.ts';
import { callChat } from '../runtime/model.ts';
import { schemasFor } from '../runtime/tool-schemas.ts';
import { buildSystemPrompt } from '../runtime/system-prompt.ts';
import { Mutex } from '../runtime/locks.ts';
import { SCHEDULED_TASKS_PATH } from '../runtime/workspace.ts';
import { cronMatches, validateCron } from '../runtime/cron.ts';
import type { CronJob } from '../runtime/cron.ts';
import * as fs from 'node:fs';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

/** 与 LLM 对话（mock 模式下由 mockLLM 提供响应） */
interface ChatEffect extends Effect<'Chat', { messages: Message[] }, LLMResponse> {}

// ── Cron 记录 ──
// 字段定义与解析、校验逻辑在 runtime/cron.ts，s14/s20 共用同一份实现。

interface ScheduleCronEffect
  extends Effect<
    'ScheduleCron',
    { cronId: string; cron: string; prompt: string; recurring?: boolean; durable?: boolean },
    CronJob
  > {}

interface ListCronsEffect extends Effect<'ListCrons', Record<string, never>, CronJob[]> {}

interface CancelCronEffect
  extends Effect<'CancelCron', { cronId: string }, { cancelled: boolean; cronId: string }> {}

type S14Effect = ChatEffect | ScheduleCronEffect | ListCronsEffect | CancelCronEffect;

// ============================================================
// Part 2: 调度状态与持久化
// ============================================================

// 可配置的定时器周期：默认 1s 调度轮询 / 默认 0.2s 队列轮询。
const TICK_MS = Number(process.env.S14_TICK_MS) || 1000;
const QUEUE_MS = Number(process.env.S14_QUEUE_MS) || 200;

// 共享状态：调度器、队列处理器、Agent 三方通过它们交互。
//
// JS 只有一个执行线程。调度器 tick、注册/取消、队列读写都是同步代码，
// 一次调用内部不会被其它代码打断，所以这些状态不需要额外的锁。
// 唯一跨 await 的是 Agent turn（模型调用），因此只用 agentLock 串行化 turn。
const scheduledJobs = new Map<string, CronJob>();
const cronQueue: CronJob[] = [];
const lastFired = new Map<string, string>(); // job_id → "YYYY-MM-DD HH:MM"
const agentLock = new Mutex();

// ---- durable 持久化：写入工作区 .scheduled_tasks.json ----
// 路径来自 runtime/workspace.ts。
function saveDurableJobs(): void {
  const durable = [...scheduledJobs.values()].filter(j => j.durable);
  fs.writeFileSync(SCHEDULED_TASKS_PATH, JSON.stringify(durable, null, 2), 'utf8');
}

// 启动时恢复 durable 任务。逐条校验表达式，坏数据只跳过，不让进程起不来。
function loadDurableJobs(): void {
  if (!fs.existsSync(SCHEDULED_TASKS_PATH)) return;
  try {
    const jobs: CronJob[] = JSON.parse(fs.readFileSync(SCHEDULED_TASKS_PATH, 'utf8'));
    let loaded = 0;
    for (const job of jobs) {
      const err = validateCron(job.cron);
      if (err) {
        console.log(`[cron] skipping invalid job ${job.id}: ${err}`);
        continue;
      }
      scheduledJobs.set(job.id, job);
      loaded++;
    }
    if (loaded > 0) console.log(`[cron] loaded ${loaded} durable job(s)`);
  } catch {
    // 磁盘状态损坏时跳过；教学版不尝试修复。
  }
}

// ---- 注册 / 取消 ----
// 注册同 id 的任务会覆盖旧任务；durable 任务在注册/取消后写盘。
// 返回 CronJob 或错误字符串（由 Handler 转成 tool_result.is_error）。
function scheduleJob(
  cronId: string,
  cron: string,
  prompt: string,
  recurring: boolean,
  durable: boolean,
): CronJob | string {
  const err = validateCron(cron);
  if (err) return err;
  const job: CronJob = { id: cronId, cron, prompt, recurring, durable };
  scheduledJobs.set(job.id, job);
  if (durable) saveDurableJobs();
  console.log(`[cron register] ${job.id} '${cron}' → ${prompt}`);
  return job;
}

function cancelJob(cronId: string): boolean {
  const job = scheduledJobs.get(cronId);
  if (!job) return false;
  scheduledJobs.delete(cronId);
  if (job.durable) saveDurableJobs();
  console.log(`[cron cancel] ${cronId}`);
  return true;
}

// ============================================================
// Part 4: 调度 tick 与队列
// ============================================================

// "YYYY-MM-DD HH:MM"。带上日期，跨天后同一个 HH:MM 不会被误判为已经触发过。
function minuteMarker(dt: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

// 调度器每个 tick 检查所有任务：
//   - 命中表达式且本分钟还没触发过 → 放入队列；
//   - 一次性任务命中后立即从任务表移除；
//   - 单个任务出错只打印，不影响其它任务。
// 返回本次新入队的任务数；整个函数是同步的，一次 tick 内部不会被打断。
function cronSchedulerTick(): number {
  const now = new Date();
  const marker = minuteMarker(now);
  let queued = 0;
  for (const job of [...scheduledJobs.values()]) {
    try {
      if (!cronMatches(job.cron, now)) continue;
      if (lastFired.get(job.id) !== marker) {
        cronQueue.push(job);
        lastFired.set(job.id, marker);
        queued++;
        console.log(`[cron fire] ${job.id} → ${job.prompt}`);
      }
      if (!job.recurring) {
        scheduledJobs.delete(job.id);
        if (job.durable) saveDurableJobs();
      }
    } catch (err) {
      console.log(`[cron error] ${job.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return queued;
}

// 取出并清空队列。由 Agent Generator 在每轮 Chat 前调用。
// 没有 await：取出和清空在同一个同步步骤里完成，不会被别的任务插入。
function consumeCronQueue(): CronJob[] {
  const fired = cronQueue.slice();
  cronQueue.length = 0;
  return fired;
}

// 队列处理器在拿锁前先看队列，避免空转时每个 tick 都去尝试拿锁。
function hasCronQueue(): boolean {
  return cronQueue.length > 0;
}

// ============================================================
// Part 5: Mock LLM（只替换模型调用）
// ============================================================

// 脚本按模型被调用的次数推进，不读取消息内容：
//   0: 注册一个每分钟触发的 cron
//   1: list_crons
//   2: 结束第一个 turn（等待调度器触发）
//   3: 收到 [Scheduled] 注入 → 确认并结束
// 因为不依赖消息内容，mock 的输出是固定的。
let mockTurn = 0;

function mockLLM(_messages: Message[]): LLMResponse {
  const i = mockTurn++;
  switch (i) {
    case 0: {
      // 用 * * * * * 而不是「当前分钟」：演示不依赖运行时刻，
      // 调度器的下一次检查必定命中。
      const cron = '* * * * *';
      return {
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: `注册每分钟触发的定时健康检查（cron="${cron}"）。` },
          {
            type: 'tool_use',
            id: 'm1',
            name: 'schedule_cron',
            input: {
              cronId: 'health_check',
              cron,
              prompt: '执行健康检查',
              recurring: true,
              durable: true,
            },
          },
        ],
      };
    }
    case 1:
      return {
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: '列出当前所有定时任务。' },
          { type: 'tool_use', id: 'm2', name: 'list_crons', input: {} },
        ],
      };
    case 2:
      return {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '定时任务已注册，等待调度器在下一 tick 触发。' }],
      };
    case 3:
      return {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '已收到 [Scheduled] 健康检查通知并处理完毕。' }],
      };
    default:
      return {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '无更多待办。' }],
      };
  }
}

// real 模式注入的 system prompt，引导模型使用 cron 工具。
// mock 模式不读取该字段，故零配置运行行为不变。
const SYSTEM_PROMPT = buildSystemPrompt(
  '需要注册、查看或取消定时任务时直接调用工具，不要只描述计划或反问。' +
  'cron 是本机时区的 5 字段表达式（分 时 日 月 周）；本演示使用 * * * * *（每分钟触发）。',
);

// ============================================================
// Part 6: Handler 实现（副作用集中处）
// ============================================================

const s14Handlers: EffectHandlers<S14Effect> = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const round = effect.input.messages.filter(m => m.role === 'assistant').length;
    console.log(`\n[Chat] → 轮次 ${round + 1}`);
    try {
      // mock 只替换这一行模型调用；其余机制（调度器/队列/agentLock/持久化）都是真实代码。
      return await callChat(mockLLM, effect.input.messages, {
        tools: schemasFor('schedule_cron', 'list_crons', 'cancel_cron'),
        system: SYSTEM_PROMPT,
      });
    } catch (err) {
      // 最小错误处理：本轮以一段错误文本结束，避免定时器回调出现未处理的 Promise 拒绝。
      // 完整的错误恢复机制见 s11。
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[Chat error] ${message}`);
      return {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: `[错误] 模型调用失败：${message}` }],
      };
    }
  },

  ScheduleCron: async (effect: ScheduleCronEffect): Promise<CronJob> => {
    const { cronId, cron, prompt, recurring = true, durable = true } = effect.input;
    const result = scheduleJob(cronId, cron, prompt, recurring, durable);
    // Handler 把校验错误转成异常，runAgent 的循环会把它写成 is_error 的 tool_result。
    if (typeof result === 'string') throw new Error(result);
    return result;
  },

  ListCrons: async (): Promise<CronJob[]> => {
    return [...scheduledJobs.values()];
  },

  CancelCron: async (effect: CancelCronEffect): Promise<{ cancelled: boolean; cronId: string }> => {
    const { cronId } = effect.input;
    return { cancelled: cancelJob(cronId), cronId };
  },
};

// ============================================================
// Part 7: Agent Generator（业务逻辑，零副作用）
// ============================================================

// 会话历史跨 turn 持久。
const sessionHistory: Message[] = [
  {
    role: 'user',
    content:
      '请用 schedule_cron 注册一个每分钟触发的定时健康检查：cron 用 "* * * * *"，' +
      'cronId 用 "health_check"，prompt 用 "执行健康检查"，recurring 和 durable 都设为 true。' +
      '注册后再用 list_crons 列出所有定时任务。',
  },
];

// 一个 turn = 从当前消息出发，一直跑到模型不再请求工具为止。
// 每轮 Chat 前先消费 cron 队列，把到期任务注入 [Scheduled] 消息。
// 不显式标注 Generator 泛型：让 TS 从 perform 的 yield* 推导 Next 类型（同 s01）。
function* agentTurn(perform: PerformFn<S14Effect>) {
  while (true) {
    // 定时器只负责把任务放进队列；真正的注入发生在这里。
    // 当前 turn 在跑时，定时任务也会在下一轮 Chat 前由这里消费；
    // 没有 turn 在跑时，队列处理器会新建一个 turn，从循环顶部进入。
    const fired = consumeCronQueue();
    for (const job of fired) {
      sessionHistory.push({ role: 'user', content: `[Scheduled] ${job.prompt}` });
      console.log(`[inject cron] ${job.prompt}`);
    }

    const response = yield* perform({ type: 'Chat', input: { messages: sessionHistory } });
    sessionHistory.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      return extractText(response);
    }

    const toolResults: ToolResultBlock[] = [];
    for (const block of getToolUseBlocks(response)) {
      console.log(`> ${block.name}`);
      try {
        let output: string;
        switch (block.name) {
          case 'schedule_cron': {
            const job = yield* perform({
              type: 'ScheduleCron',
              input: {
                cronId: block.input['cronId'] as string,
                cron: block.input['cron'] as string,
                prompt: block.input['prompt'] as string,
                recurring: block.input['recurring'] as boolean | undefined,
                durable: block.input['durable'] as boolean | undefined,
              },
            });
            output = `Scheduled ${job.id}: '${job.cron}' → ${job.prompt}`;
            break;
          }
          case 'list_crons': {
            const jobs = yield* perform({ type: 'ListCrons', input: {} });
            output = jobs.length === 0
              ? 'No cron jobs. Use schedule_cron to add one.'
              : jobs
                  .map(j => `  ${j.id}: '${j.cron}' → ${j.prompt} [${j.recurring ? 'recurring' : 'one-shot'}, ${j.durable ? 'durable' : 'session'}]`)
                  .join('\n');
            break;
          }
          case 'cancel_cron': {
            const { cancelled, cronId } = yield* perform({
              type: 'CancelCron',
              input: { cronId: block.input['cronId'] as string },
            });
            output = cancelled ? `Cancelled ${cronId}` : `Job ${cronId} not found`;
            break;
          }
          default:
            output = `[未知工具] ${block.name}`;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: output });
        console.log(output.slice(0, 200));
      } catch (err) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `[错误] ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        });
      }
    }

    sessionHistory.push({ role: 'user', content: toolResults });
  }
}

// 每次调用都会新建一个 agentTurn Generator，并由 runAgent 驱动到它返回。
// 一个 turn 在模型不再请求工具时结束；如果定时任务在 turn 结束后才到，
// 队列处理器要再调用一次 runAgentTurn 开启新的 turn。
// sessionHistory 是模块级状态，新 turn 仍然能看到之前的对话。
let lastAgentText = '';
async function runAgentTurn(): Promise<string> {
  const text = await runAgent<S14Effect, string>(agentTurn, s14Handlers);
  lastAgentText = text;
  return text;
}

// ============================================================
// Part 8: 队列处理器（真实定时器）
// ============================================================

// 队列处理器完成一次投递后，主流程就可以收尾。
let resolveDelivered: () => void;
const delivered = new Promise<void>(res => {
  resolveDelivered = res;
});

// 队列处理器的一个 tick：
//   1. 队列为空 → 直接返回，不碰锁；
//   2. agentLock 被占用（已有 turn 在跑）→ 跳过；当前 turn 会在下一轮 Chat 前消费队列，
//      如果它结束前没消费，队列留到下一个 tick；
//   3. 拿到锁 → 跑一个 turn。turn 在每轮 Chat 前消费队列，所以这里不用自己取任务。
//
// 用 tryAcquire 而不是 acquire：队列处理器是定时器回调，不能阻塞等待；
// 如果 Agent 正忙，就让出这个 tick。
async function queueProcessorTick(): Promise<void> {
  if (!hasCronQueue()) return;

  // tryAcquire 是同步的；从检查队列到拿到锁之间没有 await，
  // 所以拿到锁时队列仍然非空，不需要再检查一次。
  const release = agentLock.tryAcquire();
  if (!release) return;

  try {
    console.log('\n[queue processor] delivering scheduled work');
    await runAgentTurn();
    // 通知演示主流程：空闲路径的一次投递完成了。
    resolveDelivered();
  } finally {
    release();
  }
}

// ============================================================
// Part 9: 启动入口
// ============================================================

// 等待队列处理器完成一次投递，最多等 timeoutMs。
// 演示只需要观察一次投递；超时返回 false，让主流程打印原因并结束。
async function waitForDelivery(timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const deliveredInTime = await Promise.race([
    delivered.then(() => true),
    timeout,
  ]);
  if (timer) clearTimeout(timer);
  return deliveredInTime;
}

// 调度器：按 TICK_MS 检查一次 cron 表达式。
function startScheduler(): NodeJS.Timeout {
  return setInterval(() => {
    try {
      cronSchedulerTick();
    } catch (err) {
      console.log(`[cron error] ${err instanceof Error ? err.message : String(err)}`);
    }
  }, TICK_MS);
}

// 队列处理器：按 QUEUE_MS 看一次队列，Agent 空闲时唤醒一个 turn。
function startQueueProcessor(): NodeJS.Timeout {
  return setInterval(() => {
    void queueProcessorTick().catch(err => {
      console.log(`[queue error] ${err instanceof Error ? err.message : String(err)}`);
    });
  }, QUEUE_MS);
}

// 等待一次投递的上限。默认覆盖模型调用默认的 60 秒超时；
// 可用 S14_DELIVERY_TIMEOUT_MS 覆盖。
const DELIVERY_TIMEOUT_MS = Number(process.env.S14_DELIVERY_TIMEOUT_MS) || 75_000;

/**
 * 演示入口：先让用户 turn 注册任务，再启动调度器，等待队列处理器投递一次。
 * 真实 agent 在启动时同时开启两个定时器；这里分开只是为了让演示顺序确定。
 */
async function main(): Promise<void> {
  console.log('[S14] Cron Scheduler 启动\n');
  console.log(`持久化路径: ${SCHEDULED_TASKS_PATH}`);
  console.log(`调度器周期: ${TICK_MS}ms，队列处理器周期: ${QUEUE_MS}ms\n`);

  // 先恢复上次运行留下的 durable 任务；它们要等调度器启动后才会触发。
  loadDurableJobs();
  if (scheduledJobs.size > 0) {
    console.log(`启动时已恢复 ${scheduledJobs.size} 个 durable 任务`);
  }

  let queueTimer: NodeJS.Timeout | undefined;
  let schedulerTimer: NodeJS.Timeout | undefined;

  try {
    // 阶段 1：先让用户 turn 注册任务。
    // 队列处理器此时可以启动；队列为空，它不会做任何事。
    queueTimer = startQueueProcessor();
    console.log('[queue processor] started');
    await agentLock.withLock(() => runAgentTurn());

    // 阶段 2：用户 turn 结束后再启动调度器。
    // 这样任务不会打断首个 turn，投递一定由空闲的队列处理器完成。
    schedulerTimer = startScheduler();
    console.log('[cron] scheduler started');

    // 定时器的第一次触发要等 TICK_MS；这里立即检查一次，
    // 让演示不依赖定时器下一次触发的时刻。
    const queued = cronSchedulerTick();

    if (queued === 0) {
      // 没有命中当前时间的任务：可能是模型没有注册，或表达式不匹配。
      // 演示不空等，直接列出已注册任务后结束。
      console.log('[demo] 当前没有命中的定时任务，跳过投递等待');
      for (const job of scheduledJobs.values()) {
        console.log(`  ${job.id}: '${job.cron}'`);
      }
    } else {
      // 等待队列处理器完成一次投递。超时只说明演示没等到，不影响进程退出。
      const deliveredInTime = await waitForDelivery(DELIVERY_TIMEOUT_MS);
      if (!deliveredInTime) console.log('[warn] 等待 cron 投递超时，提前收尾');
    }
  } finally {
    // 无论成功还是超时，都要清掉定时器，否则进程不会退出。
    if (queueTimer) clearInterval(queueTimer);
    if (schedulerTimer) clearInterval(schedulerTimer);
  }

  // 展示 durable 持久化结果。
  if (fs.existsSync(SCHEDULED_TASKS_PATH)) {
    const saved: CronJob[] = JSON.parse(fs.readFileSync(SCHEDULED_TASKS_PATH, 'utf8'));
    console.log(`\n[Persist] .scheduled_tasks.json (${saved.length} 个 durable 任务):`);
    saved.forEach(j => console.log(`  ${j.id}: cron="${j.cron}" [${j.recurring ? 'recurring' : 'one-shot'}]`));
  }

  console.log(`\n[S14] 完成: ${lastAgentText}`);
}

await main();
