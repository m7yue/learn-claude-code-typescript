import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskRecord {
  id: number;
  subject: string;
  description: string;
  status: TaskStatus;
  owner: string;
  worktree: string;
  createdAt: string;
  updatedAt: string;
}

export class TaskBoard {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async create(subject: string, description = ""): Promise<TaskRecord> {
    await this.init();
    const id = await this.nextId();
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id,
      subject,
      description,
      status: "pending",
      owner: "",
      worktree: "",
      createdAt: now,
      updatedAt: now,
    };
    await this.save(task);
    return task;
  }

  async get(id: number): Promise<TaskRecord> {
    return JSON.parse(await readFile(this.path(id), "utf8")) as TaskRecord;
  }

  async update(id: number, patch: Partial<Pick<TaskRecord, "status" | "owner" | "worktree">>): Promise<TaskRecord> {
    const task = await this.get(id);
    const next = { ...task, ...patch, updatedAt: new Date().toISOString() };
    await this.save(next);
    return next;
  }

  async bindWorktree(id: number, worktree: string, owner = ""): Promise<TaskRecord> {
    const task = await this.get(id);
    return this.update(id, {
      worktree,
      owner: owner || task.owner,
      status: task.status === "pending" ? "in_progress" : task.status,
    });
  }

  async list(): Promise<TaskRecord[]> {
    await this.init();
    const files = (await readdir(this.dir)).filter((name) => /^task_\d+\.json$/.test(name));
    const tasks = await Promise.all(files.map((name) => readFile(join(this.dir, name), "utf8").then(JSON.parse)));
    return tasks.sort((a, b) => a.id - b.id);
  }

  async render(): Promise<string> {
    const tasks = await this.list();
    if (tasks.length === 0) return "No tasks.";
    return tasks.map((task) => {
      const mark = task.status === "completed" ? "[x]" : task.status === "in_progress" ? "[>]" : "[ ]";
      const owner = task.owner ? ` owner=${task.owner}` : "";
      const wt = task.worktree ? ` wt=${task.worktree}` : "";
      return `${mark} #${task.id}: ${task.subject}${owner}${wt}`;
    }).join("\n");
  }

  private path(id: number): string {
    return join(this.dir, `task_${id}.json`);
  }

  private async save(task: TaskRecord): Promise<void> {
    await this.init();
    await writeFile(this.path(task.id), JSON.stringify(task, null, 2), "utf8");
  }

  private async nextId(): Promise<number> {
    const tasks = await this.list();
    return tasks.length === 0 ? 1 : Math.max(...tasks.map((task) => task.id)) + 1;
  }
}
