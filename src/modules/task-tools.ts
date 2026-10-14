import type { TaskBoard } from "./tasks.ts";
import type { TaskStatus } from "./tasks.ts";

function parseTaskStatus(value: unknown): TaskStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "pending" || value === "in_progress" || value === "completed") {
    return value;
  }
  throw new Error(`非法任务状态: ${String(value)}`);
}

export function createTaskTools(board: TaskBoard) {
  return {
    create_task: async (args: Record<string, unknown>) => {
      const task = await board.create(String(args.subject ?? ""), String(args.description ?? ""));
      return JSON.stringify(task, null, 2);
    },
    list_tasks: async () => board.render(),
    get_task: async (args: Record<string, unknown>) => {
      return JSON.stringify(await board.get(Number(args.id)), null, 2);
    },
    update_task: async (args: Record<string, unknown>) => {
      const task = await board.update(Number(args.id), {
        status: parseTaskStatus(args.status),
        owner: args.owner === undefined ? undefined : String(args.owner),
      });
      return JSON.stringify(task, null, 2);
    },
  };
}
