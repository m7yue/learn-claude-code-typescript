import test from "node:test";
import assert from "node:assert/strict";
import { TOOL_SPECS, schemasFor, specFor } from "../runtime/tool-schemas.ts";

test("TOOL_SPECS 的键与 spec.name 一致，且描述/结构合法", () => {
  const entries = Object.entries(TOOL_SPECS);
  assert.ok(entries.length > 0, "注册表不应为空");

  for (const [key, spec] of entries) {
    assert.equal(spec.name, key, `${key}: spec.name 必须等于注册键`);
    assert.equal(typeof spec.description, "string");
    assert.ok(spec.description.trim().length > 0, `${key}: description 不能为空`);
    assert.equal(spec.input_schema.type, "object", `${key}: input_schema.type 必须是 object`);

    const properties = (spec.input_schema.properties ?? {}) as Record<string, unknown>;
    const required = (spec.input_schema.required ?? []) as string[];
    for (const name of required) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(properties, name),
        `${key}: required 中的 ${name} 必须出现在 properties 中`,
      );
    }
  }
});

test("specFor / schemasFor 对未注册名称直接抛错（不再静默丢弃）", () => {
  assert.throws(() => specFor("nope"), /未注册的工具 schema: nope/);
  assert.throws(() => schemasFor("bash", "nope"), /未注册的工具 schema: nope/);
  assert.equal(schemasFor("bash").length, 1);
  assert.equal(schemasFor("bash")[0].name, "bash");
});

test("注册表名称快照（防止无意增删/改名）", () => {
  assert.deepEqual(Object.keys(TOOL_SPECS).sort(), [
    "auto_claim",
    "bash",
    "bind_worktree",
    "broadcast",
    "cancel_cron",
    "check_inbox",
    "claim_task",
    "compact",
    "complete_task",
    "create_task",
    "create_worktree",
    "edit_file",
    "get_task",
    "glob",
    "idle_poll",
    "keep_worktree",
    "list_crons",
    "list_tasks",
    "list_team",
    "load_skill",
    "read_file",
    "read_memory",
    "remove_worktree",
    "request_plan",
    "request_shutdown",
    "review_plan",
    "scan_unclaimed",
    "schedule_cron",
    "select_memory",
    "send_message",
    "spawn_teammate",
    "submit_plan",
    "task",
    "todo_read",
    "todo_write",
    "update_task",
    "write_file",
    "write_memory",
  ]);
});

test("关键工具的 required 与章节实际入参对齐", () => {
  const required = (name: string) =>
    (specFor(name).input_schema.required ?? []) as string[];

  assert.deepEqual(required("bash"), ["command"]);
  assert.deepEqual(required("claim_task"), ["taskId"]);
  assert.deepEqual(required("send_message"), ["to", "body"]);
  assert.deepEqual(required("compact"), ["reason"]);
  assert.deepEqual(required("create_task"), ["subject"]);
  assert.deepEqual(required("spawn_teammate"), ["agentId", "role"]);
  assert.deepEqual(required("review_plan"), ["requestId", "reviewerId"]);
  assert.deepEqual(required("idle_poll"), ["pollIntervalMs"]);
  assert.deepEqual(required("auto_claim"), ["owner"]);
  // 双方言的超集 schema：无 required
  assert.deepEqual(required("get_task"), []);
  assert.deepEqual(required("read_memory"), []);
  assert.deepEqual(required("write_memory"), []);
});
