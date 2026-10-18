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
 *   1. cron 调度器：setInterval 每秒检查 cron 表达式，命中则入队（分钟级去重）
 *   2. 队列处理器：setInterval 每 200ms 检查队列，空闲时唤醒 Agent 消费队列
 *
 * 两段式时间触发：
 *
 *   setInterval(1s)  cronSchedulerTick ── 命中表达式且本分钟未触发 ──► cronQueue[]
 *                                                                         │
 *   setInterval(200ms) queueProcessorTick ◄────────────────────────────────┘
 *        │  队列非空，且 agentLock 空闲（tryAcquire 成功）
 *        ▼
 *   runAgentTurn()：每轮 Chat 前先 consumeCronQueue()，把 [Scheduled] 注入会话
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
import * as fs from 'node:fs';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

/** 与 LLM 对话（mock 模式下由 mockLLM 提供响应） */
interface ChatEffect extends Effect<'Chat', { messages: Message[] }, LLMResponse> {}

// ── Cron 记录 ──
// 只保留被真正使用的字段：无 runCount / lastRunAt 等死字段。
interface CronJob {
  id: string;
  cron: string;        // "分 时 日 月 周" 5 字段 cron 表达式
  prompt: string;      // 触发时注入 Agent 的描述
  recurring: boolean;  // false = 触发一次后自动注销
  durable: boolean;    // true = 持久化到磁盘（重启后保留）
}

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
// Part 2: Cron 基础设施（真实实现）
// ============================================================

// 可配置的定时器周期：1s 调度轮询 / 0.2s 队列轮询。
const TICK_MS = Number(process.env.S14_TICK_MS) || 1000;
const QUEUE_MS = Number(process.env.S14_QUEUE_MS) || 200;

// 共享状态：调度器、队列处理器、Agent 三方通过它们交互。
const scheduledJobs = new Map<string, CronJob>();
const cronQueue: CronJob[] = [];
const lastFired = new Map<string, string>(); // job_id → "YYYY-MM-DD HH:MM"
const agentLock = new Mutex();  // 保证同一时刻只有一个 Agent turn 在跑

// ---- 单字段 cron 匹配：支持 * | N | */N | N-M | N,M ----
function cronFieldMatches(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = Number(field.slice(2));
    return step > 0 && value % step === 0;
  }
  if (field.includes(',')) {
    return field.split(',').some(f => cronFieldMatches(f.trim(), value));
  }
  if (field.includes('-')) {
    const idx = field.indexOf('-');
    const lo = Number(field.slice(0, idx));
    const hi = Number(field.slice(idx + 1));
    return lo <= value && value <= hi;
  }
  return Number(field) === value;
}

// ---- 5 字段 cron 匹配：分 时 日 月 周 ----
// DOM / DOW 双约束时用 OR 语义（标准 cron 行为）。
function cronMatches(expr: string, dt: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dom, month, dow] = fields;
  // JS 的 Date.getDay() 已经是 0=周日..6=周六，与 cron 一致。
  const dowVal = dt.getDay();

  const m = cronFieldMatches(minute, dt.getMinutes());
  const h = cronFieldMatches(hour, dt.getHours());
  const domOk = cronFieldMatches(dom, dt.getDate());
  const monthOk = cronFieldMatches(month, dt.getMonth() + 1);
  const dowOk = cronFieldMatches(dow, dowVal);

  if (!(m && h && monthOk)) return false;

  const domUnconstrained = dom === '*';
  const dowUnconstrained = dow === '*';
  if (domUnconstrained && dowUnconstrained) return true;
  if (domUnconstrained) return dowOk;
  if (dowUnconstrained) return domOk;
  return domOk || dowOk;
}

// ---- 单字段合法性校验 ----
// 返回错误信息或 null。
function validateCronField(field: string, lo: number, hi: number): string | null {
  if (field === '*') return null;
  if (field.startsWith('*/')) {
    const stepStr = field.slice(2);
    if (!/^\d+$/.test(stepStr)) return `Invalid step: ${field}`;
    if (Number(stepStr) <= 0) return `Step must be > 0: ${field}`;
    return null;
  }
  if (field.includes(',')) {
    for (const part of field.split(',')) {
      const err = validateCronField(part.trim(), lo, hi);
      if (err) return err;
    }
    return null;
  }
  if (field.includes('-')) {
    const idx = field.indexOf('-');
    const aStr = field.slice(0, idx);
    const bStr = field.slice(idx + 1);
    if (!/^\d+$/.test(aStr) || !/^\d+$/.test(bStr)) return `Invalid range: ${field}`;
    const a = Number(aStr);
    const b = Number(bStr);
    if (a < lo || a > hi || b < lo || b > hi) return `Range ${field} out of bounds [${lo}-${hi}]`;
    if (a > b) return `Range start > end: ${field}`;
    return null;
  }
  if (!/^\d+$/.test(field)) return `Invalid field: ${field}`;
  const val = Number(field);
  if (val < lo || val > hi) return `Value ${val} out of bounds [${lo}-${hi}]`;
  return null;
}

