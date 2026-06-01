import { BackgroundTasks } from "./background.ts";
import { createDefaultPromptAssembler } from "./prompt.ts";
import { defaultPermissionPipeline } from "./permission.ts";
import { TodoList } from "./todos.ts";
import { TaskBoard } from "./tasks.ts";
import { MessageBus, TeamRoster } from "./team.ts";
import { MemoryStore } from "./memory.ts";
import { CronScheduler } from "./cron.ts";
import { McpToolPool } from "./mcp.ts";

export interface HarnessParts {
  todos: TodoList;
  tasks: TaskBoard;
  memory: MemoryStore;
  background: BackgroundTasks;
  team: {
    bus: MessageBus;
    roster: TeamRoster;
  };
  prompt: ReturnType<typeof createDefaultPromptAssembler>;
  permission: ReturnType<typeof defaultPermissionPipeline>;
  cron: CronScheduler;
  mcp: McpToolPool;
}

export function createTeachingHarness(root: string): HarnessParts {
  return {
    todos: new TodoList(),
    tasks: new TaskBoard(`${root}/.tasks`),
    memory: new MemoryStore(`${root}/.memory`),
    background: new BackgroundTasks(),
    team: {
      bus: new MessageBus(`${root}/.team/inbox`),
      roster: new TeamRoster(`${root}/.team`),
    },
    prompt: createDefaultPromptAssembler(),
    permission: defaultPermissionPipeline(root),
    cron: new CronScheduler(),
    mcp: new McpToolPool(),
  };
}
