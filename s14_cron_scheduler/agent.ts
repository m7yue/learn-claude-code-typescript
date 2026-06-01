/**
 * s14: Cron Scheduler — 定时任务是时间维度的效应
 *
 * 本章新增 3 个 Effect：
 *   ScheduleCron        — 注册定时任务（cron 表达式 + 回调描述）
 *   CancelCron          — 取消定时任务
 *   ProcessCronQueue    — 处理到期的 cron 队列（返回触发列表）
 *
 * 核心思想：时间触发 = 效应延迟分发
 * Cron 系统持续检查调度表，到期则产生新效应（触发通知）。
 * 主 Agent 不轮询时钟，而是声明"何时该做什么"，Handler 负责计时。
 */

import { runAgent } from '../runtime/core.ts';
import type { BaseEffect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolUseBlock } from '../runtime/types.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

interface ChatEffect extends BaseEffect {
  type: 'Chat';
  input: { messages: Message[] };
  output: LLMResponse;
}

interface BashExecEffect extends BaseEffect {
  type: 'BashExec';
  input: { command: string };
  output: string;
}

interface CronJob {
  id: string;
  cron: string;        // "分 时 日 月 周" 5字段 cron 表达式
  prompt: string;      // 触发时注入 Agent 的描述
  recurring: boolean;  // false = 触发一次后删除
  durable: boolean;    // true = 持久化到磁盘（重启后保留）
  runCount: number;
  lastRunAt?: number;
}

interface CronTrigger {
  cronId: string;
  prompt: string;
  triggeredAt: number;
  runCount: number;
}

// s14 新增：Cron 调度
interface ScheduleCronEffect extends BaseEffect {
  type: 'ScheduleCron';
  input: { cronId: string; cron: string; prompt: string; recurring?: boolean; durable?: boolean };
  output: CronJob;
}

interface CancelCronEffect extends BaseEffect {
  type: 'CancelCron';
  input: { cronId: string };
  output: { cancelled: boolean };
}

interface ProcessCronQueueEffect extends BaseEffect {
  type: 'ProcessCronQueue';
  input: Record<string, never>;
  output: CronTrigger[];
}

type S14Effect = ChatEffect | BashExecEffect | ScheduleCronEffect | CancelCronEffect | ProcessCronQueueEffect;

// ============================================================
// Part 2: Handler 实现（Cron 调度器）
// ============================================================

const CRON_PERSIST_PATH = path.join(os.tmpdir(), 'learn-claude-code-typescript', 's14', '.scheduled_tasks.json');
const cronJobs = new Map<string, CronJob>();

// 持久化：保存所有 durable=true 的任务到磁盘
// 对应 CC 源码 cron.ts 的 durable task persistence
function persistDurableJobs(): void {
  const durableJobs = [...cronJobs.values()].filter(j => j.durable);
  if (durableJobs.length === 0) return;
  fs.mkdirSync(path.dirname(CRON_PERSIST_PATH), { recursive: true });
  fs.writeFileSync(CRON_PERSIST_PATH, JSON.stringify(durableJobs, null, 2), 'utf8');
}

// 启动时加载持久化任务
function loadDurableJobs(): void {
  if (!fs.existsSync(CRON_PERSIST_PATH)) return;
  try {
    const jobs: CronJob[] = JSON.parse(fs.readFileSync(CRON_PERSIST_PATH, 'utf8'));
    for (const job of jobs) {
      cronJobs.set(job.id, job);
    }
    console.log(`[CronInit] 恢复 ${jobs.length} 个持久化任务`);
  } catch {}
}

// ---- cron 表达式解析 ----
// 对应 CC 源码 cron.ts 的 parseCronExpression + isCronJobDue

// 单字段匹配：支持 * | 数字 | */N
function cronFieldMatches(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return !isNaN(step) && value % step === 0;
  }
  const num = parseInt(field, 10);
  return !isNaN(num) && num === value;
}

