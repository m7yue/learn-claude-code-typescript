import test from "node:test";
import assert from "node:assert/strict";
import { validateTaskDefinition } from "../evals/task-definition.ts";
import { loadTask, loadTasks } from "../evals/loader.ts";
import { TASK_IDS, TASK_MODULES } from "../evals/tasks/index.ts";

test("三个任务都能加载，且都提供关键词和 reference 要点", () => {
  const tasks = loadTasks();
  assert.equal(tasks.length, TASK_IDS.length);

  for (const task of tasks) {
    assert.ok(task.promptTemplate.trim(), `${task.id} 的 prompt 为空`);
    assert.ok(task.expectKeywords.length > 0, `${task.id} 的 expectKeywords 为空`);
    assert.ok(task.referencePoints.length > 0, `${task.id} 的 referencePoints 为空`);
    assert.ok(task.checks.length > 0, `${task.id} 没有检查`);
    assert.ok(task.selfCheck.gold.length > 0, `${task.id} 没有 gold 脚本`);
    assert.ok(task.selfCheck.broken.length > 0, `${task.id} 没有 broken 脚本`);
  }
});

test("首批任务覆盖 6 种检查类型", () => {
  const types = new Set(loadTasks().flatMap((task) => task.checks.map((check) => check.type)));
  assert.deepEqual([...types].sort(), [
    "command",
    "file-content",
    "file-missing",
    "file-unchanged",
    "final-answer",
    "tools-used",
  ]);
});

test("未知任务 id 直接报错", () => {
  assert.throws(() => loadTask("not-a-task"), /未知任务/);
});

test("validateTaskDefinition 拒绝空标题和重复检查 id", () => {
  const emptyTitle = structuredClone(TASK_MODULES["read-file-answer"]);
  emptyTitle.title = "";
  assert.throws(() => validateTaskDefinition(emptyTitle), /title/);

  const duplicateIds = structuredClone(TASK_MODULES["read-file-answer"]);
  duplicateIds.checks = [duplicateIds.checks[0], { ...duplicateIds.checks[0] }];
  assert.throws(() => validateTaskDefinition(duplicateIds), /检查 id 重复/);
});

test("validateTaskDefinition 拒绝非法正则和越界路径", () => {
  const badRegex = structuredClone(TASK_MODULES["read-file-answer"]);
  badRegex.checks.push({ id: "bad-regex", type: "final-answer", matches: "[" });
  assert.throws(() => validateTaskDefinition(badRegex), /正则/);

  const badPath = structuredClone(TASK_MODULES["fix-single-file"]);
  badPath.checks.push({ id: "bad-path", type: "file-unchanged", path: "/tmp/outside" });
  assert.throws(() => validateTaskDefinition(badPath), /工作区内相对路径/);
});

test("validateTaskDefinition 要求 selfCheck 最后一步是 final", () => {
  const task = structuredClone(TASK_MODULES["read-file-answer"]);
  task.selfCheck.gold = [
    { tool: "read_file", args: { path: "docs/architecture.md" } },
  ];
  assert.throws(() => validateTaskDefinition(task), /最后一步必须是 final/);
});
