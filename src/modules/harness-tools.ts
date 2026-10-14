/**
 * 组装完整 harness 的工具集（base + 任务 + 团队 + 待办）。
 *
 * 关键约束：definitions 由 handlers 的键派生，因此
 * 「有 handler 却没有注册 spec」会在启动时（specsToToolDefinitions → specFor）立刻抛错，
 * 结构上杜绝工程层与注册表之间的漂移。
 *
 * 抽出成纯工厂（而不是写在 src/harness.ts 里）是为了让测试可以直接 import，
 * 因为 src/harness.ts 顶层 await runAgent(...)，不可被测试导入。
 */

import { specsToToolDefinitions } from "../core/tool-specs.ts";
import type { ToolDefinition } from "../core/types.ts";
import type { TaskBoard } from "./tasks.ts";
import { createTaskTools } from "./task-tools.ts";
import { createTeamTools, type MessageBus, type TeamRoster } from "./team.ts";
import type { TodoList } from "./todos.ts";
import { createTodoTools } from "./todos.ts";
import { createBaseTools } from "./tools.ts";

export interface HarnessToolParts {
  cwd: string;
  tasks: TaskBoard;
  team: { bus: MessageBus; roster: TeamRoster };
  todos: TodoList;
}

export interface HarnessTools {
  definitions: ToolDefinition[];
  handlers: Record<string, (args: Record<string, unknown>) => Promise<string> | string>;
}

export function buildHarnessTools(parts: HarnessToolParts): HarnessTools {
  const handlers: HarnessTools["handlers"] = {
    ...createBaseTools({ cwd: parts.cwd }),
    ...createTaskTools(parts.tasks),
    ...createTeamTools({ bus: parts.team.bus, roster: parts.team.roster, self: "main" }),
    ...createTodoTools(parts.todos),
  };

  const definitions = specsToToolDefinitions(...Object.keys(handlers));
  return { definitions, handlers };
}
