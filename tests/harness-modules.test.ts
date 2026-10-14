import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronScheduler, cronMatches } from "../src/modules/cron.ts";
import { BackgroundTasks } from "../src/modules/background.ts";
import { MessageBus } from "../src/modules/team.ts";
import { toRuntimeTask, fromRuntimeTask } from "../src/modules/task-adapter.ts";
import { McpToolPool } from "../src/modules/mcp.ts";
import { defaultPermissionPipeline } from "../src/modules/permission.ts";
import { createDefaultPromptAssembler } from "../src/modules/prompt.ts";
import { ProtocolState } from "../src/modules/protocol.ts";
import { createWorktreeTools, WorktreeRegistry } from "../src/modules/worktrees.ts";
import type { TaskBoard } from "../src/modules/tasks.ts";

test("PermissionPipeline 区分 allow / ask / deny", () => {
  const permission = defaultPermissionPipeline("/repo");
  assert.equal(permission.check("bash", { command: "rm -rf /" }).decision, "deny");
  assert.equal(permission.check("bash", { command: "rm temp.txt" }).decision, "ask");
  assert.equal(permission.check("read_file", { path: "README.md" }).decision, "allow");
});

test("SystemPromptAssembler 根据上下文拼接 section", () => {
  const prompt = createDefaultPromptAssembler();
  const withoutTeam = prompt.assemble({ cwd: "/repo", hasTeam: false });
  const withTeam = prompt.assemble({ cwd: "/repo", hasTeam: true });
  assert.doesNotMatch(withoutTeam, /结构化消息/);
  assert.match(withTeam, /结构化消息/);
});

test("CronScheduler 只返回当前时间命中的 job", () => {
  const scheduler = new CronScheduler();
  scheduler.add({ name: "hit", cron: "30 8 * * *", prompt: "run", durable: false });
  scheduler.add({ name: "miss", cron: "31 8 * * *", prompt: "skip", durable: false });
  const date = new Date("2026-05-23T08:30:00");
  assert.equal(cronMatches("30 8 * * *", date), true);
  assert.deepEqual(scheduler.due(date).map((job) => job.name), ["hit"]);
});

test("McpToolPool 规范化名称并统一调用", async () => {
  const pool = new McpToolPool();
  const [name] = pool.connect("doc server", [
    { name: "search docs", description: "搜索文档", call: (args) => `query=${args.query}` },
  ]);
  assert.equal(name, "mcp__doc_server__search_docs");
  assert.equal(await pool.call(name, { query: "agent" }), "query=agent");
});

test("ProtocolState 能把 response 匹配回 request", () => {
  const state = new ProtocolState();
  const request = state.create({ from: "alice", to: "lead", kind: "shutdown", content: "任务完成" });
  const updated = state.applyResponse({
    type: "shutdown_response",
    from: "lead",
    content: "approved",
    timestamp: new Date().toISOString(),
    requestId: request.requestId,
    approved: true,
  });
  assert.equal(updated?.status, "approved");
});

test("cronMatches 支持 */N、区间、列表与日/周 OR 语义", () => {
  const date = new Date("2026-05-23T08:30:00"); // 周六 (dow=6), 23 号
  assert.equal(cronMatches("*/5 * * * *", date), true); // 30 能被 5 整除
  assert.equal(cronMatches("0-29 * * * *", date), false); // 30 不在 0..29 区间
  assert.equal(cronMatches("0-30 * * * *", date), true); // 30 在 0..30 区间
  assert.equal(cronMatches("30 * * * *", date), true);
  assert.equal(cronMatches("1,15,30 * * * *", date), true);
  assert.equal(cronMatches("30 8 23 * *", date), true); // minute=30 hour=8 dom=23
  assert.equal(cronMatches("30 8 23 * 1", date), true); // dom 命中即可（OR 语义）
  assert.equal(cronMatches("30 8 24 * 1", date), false); // dom=24 且 dow=1 都不命中
  assert.throws(() => cronMatches("bogus * * * *", date));
  assert.throws(() => cronMatches("* * * *", date));
});

test("CronScheduler 能持久化并恢复 durable 任务", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cron-"));
  const path = join(dir, ".scheduled_tasks.json");
  const scheduler = new CronScheduler();
  scheduler.add({ name: "keep", cron: "0 8 * * *", prompt: "run", durable: true });
  scheduler.add({ name: "volatile", cron: "0 9 * * *", prompt: "skip", durable: false });
  assert.equal(await scheduler.persist(path), 1);

  const restored = new CronScheduler();
  assert.equal(await restored.restore(path), 1);
  assert.deepEqual(restored.list().map((job) => job.name), ["keep"]);
});

test("BackgroundTasks 支持取消与超时", async () => {
  const tasks = new BackgroundTasks();
  const never = new Promise<string>(() => {});
  const timedOut = tasks.run("slow", () => never, { timeoutMs: 10 });
  await tasks.wait(timedOut);
  assert.equal(tasks.check(timedOut).status, "cancelled");

  const cancelled = tasks.run("long", () => never);
  assert.equal(tasks.cancel(cancelled), true);
  assert.equal(tasks.check(cancelled).status, "cancelled");

  const done = tasks.run("ok", async () => "result");
  assert.equal((await tasks.wait(done)).status, "completed");
  assert.equal(tasks.check(done).result, "result");
});

test("MessageBus peekInbox 不消费，readInbox 消费", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inbox-"));
  const bus = new MessageBus(dir);
  await bus.send({ from: "bob", to: "alice", content: "hi" });

  assert.equal((await bus.peekInbox("alice")).length, 1);
  assert.equal((await bus.peekInbox("alice")).length, 1); // 仍然存在
  assert.equal((await bus.readInbox("alice")).length, 1);
  assert.equal((await bus.peekInbox("alice")).length, 0); // 已被消费
});

test("createWorktreeTools 导出形状锁（未接入 harness，防止无意改名/接入）", () => {
  // 这些工具刻意不接入 harness（会真跑 git worktree 与 shell），
  // 形状锁保证：若有人改名或把 createWorktreeTools 接进 harness，这里会先失败。
  const registry = new WorktreeRegistry("/tmp/worktree-shape-lock", {} as TaskBoard);
  assert.deepEqual(Object.keys(createWorktreeTools(registry)).sort(), [
    "worktree_events",
    "worktree_keep",
    "worktree_list",
    "worktree_run",
  ]);
});

test("task-adapter 能在两套 TaskRecord 之间往返", () => {
  const runtimeTask = {
    id: "7",
    subject: "refactor",
    description: "拆分模块",
    status: "pending" as const,
    owner: null,
    blockedBy: ["3"],
  };
  const moduleTask = fromRuntimeTask(runtimeTask);
  assert.equal(moduleTask.id, 7);
  assert.equal(moduleTask.owner, "");
  assert.deepEqual(moduleTask.blockedBy, ["3"]);

  const back = toRuntimeTask(moduleTask);
  assert.equal(back.id, "7");
  assert.equal(back.owner, null);
  assert.deepEqual(back.blockedBy, ["3"]);
});
