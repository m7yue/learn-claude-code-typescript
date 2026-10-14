import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hasErrorCode } from "../core/errors.ts";

export interface CronJob {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  durable: boolean;
}

/** 各字段的合法取值范围：[minute, hour, dayOfMonth, month, dayOfWeek] */
const FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

function parseField(field: string, index: number): Set<number> {
  const [min, max] = FIELD_RANGES[index];
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`非法 cron 步长: "${part}"`);
    }

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a > b) {
        throw new Error(`非法 cron 区间: "${part}"`);
      }
      start = a;
      end = b;
    } else {
      const value = Number(rangePart);
      if (!Number.isInteger(value)) throw new Error(`非法 cron 字段: "${part}"`);
      start = value;
      // 单值 + 步长无意义，按单值处理
      end = stepPart === undefined ? value : max;
    }

    if (start < min || end > max) {
      throw new Error(`cron 字段越界 (${min}-${max}): "${part}"`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }

  return values;
}

/**
 * 5 字段 cron 匹配：分 时 日 月 周
 * 支持 * | N | N-M | *\/N | N-M\/N | N,M（可组合）
 * 日/周 OR 语义：两者都非 * 时满足其一即可（标准 cron 行为）
 */
export function cronMatches(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron 必须是 5 段: minute hour day month weekday");

  const [minute, hour, dom, month, dow] = parts.map(parseField);
  const values = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];

  if (!minute.has(values[0]) || !hour.has(values[1]) || !month.has(values[3])) return false;

  const domStar = parts[2] === "*";
  const dowStar = parts[4] === "*";
  if (!domStar && !dowStar) {
    return dom.has(values[2]) || dow.has(values[4]);
  }
  return dom.has(values[2]) && dow.has(values[4]);
}

export interface CronSchedulerOptions {
  intervalMs?: number;
  onDue: (job: CronJob, date: Date) => void;
  signal?: AbortSignal;
}

export class CronScheduler {
  private readonly jobs: CronJob[] = [];

  add(job: Omit<CronJob, "id">): CronJob {
    const created = { id: crypto.randomUUID(), ...job };
    cronMatches(created.cron, new Date()); // 注册即校验表达式
    this.jobs.push(created);
    return created;
  }

  due(date = new Date()): CronJob[] {
    return this.jobs.filter((job) => cronMatches(job.cron, date));
  }

  list(): CronJob[] {
    return [...this.jobs];
  }

  /** 启动轮询循环：每个 interval 检查一次到期任务。返回 stop 用于停止。 */
  start(options: CronSchedulerOptions): { stop: () => void } {
    const intervalMs = options.intervalMs ?? 1000;
    const timer = setInterval(() => {
      const now = new Date();
      for (const job of this.due(now)) options.onDue(job, now);
    }, intervalMs);
    timer.unref?.();

    const stop = () => clearInterval(timer);
    options.signal?.addEventListener("abort", stop, { once: true });
    return { stop };
  }

  /** 把 durable=true 的任务持久化到磁盘。 */
  async persist(path: string): Promise<number> {
    const durableJobs = this.jobs.filter((job) => job.durable);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(durableJobs, null, 2), "utf8");
    return durableJobs.length;
  }

  /** 从磁盘恢复 durable 任务（已在内存中的同名任务不覆盖）。 */
  async restore(path: string): Promise<number> {
    let jobs: CronJob[];
    try {
      jobs = JSON.parse(await readFile(path, "utf8")) as CronJob[];
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return 0;
      throw error;
    }
    let restored = 0;
    for (const job of jobs) {
      if (!this.jobs.some((item) => item.name === job.name)) {
        this.jobs.push(job);
        restored += 1;
      }
    }
    return restored;
  }
}
