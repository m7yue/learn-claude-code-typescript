export interface CronJob {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  durable: boolean;
}

export function cronMatches(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron 必须是 5 段: minute hour day month weekday");
  const values = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
  return parts.every((part, index) => part === "*" || Number(part) === values[index]);
}

export class CronScheduler {
  private readonly jobs: CronJob[] = [];

  add(job: Omit<CronJob, "id">): CronJob {
    const created = { id: crypto.randomUUID(), ...job };
    cronMatches(created.cron, new Date());
    this.jobs.push(created);
    return created;
  }

  due(date = new Date()): CronJob[] {
    return this.jobs.filter((job) => cronMatches(job.cron, date));
  }

  list(): CronJob[] {
    return [...this.jobs];
  }
}