// 5字段 cron 匹配：分 时 日 月 周
// OR 语义：若 日 和 周 都不是 *，则满足其一即可（标准 cron 行为）
function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minF, hourF, domF, monF, dowF] = fields;

  if (!cronFieldMatches(minF, date.getMinutes())) return false;
  if (!cronFieldMatches(hourF, date.getHours())) return false;
  if (!cronFieldMatches(monF, date.getMonth() + 1)) return false;

  const domStar = domF === '*';
  const dowStar = dowF === '*';
  if (!domStar && !dowStar) {
    // 两者都非 *：OR 语义
    const domOk = cronFieldMatches(domF, date.getDate());
    const dowOk = cronFieldMatches(dowF, date.getDay());
    if (!domOk && !dowOk) return false;
  } else {
    if (!cronFieldMatches(domF, date.getDate())) return false;
    if (!cronFieldMatches(dowF, date.getDay())) return false;
  }
  return true;
}

function extractText(response: LLMResponse): string {
  return response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text).join('');
}

function getToolUseBlocks(response: LLMResponse): ToolUseBlock[] {
  return response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

// Mock LLM：注册 cron → 处理队列 → 取消
const mockResponses = [
  // 轮1：注册两个定时任务（"* * * * *" = 每分钟，立即匹配演示）
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '注册定时任务。' },
      {
        type: 'tool_use' as const, id: 'm1', name: 'schedule_cron',
        input: { cronId: 'health_check', cron: '* * * * *', prompt: '执行健康检查', recurring: true, durable: true }
      },
      {
        type: 'tool_use' as const, id: 'm2', name: 'schedule_cron',
        input: { cronId: 'cleanup', cron: '0 3 * * *', prompt: '清理临时文件', recurring: false, durable: false }
      },
    ],
  },
  // 轮2：处理 cron 队列（* * * * * 每分钟匹配当前分钟，演示时直接触发）
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '检查 cron 队列。' },
      { type: 'tool_use' as const, id: 'm3', name: 'process_cron_queue', input: {} },
    ],
  },
  // 轮3：再次处理队列
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '再次检查 cron 队列。' },
      { type: 'tool_use' as const, id: 'm4', name: 'process_cron_queue', input: {} },
    ],
  },
  // 轮4：取消清理任务
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '取消清理任务。' },
      { type: 'tool_use' as const, id: 'm5', name: 'cancel_cron', input: { cronId: 'cleanup' } },
    ],
  },
  // 轮5：结束
  {
    stop_reason: 'end_turn' as const,
    content: [{ type: 'text' as const, text: 'Cron 调度演示完成。cron 表达式注册、触发、取消、durable 持久化均已验证。' }],
  },
];

let roundIndex = 0;
function mockLLM(_messages: Message[]): LLMResponse {
  return mockResponses[Math.min(roundIndex++, mockResponses.length - 1)] as LLMResponse;
}

