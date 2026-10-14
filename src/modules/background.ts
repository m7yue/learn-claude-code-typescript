export type BackgroundStatus = "running" | "completed" | "failed" | "cancelled";

export interface BackgroundJob {
  id: string;
  label: string;
  status: BackgroundStatus;
  result?: string;
  error?: string;
}

export interface BackgroundRunOptions {
  /** 外部取消信号：触发即把任务标记为 cancelled。 */
  signal?: AbortSignal;
  /** 超时毫秒数：到时仍未完成则标记 cancelled。 */
  timeoutMs?: number;
}

export class BackgroundTasks {
  private readonly jobs = new Map<string, BackgroundJob>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly settled = new Map<string, Promise<void>>();

  run(label: string, work: () => Promise<string>, options: BackgroundRunOptions = {}): string {
    const id = crypto.randomUUID();
    const job: BackgroundJob = { id, label, status: "running" };
    this.jobs.set(id, job);

    const controller = new AbortController();
    this.controllers.set(id, controller);

    let timer: NodeJS.Timeout | undefined;
    let finished = false;
    let resolveDone!: () => void;
    // done 由「任务完成」或「取消/超时」任意一方先触发；
    // 这样即使 work 永不 resolve，wait() 也能在取消后及时返回。
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      this.controllers.delete(id);
      resolveDone();
    };

    const cancel = () => {
      if (job.status === "running") {
        job.status = "cancelled";
        controller.abort();
      }
      finish();
    };

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(cancel, options.timeoutMs);
      timer.unref?.();
    }
    // 外部 cancel(id) 会 abort 内部 controller，这里同步 resolve done。
    controller.signal.addEventListener("abort", finish, { once: true });
    options.signal?.addEventListener("abort", cancel, { once: true });

    void work()
      .then((result) => {
        if (job.status === "running") {
          job.status = "completed";
          job.result = result;
        }
      })
      .catch((error) => {
        if (job.status === "running") {
          job.status = "failed";
          job.error = error instanceof Error ? error.message : String(error);
        }
      })
      .finally(finish);

    this.settled.set(id, done);
    return id;
  }

  check(id: string): BackgroundJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`未知后台任务: ${id}`);
    return { ...job };
  }

  list(): BackgroundJob[] {
    return [...this.jobs.values()].map((job) => ({ ...job }));
  }

  /** 主动取消一个仍在运行的任务。 */
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return false;
    job.status = "cancelled";
    this.controllers.get(id)?.abort();
    return true;
  }

  /** 等待任务进入终态（不与取消/超时冲突：被取消也会返回）。 */
  async wait(id: string): Promise<BackgroundJob> {
    await this.settled.get(id);
    return this.check(id);
  }
}