// ---- 5 字段表达式校验 ----
function validateCron(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return `Expected 5 fields, got ${fields.length}`;
  const bounds: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  const names = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'];
  for (let i = 0; i < fields.length; i++) {
    const err = validateCronField(fields[i], bounds[i][0], bounds[i][1]);
    if (err) return `${names[i]}: ${err}`;
  }
  return null;
}

// ---- durable 持久化：写入工作区 .scheduled_tasks.json ----
// 路径来自 runtime/workspace.ts。
function saveDurableJobs(): void {
  const durable = [...scheduledJobs.values()].filter(j => j.durable);
  fs.writeFileSync(SCHEDULED_TASKS_PATH, JSON.stringify(durable, null, 2), 'utf8');
}

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
    // 磁盘状态损坏时静默跳过。
  }
}

// ---- 注册 / 取消 ----
// 返回 CronJob 或错误字符串。
async function scheduleJob(
  cronId: string,
  cron: string,
  prompt: string,
  recurring: boolean,
  durable: boolean,
): Promise<CronJob | string> {
  const err = validateCron(cron);
  if (err) return err;
  const job: CronJob = { id: cronId, cron, prompt, recurring, durable };
  scheduledJobs.set(job.id, job);
  if (durable) saveDurableJobs();
  console.log(`[cron register] ${job.id} '${cron}' → ${prompt}`);
  return job;
}

async function cancelJob(cronId: string): Promise<boolean> {
  const job = scheduledJobs.get(cronId);
  if (!job) return false;
  scheduledJobs.delete(cronId);
  if (job.durable) saveDurableJobs();
  console.log(`[cron cancel] ${cronId}`);
  return true;
}