const s14Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const round = effect.input.messages.filter(m => m.role === 'assistant').length;
    console.log(`\n[Chat] → 轮次 ${round + 1}`);
    return mockLLM(effect.input.messages);
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    return `(执行: ${effect.input.command})`;
  },

  ScheduleCron: async (effect: ScheduleCronEffect): Promise<CronJob> => {
    const { cronId, cron, prompt, recurring = true, durable = false } = effect.input;
    const job: CronJob = { id: cronId, cron, prompt, recurring, durable, runCount: 0 };
    cronJobs.set(cronId, job);
    if (durable) persistDurableJobs();
    console.log(`[ScheduleCron] 注册: ${cronId} — cron="${cron}" durable=${durable} recurring=${recurring}`);
    console.log(`  触发时: "${prompt}"`);
    return job;
  },

  CancelCron: async (effect: CancelCronEffect): Promise<{ cancelled: boolean }> => {
    const { cronId } = effect.input;
    const existed = cronJobs.delete(cronId);
    if (existed) persistDurableJobs();
    console.log(`[CancelCron] ${cronId}: ${existed ? '已取消' : '不存在'}`);
    return { cancelled: existed };
  },

  ProcessCronQueue: async (_effect: ProcessCronQueueEffect): Promise<CronTrigger[]> => {
    const now = new Date();
    const triggers: CronTrigger[] = [];
    const toDelete: string[] = [];

    for (const [id, job] of cronJobs) {
      if (cronMatches(job.cron, now)) {
        job.runCount++;
        job.lastRunAt = Date.now();
        triggers.push({ cronId: id, prompt: job.prompt, triggeredAt: Date.now(), runCount: job.runCount });
        if (!job.recurring) {
          toDelete.push(id);
        }
      }
    }

    toDelete.forEach(id => cronJobs.delete(id));
    if (toDelete.length > 0) persistDurableJobs();

    if (triggers.length > 0) {
      console.log(`[ProcessCronQueue] ${triggers.length} 个任务触发:`);
      triggers.forEach(t => console.log(`  ↻ ${t.cronId} (第 ${t.runCount} 次): ${t.prompt}`));
    } else {
      console.log(`[ProcessCronQueue] 无到期任务 (活跃: ${cronJobs.size})`);
    }

    return triggers;
  },
};

// ============================================================
// Part 3: Agent Generator
// ============================================================

function* agentLoop(perform: PerformFn<S14Effect>) {
  const messages: Message[] = [
    { role: 'user', content: '注册定时健康检查和清理任务，演示 cron 表达式匹配和 durable 持久化。' },
  ];

  while (true) {
    const response = yield* perform({ type: 'Chat', input: { messages } });
    messages.push({ role: 'assistant', content: extractText(response) });

    if (response.stop_reason !== 'tool_use') {
      return extractText(response);
    }

    const toolResults: Array<{ tool_use_id: string; content: string }> = [];

    for (const block of getToolUseBlocks(response)) {
      let output: string;
      switch (block.name) {
        case 'bash':
          output = yield* perform({ type: 'BashExec', input: { command: block.input['command'] as string } });
          break;
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
          output = `已注册: ${job.id} (cron="${job.cron}", durable=${job.durable})`;
          break;
        }
        case 'cancel_cron': {
          const { cancelled } = yield* perform({
            type: 'CancelCron',
            input: { cronId: block.input['cronId'] as string },
          });
          output = cancelled ? `已取消: ${block.input['cronId']}` : `任务不存在: ${block.input['cronId']}`;
          break;
        }
        case 'process_cron_queue': {
          const triggers = yield* perform({ type: 'ProcessCronQueue', input: {} });
          if (triggers.length > 0) {
            // 把触发的 prompt 注入对话（通知 Agent 哪些定时任务到期了）
            output = `触发 ${triggers.length} 个任务:\n` +
              triggers.map(t => `  - ${t.cronId}: ${t.prompt}`).join('\n');
          } else {
            output = '无到期任务';
          }
          break;
        }
        default:
          output = `[未知工具] ${block.name}`;
      }
      toolResults.push({ tool_use_id: block.id, content: output });
    }

    messages.push({ role: 'user', content: JSON.stringify(toolResults) });
  }
}

// ============================================================
// Part 4: 启动入口
// ============================================================

loadDurableJobs();
console.log('[S14] Cron Scheduler 启动\n');
console.log(`持久化路径: ${CRON_PERSIST_PATH}\n`);

const result = await runAgent<S14Effect, string>(agentLoop, s14Handlers);

// 显示持久化文件内容
if (fs.existsSync(CRON_PERSIST_PATH)) {
  const saved = JSON.parse(fs.readFileSync(CRON_PERSIST_PATH, 'utf8'));
  console.log(`\n[Persist] .scheduled_tasks.json (${saved.length} 个 durable 任务):`);
  saved.forEach((j: CronJob) => console.log(`  ${j.id}: cron="${j.cron}" runCount=${j.runCount}`));
}

console.log('\n[S14] 完成:', result);
