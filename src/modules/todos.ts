export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm: string;
}

export class TodoList {
  private items: TodoItem[] = [];

  update(items: TodoItem[]): string {
    let activeCount = 0;
    const next = items.map((item, index) => {
      const content = item.content.trim();
      const activeForm = item.activeForm.trim();
      if (!content) throw new Error(`Todo ${index}: content 不能为空`);
      if (!activeForm) throw new Error(`Todo ${index}: activeForm 不能为空`);
      if (!["pending", "in_progress", "completed"].includes(item.status)) {
        throw new Error(`Todo ${index}: 非法状态 ${item.status}`);
      }
      if (item.status === "in_progress") activeCount += 1;
      return { content, status: item.status, activeForm };
    });

    if (next.length > 20) throw new Error("Todo 最多 20 条");
    if (activeCount > 1) throw new Error("同时只能有一个 in_progress");
    this.items = next;
    return this.render();
  }

  render(): string {
    if (this.items.length === 0) return "暂无 Todo";
    const lines = this.items.map((item) => {
      const mark = item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[>]" : "[ ]";
      const suffix = item.status === "in_progress" ? ` <- ${item.activeForm}` : "";
      return `${mark} ${item.content}${suffix}`;
    });
    const done = this.items.filter((item) => item.status === "completed").length;
    return `${lines.join("\n")}\n\n(${done}/${this.items.length} completed)`;
  }

  hasOpenItems(): boolean {
    return this.items.some((item) => item.status !== "completed");
  }
}

export function createTodoTools(todoList: TodoList) {
  return {
    TodoWrite: (args: Record<string, unknown>) => {
      const items = Array.isArray(args.items) ? args.items : [];
      return todoList.update(items as TodoItem[]);
    },
    TodoRead: () => todoList.render(),
  };
}