// ---- 调度器 tick：检查所有任务，命中则入队（分钟级去重）----
// 单个任务出错不影响整体。
function minuteMarker(dt: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

async function cronSchedulerTick(): Promise<void> {
  const now = new Date();
  const marker = minuteMarker(now);
  for (const job of [...scheduledJobs.values()]) {
    try {
      if (!cronMatches(job.cron, now)) continue;
      if (lastFired.get(job.id) !== marker) {
        cronQueue.push(job);
        lastFired.set(job.id, marker);
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
}

// 消费队列（由 Agent Generator 在每轮 Chat 前同步调用）。
// JS 单线程，这一步相对于其它 JS 执行是原子的。
function consumeCronQueue(): CronJob[] {
  const fired = cronQueue.slice();
  cronQueue.length = 0;
  return fired;
}

function hasCronQueue(): boolean {
  return cronQueue.length > 0;
}

// ============================================================
// Part 3: Mock LLM（只替换模型调用）
// ============================================================

// 脚本用状态机（计数器）驱动，与 turn 交错顺序无关，保证确定性。
//   0: 注册一个匹配「当前分钟」的 cron（确保调度器 ~1s 内命中，不等 60s）
//   1: list_crons
//   2: 结束第一轮 turn（等待调度器触发）
//   3: 收到 [Scheduled] 注入 → 确认并结束
let mockTurn = 0;

function mockLLM(_messages: Message[]): LLMResponse {
  const i = mockTurn++;
  switch (i) {
    case 0: {
      const now = new Date();
      const cron = `${now.getMinutes()} ${now.getHours()} * * *`;
      return {
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: `注册匹配当前分钟的定时健康检查（cron="${cron}"）。` },
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
  '使用工具解决任务。对于应在未来某个本地时间开始的工作，用 schedule_cron 注册定时任务；用 list_crons 查看、cancel_cron 取消。',
);

// ============================================================
// Part 4: Handler 实现（副作用集中处）
// ============================================================

const s14Handlers: EffectHandlers<S14Effect> = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const round = effect.input.messages.filter(m => m.role === 'assistant').length;
    console.log(`\n[Chat] → 轮次 ${round + 1}`);
    // mock 只替换这一行模型调用；其余机制（调度器/队列/agentLock/持久化）都是真实代码。
    return callChat(mockLLM, effect.input.messages, {
      tools: schemasFor('schedule_cron', 'list_crons', 'cancel_cron'),
      system: SYSTEM_PROMPT,
    });
  },

  ScheduleCron: async (effect: ScheduleCronEffect): Promise<CronJob> => {
    const { cronId, cron, prompt, recurring = true, durable = true } = effect.input;
    const result = await scheduleJob(cronId, cron, prompt, recurring, durable);
    if (typeof result === 'string') throw new Error(result); // → tool_result.is_error
    return result;
  },

  ListCrons: async (): Promise<CronJob[]> => {
    return [...scheduledJobs.values()];
  },

  CancelCron: async (effect: CancelCronEffect): Promise<{ cancelled: boolean; cronId: string }> => {
    const { cronId } = effect.input;
    const cancelled = await cancelJob(cronId);
    return { cancelled, cronId };
  },
};

// ============================================================
// Part 5: Agent Generator（业务逻辑，零副作用）
// ============================================================

// 会话历史跨 turn 持久。
const sessionHistory: Message[] = [
  { role: 'user', content: '注册一个匹配当前分钟的定时健康检查，然后列出所有定时任务。' },
];

// 一个 turn = 从当前消息出发，一直跑到模型不再请求工具为止。
// 每轮 Chat 前先消费 cron 队列，注入 [Scheduled] 消息。
// 不显式标注 Generator 泛型：让 TS 从 perform 的 yield* 推导 Next 类型（同 s01）。
function* agentTurn(perform: PerformFn<S14Effect>) {
  while (true) {
    // Layer 4: 消费已触发的 cron 任务 → 作为用户消息注入
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

// 运行一个 turn（由主流程或队列处理器调用）。
let lastAgentText = '';
async function runAgentTurn(): Promise<string> {
  const text = await runAgent<S14Effect, string>(agentTurn, s14Handlers);
  lastAgentText = text;
  return text;
}

// ============================================================
// Part 6: 队列处理器（真实定时器）
// ============================================================

// 有到期任务且 Agent 空闲（能 tryAcquire agentLock）时，唤醒一个 turn 消费队列。
let deliveredCount = 0;
let resolveDelivered: () => void;
const delivered = new Promise<void>(res => {
  resolveDelivered = res;
});

async function queueProcessorTick(): Promise<void> {
  if (!hasCronQueue()) return;
  const release = agentLock.tryAcquire();
  if (!release) return;
  try {
    if (!hasCronQueue()) return;
    console.log('\n[queue processor] delivering scheduled work');
    await runAgentTurn();
    deliveredCount++;
    if (deliveredCount === 1) resolveDelivered();
  } finally {
    release();
  }
}

// ============================================================
// Part 7: 启动入口
// ============================================================

console.log('[S14] Cron Scheduler 启动\n');
console.log(`持久化路径: ${SCHEDULED_TASKS_PATH}`);
console.log(`调度器周期: ${TICK_MS}ms，队列处理器周期: ${QUEUE_MS}ms\n`);

loadDurableJobs();
if (scheduledJobs.size > 0) {
  console.log(`启动时已恢复 ${scheduledJobs.size} 个 durable 任务`);
}

// 层 1：调度器——独立定时器，每秒检查 cron 表达式
const schedulerTimer = setInterval(() => {
  void cronSchedulerTick();
}, TICK_MS);

// 层 2：队列处理器——独立定时器，检查队列并唤醒 Agent
const queueTimer = setInterval(() => {
  void queueProcessorTick();
}, QUEUE_MS);

console.log('[cron] scheduler started');
console.log('[queue processor] started\n');

try {
  // 主流程发起第一个 turn。
  await agentLock.withLock(() => runAgentTurn());

  // 立即补一次调度检查：不依赖定时器相位，确保演示在 ~1s 内确定性触发。
  await cronSchedulerTick();

  // 等待队列处理器完成一次投递（带兜底超时，避免边界情况下永久挂起）。
  let guardTimer: NodeJS.Timeout | undefined;
  const winner = await Promise.race([
    delivered.then(() => 'delivered' as const),
    new Promise<'timeout'>(res => {
      guardTimer = setTimeout(() => res('timeout'), 10_000);
    }),
  ]);
  if (guardTimer) clearTimeout(guardTimer);
  if (winner === 'timeout') console.log('[warn] 等待 cron 投递超时，提前收尾');
} finally {
  // 清理定时器，保证进程可以退出。
  clearInterval(schedulerTimer);
  clearInterval(queueTimer);
}

// 展示 durable 持久化结果。
if (fs.existsSync(SCHEDULED_TASKS_PATH)) {
  const saved: CronJob[] = JSON.parse(fs.readFileSync(SCHEDULED_TASKS_PATH, 'utf8'));
  console.log(`\n[Persist] .scheduled_tasks.json (${saved.length} 个 durable 任务):`);
  saved.forEach(j => console.log(`  ${j.id}: cron="${j.cron}" [${j.recurring ? 'recurring' : 'one-shot'}]`));
}

console.log(`\n[S14] 完成: ${lastAgentText}`);
