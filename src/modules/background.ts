export interface BackgroundJob {
  id: string;
  label: string;
  status: "running" | "completed" | "failed";
  result?: string;
  error?: string;
}

export class BackgroundTasks {
  private readonly jobs = new Map<string, BackgroundJob>();

  run(label: string, work: () => Promise<string>): string {
    const id = crypto.randomUUID();
    const job: BackgroundJob = { id, label, status: "running" };
    this.jobs.set(id, job);

    void work()
      .then((result) => {
        job.status = "completed";
        job.result = result;
      })
      .catch((error) => {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
      });

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
}
