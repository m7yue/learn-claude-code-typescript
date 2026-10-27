import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// tasks.ts 在模块加载时读取 TASKS_DIR；必须在 import 前指定临时工作区。
const workspace = mkdtempSync(join(tmpdir(), "lcc-s20-tasks-"));
process.env.AGENT_WORKSPACE = workspace;

const {
  canStart,
  claimTask,
  completeTask,
  createTask,
  formatTaskList,
  listTasksOrdered,
  loadTask,
} = await import("../s20_comprehensive/tasks.ts");

test("缺失依赖被视为阻塞，不会让任务被错误放行", () => {
  const task = createTask("依赖缺失", "", ["task_does_not_exist"]);
  assert.equal(canStart(task.id), false);

  const claim = claimTask(task.id, "worker");
  assert.equal(claim.ok, false);
  assert.match(claim.error ?? "", /blocked by/);
});

test("依赖完成后才可认领，完成只解锁直接下游", () => {
  const a = createTask("A", "", []);
  const b = createTask("B", "", [a.id]);
  const c = createTask("C", "", []);

  assert.equal(canStart(a.id), true);
  assert.equal(canStart(b.id), false);
  assert.equal(claimTask(b.id, "worker").ok, false);

  assert.equal(claimTask(a.id, "worker").ok, true);
  const doneA = completeTask(a.id, "worker");
  assert.equal(doneA.ok, true);
  assert.deepEqual(doneA.unblocked, [b.id]);
  assert.equal(doneA.unblocked.includes(c.id), false);

  assert.equal(canStart(b.id), true);
  assert.equal(claimTask(b.id, "worker").ok, true);
});

test("完成必须由持有者执行", () => {
  const task = createTask("归属检查", "", []);
  assert.equal(claimTask(task.id, "worker").ok, true);

  const wrong = completeTask(task.id, "other");
  assert.equal(wrong.ok, false);
  assert.match(wrong.error ?? "", /owned by worker/);

  assert.equal(completeTask(task.id, "worker").ok, true);
});

test("preferredOwner 预订的任务只能由预订者认领", () => {
  const task = createTask("预订任务", "", [], "worker");
  const wrong = claimTask(task.id, "lead");
  assert.equal(wrong.ok, false);
  assert.match(wrong.error ?? "", /reserved for worker/);
  assert.equal(claimTask(task.id, "worker").ok, true);
});

test("任务 ID 不能逃出 .tasks，损坏 JSON 只跳过不崩", () => {
  assert.equal(loadTask("../../etc/passwd"), null);
  assert.equal(claimTask("../../etc/passwd", "worker").ok, false);

  mkdirSync(join(workspace, ".tasks"), { recursive: true });
  writeFileSync(join(workspace, ".tasks", "task_broken.json"), "{not json", "utf8");
  assert.equal(loadTask("task_broken"), null);
  assert.equal(
    listTasksOrdered().some((t) => t.id === "task_broken"),
    false,
  );
});

test("formatTaskList 展示 blockedBy 依赖边", () => {
  const a = createTask("依赖上游", "", []);
  const b = createTask("依赖下游", "", [a.id]);
  const text = formatTaskList(listTasksOrdered());
  assert.match(text, new RegExp(`blockedBy: ${a.id}`));
  assert.ok(text.includes(b.id));
});

test("listTasksOrdered 能读回本轮创建的任务", () => {
  const before = listTasksOrdered().length;
  createTask("新任务", "", []);
  assert.equal(listTasksOrdered().length, before + 1);
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});
