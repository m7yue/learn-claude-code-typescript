import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarnessTools } from "../src/modules/harness-tools.ts";
import { specsToToolDefinitions } from "../src/core/tool-specs.ts";
import { TaskBoard } from "../src/modules/tasks.ts";
import { MessageBus, TeamRoster } from "../src/modules/team.ts";
import { TodoList } from "../src/modules/todos.ts";

// 无参数工具（schema.properties 允许为空）的白名单。
const NO_ARG_TOOLS = new Set(["list_tasks", "list_team", "todo_read"]);

function build(cwd = "/tmp/harness-tools-test") {
  return buildHarnessTools({
    cwd,
    tasks: new TaskBoard(join(cwd, ".tasks")),
    team: {
      bus: new MessageBus(join(cwd, ".team", "inbox")),
      roster: new TeamRoster(join(cwd, ".team")),
    },
    todos: new TodoList(),
  });
}

test("definitions 与 handlers 的名字集合完全相等（杜绝漂移）", () => {
  const { definitions, handlers } = build();
  const defNames = definitions.map((d) => d.name).sort();
  const handlerNames = Object.keys(handlers).sort();
  assert.deepEqual(defNames, handlerNames);
});

test("每个工具定义都带非空 input_schema（无参工具除外）", () => {
  const { definitions } = build();
  assert.ok(definitions.length > 0);
  for (const definition of definitions) {
    assert.equal(definition.parameters?.type, "object", `${definition.name}: 缺少 object schema`);
    const properties = (definition.parameters?.properties ?? {}) as Record<string, unknown>;
    if (NO_ARG_TOOLS.has(definition.name)) continue;
    assert.ok(
      Object.keys(properties).length > 0,
      `${definition.name}: 非无参工具却有空的 properties（正是修复前的 bug）`,
    );
  }
});

test("specsToToolDefinitions 对未注册名字抛错", () => {
  assert.throws(() => specsToToolDefinitions("not_a_tool"), /未注册的工具 schema: not_a_tool/);
});

test("bash 非零退出返回错误字符串，循环可以继续", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lcc-harness-tools-"));
  try {
    const { handlers } = build(cwd);
    const result = await handlers.bash({
      command: "node -e 'console.error(\"boom\"); process.exit(3)'",
    });
    assert.match(result, /Error: 命令退出码 3/);
    assert.match(result, /boom/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("buildHarnessTools 覆盖 base/任务/团队/待办四类工具", () => {
  const { handlers } = build();
  for (const name of [
    "bash",
    "read_file",
    "write_file",
    "edit_file",
    "glob",
    "create_task",
    "list_tasks",
    "get_task",
    "update_task",
    "send_message",
    "check_inbox",
    "broadcast",
    "list_team",
    "todo_write",
    "todo_read",
  ]) {
    assert.equal(typeof handlers[name], "function", `缺少 handler: ${name}`);
  }
});
