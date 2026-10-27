/**
 * s20 的 cron 调度器（s14）—— 真实 setInterval + durable 持久化 + 触发队列。
 */

import * as fs from 'node:fs';

import { cronMatches, validateCron } from '../runtime/cron.ts';
import type { CronJob } from '../runtime/cron.ts';
import { SCHEDULED_TASKS_PATH } from '../runtime/workspace.ts';
import { truncate } from '../runtime/text.ts';
import { CRON_TICK_MS } from './config.ts';

export { validateCron };
export type { CronJob };

const cronJobs = new Map<string, CronJob>();
const cronQueue: CronJob[] = [];
const cronLastFired = new Map<string, string>();
let cronTimer: ReturnType<typeof setInterval> | undefined;

function minuteMarker(dt: Date): string {
  return `${dt.getFullYear()}-${dt.getMonth()}-${dt.getDate()}-${dt.getHours()}-${dt.getMinutes()}`;
}

function saveDurableJobs(): void {
  const durable = [...cronJobs.values()].filter((j) => j.durable);
  fs.writeFileSync(SCHEDULED_TASKS_PATH, JSON.stringify(durable, null, 2), 'utf8');
}

export function loadDurableJobs(): void {
  if (!fs.existsSync(SCHEDULED_TASKS_PATH)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(SCHEDULED_TASKS_PATH, 'utf8')) as CronJob[];
    for (const job of raw) {
      const err = validateCron(job.cron);
      if (err) {
        console.warn(`[cron] 跳过非法 durable 任务 ${job.id}: ${err}`);
        continue;
      }
      cronJobs.set(job.id, job);
    }
  } catch {
    /* 损坏的持久化文件忽略 */
  }
}

async function cronTick(): Promise<void> {
  const now = new Date();
  const marker = minuteMarker(now);
  for (const job of [...cronJobs.values()]) {
    try {
      if (!cronMatches(job.cron, now)) continue;
      if (cronLastFired.get(job.id) === marker) continue;
      cronLastFired.set(job.id, marker);
      cronQueue.push(job);
      console.log(`  \x1b[35m[cron] fired ${job.id}: ${truncate(job.prompt, 50)}\x1b[0m`);
      if (!job.recurring) {
        cronJobs.delete(job.id);
        if (job.durable) saveDurableJobs();
      }
    } catch (err) {
      // 单条坏任务/写盘失败不能打断整个调度器。
      console.warn(`[cron] tick 处理 ${job.id} 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function startCronScheduler(): void {
  cronTimer = setInterval(() => {
    void cronTick().catch((err: unknown) => {
      console.warn(`[cron] tick 失败: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, CRON_TICK_MS);
  cronTimer.unref?.();
}

export function stopCronScheduler(): void {
  if (cronTimer) {
    clearInterval(cronTimer);
    cronTimer = undefined;
  }
}

export function consumeCronQueue(): CronJob[] {
  const fired = cronQueue.slice();
  cronQueue.length = 0;
  return fired;
}

/** 登记一条 cron；durable 任务立即落盘。 */
export function scheduleCron(job: CronJob): void {
  cronJobs.set(job.id, job);
  cronLastFired.delete(job.id);
  if (job.durable) saveDurableJobs();
}

export function listCrons(): CronJob[] {
  return [...cronJobs.values()];
}

export function cancelCron(cronId: string): { cancelled: boolean; cronId: string } {
  const job = cronJobs.get(cronId);
  const cancelled = cronJobs.delete(cronId);
  // 已经命中并入队的任务也要撤掉，否则 cancel 成功后下一轮仍会注入。
  for (let i = cronQueue.length - 1; i >= 0; i -= 1) {
    if (cronQueue[i].id === cronId) cronQueue.splice(i, 1);
  }
  if (job?.durable) saveDurableJobs();
  return { cancelled, cronId };
}
