import test from "node:test";
import assert from "node:assert/strict";
import { CronScheduler, cronMatches } from "../src/modules/cron.ts";
import { McpToolPool } from "../src/modules/mcp.ts";
import { defaultPermissionPipeline } from "../src/modules/permission.ts";
import { createDefaultPromptAssembler } from "../src/modules/prompt.ts";
import { ProtocolState } from "../src/modules/protocol.ts";

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
