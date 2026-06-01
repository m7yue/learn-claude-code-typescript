import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { hasErrorCode } from "../core/errors.ts";
import type { TaskBoard } from "./tasks.ts";

const execFileAsync = promisify(execFile);

export interface WorktreeRecord {
  name: string;
  path: string;
  branch: string;
  taskId: number | null;
  status: "active" | "kept" | "removed";
}

export class WorktreeRegistry {
  private readonly root: string;
  private readonly indexPath: string;
  private readonly eventsPath: string;
  private readonly tasks: TaskBoard;

  constructor(root: string, tasks: TaskBoard) {
    this.root = root;
    this.tasks = tasks;
    this.indexPath = join(root, ".worktrees", "index.json");
    this.eventsPath = join(root, ".worktrees", "events.jsonl");
  }

  async init(): Promise<void> {
    await mkdir(join(this.root, ".worktrees"), { recursive: true });
    try {
      await readFile(this.indexPath, "utf8");
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
      await writeFile(this.indexPath, JSON.stringify({ worktrees: [] }, null, 2), "utf8");
    }
  }

  async create(name: string, taskId?: number): Promise<WorktreeRecord> {
    await this.init();
    const record: WorktreeRecord = {
      name,
      path: join(this.root, ".worktrees", name),
      branch: `wt/${name}`,
      taskId: taskId ?? null,
      status: "active",
    };
    await this.emit("worktree.create.before", record);
    await execFileAsync("git", ["worktree", "add", "-B", record.branch, record.path, "HEAD"], {
      cwd: this.root,
      timeout: 120_000,
    });
    const records = await this.list();
    await this.save([...records.filter((item) => item.name !== name), record]);
    if (taskId) await this.tasks.bindWorktree(taskId, name);
    await this.emit("worktree.create.after", record);
    return record;
  }

  async keep(name: string): Promise<WorktreeRecord> {
    const records = await this.list();
    const record = this.find(records, name);
    record.status = "kept";
    await this.save(records);
    await this.emit("worktree.keep", record);
    return record;
  }

  async remove(name: string, completeTask = false): Promise<WorktreeRecord> {
    const records = await this.list();
    const record = this.find(records, name);
    await this.emit("worktree.remove.before", record);
    await execFileAsync("git", ["worktree", "remove", record.path], {
      cwd: this.root,
      timeout: 120_000,
    });
    record.status = "removed";
    if (completeTask && record.taskId) {
      await this.tasks.update(record.taskId, { status: "completed", worktree: "" });
    }
    await this.save(records);
    await this.emit("worktree.remove.after", record);
    return record;
  }

  async run(name: string, command: string): Promise<string> {
    const record = this.find(await this.list(), name);
    const { stdout, stderr } = await execFileAsync("sh", ["-lc", command], {
      cwd: record.path,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    return `${stdout}${stderr}`.trim() || "(no output)";
  }

  async list(): Promise<WorktreeRecord[]> {
    await this.init();
    const index = JSON.parse(await readFile(this.indexPath, "utf8")) as { worktrees: WorktreeRecord[] };
    return index.worktrees;
  }

  async render(): Promise<string> {
    const records = await this.list();
    if (records.length === 0) return "No worktrees.";
    return records.map((item) => `${item.name} ${item.status} ${item.branch} task=${item.taskId ?? "-"}`).join("\n");
  }

  async events(limit = 20): Promise<string> {
    try {
      const lines = (await readFile(this.eventsPath, "utf8")).split("\n").filter(Boolean);
      return lines.slice(-limit).join("\n") || "No events.";
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return "No events.";
      throw error;
    }
  }

  private find(records: WorktreeRecord[], name: string): WorktreeRecord {
    const record = records.find((item) => item.name === name);
    if (!record) throw new Error(`未知 worktree: ${name}`);
    return record;
  }

  private async save(records: WorktreeRecord[]): Promise<void> {
    await this.init();
    await writeFile(this.indexPath, JSON.stringify({ worktrees: records }, null, 2), "utf8");
  }

  private async emit(event: string, record: WorktreeRecord): Promise<void> {
    await mkdir(join(this.root, ".worktrees"), { recursive: true });
    await appendFile(this.eventsPath, `${JSON.stringify({ event, worktree: record, ts: new Date().toISOString() })}\n`, "utf8");
  }
}

export function createWorktreeTools(registry: WorktreeRegistry) {
  return {
    worktree_list: async () => registry.render(),
    worktree_events: async (args: Record<string, unknown>) => registry.events(Number(args.limit ?? 20)),
    worktree_run: async (args: Record<string, unknown>) => {
      return registry.run(String(args.name ?? ""), String(args.command ?? ""));
    },
    worktree_keep: async (args: Record<string, unknown>) => {
      return JSON.stringify(await registry.keep(String(args.name ?? "")), null, 2);
    },
  };
}
