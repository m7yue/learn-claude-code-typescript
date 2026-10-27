/**
 * 5 字段 cron 表达式的解析、匹配与校验 —— 全仓单一实现。
 *
 * s14 与 s20 共用：s14 用它驱动真实调度器，s20 用它判断定时任务是否命中。
 * 语法支持 * | N | *\/N | N-M | N,M；步长从字段最小值起算（日/月从 1 开始），
 * 日/星期同时受限时用标准 cron 的 OR 语义。
 */

export interface CronJob {
  id: string;
  cron: string;
  prompt: string;
  /** false = 触发一次后自动注销 */
  recurring: boolean;
  /** true = 持久化到磁盘（重启后保留） */
  durable: boolean;
}

/** 各字段的合法取值范围：minute hour day-of-month month day-of-week。 */
export const CRON_FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 6 },
] as const;

/**
 * 解析单个字段，返回它包含的所有值；表达式非法时返回错误字符串。
 *
 *   *       → min..max
 *   *\/N     → 从 min 开始，每隔 N 取一个
 *   N-M     → N..M
 *   N       → 单个值
 *   逗号    → 各部分的并集
 */
export function parseCronField(field: string, min: number, max: number): Set<number> | string {
  const values = new Set<number>();

  for (const rawPart of field.split(',')) {
    const part = rawPart.trim();
    let lo: number;
    let hi: number;
    let step = 1;

    if (part === '*') {
      lo = min;
      hi = max;
    } else if (part.startsWith('*/')) {
      const stepText = part.slice(2);
      if (!/^\d+$/.test(stepText)) return `Invalid step: ${part}`;
      step = Number(stepText);
      if (step <= 0) return `Step must be > 0: ${part}`;
      lo = min;
      hi = max;
    } else if (part.includes('-')) {
      const idx = part.indexOf('-');
      const loText = part.slice(0, idx);
      const hiText = part.slice(idx + 1);
      if (!/^\d+$/.test(loText) || !/^\d+$/.test(hiText)) return `Invalid range: ${part}`;
      lo = Number(loText);
      hi = Number(hiText);
      if (lo < min || lo > max || hi < min || hi > max) {
        return `Range ${part} out of bounds [${min}-${max}]`;
      }
      if (lo > hi) return `Range start > end: ${part}`;
    } else {
      if (!/^\d+$/.test(part)) return `Invalid field: ${part}`;
      lo = Number(part);
      if (lo < min || lo > max) return `Value ${lo} out of bounds [${min}-${max}]`;
      hi = lo;
    }

    for (let value = lo; value <= hi; value += step) values.add(value);
  }

  return values;
}

/** 5 字段 cron 匹配：分 时 日 月 周。 */
export function cronMatches(expr: string, dt: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const parsed: Array<Set<number>> = [];
  for (let i = 0; i < fields.length; i++) {
    const values = parseCronField(fields[i], CRON_FIELDS[i].min, CRON_FIELDS[i].max);
    // 非法表达式在注册/加载时已经被 validateCron 拒绝；这里只做防御。
    if (typeof values === 'string') return false;
    parsed.push(values);
  }

  const [minute, hour, dom, month, dow] = parsed;
  // JS 的 Date.getDay() 已经是 0=周日..6=周六，与 cron 一致。
  if (!minute.has(dt.getMinutes())) return false;
  if (!hour.has(dt.getHours())) return false;
  if (!month.has(dt.getMonth() + 1)) return false;

  const domUnconstrained = fields[2] === '*';
  const dowUnconstrained = fields[4] === '*';
  const domOk = dom.has(dt.getDate());
  const dowOk = dow.has(dt.getDay());
  if (domUnconstrained && dowUnconstrained) return true;
  if (domUnconstrained) return dowOk;
  if (dowUnconstrained) return domOk;
  return domOk || dowOk;
}

/** 校验 5 字段表达式；返回错误信息或 null。 */
export function validateCron(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return `Expected 5 fields, got ${fields.length}`;
  for (let i = 0; i < fields.length; i++) {
    const { name, min, max } = CRON_FIELDS[i];
    const values = parseCronField(fields[i], min, max);
    if (typeof values === 'string') return `${name}: ${values}`;
  }
  return null;
}
