import type { TaskBoard, TaskRecord } from "./tasks.ts";

export class AutonomousWorker {
  private readonly name: string;
  private readonly board: TaskBoard;

  constructor(name: string, board: TaskBoard) {
    this.name = name;
    this.board = board;
  }

  async scanAndClaim(): Promise<TaskRecord | undefined> {
    const tasks = await this.board.list();
    const claimable = tasks.find((task) => task.status === "pending" && !task.owner);
    if (!claimable) return undefined;
    return this.board.update(claimable.id, { status: "in_progress", owner: this.name });
  }
}
