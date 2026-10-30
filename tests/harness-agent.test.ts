import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, ModelTurn } from "../src/core/types.ts";
import {
  createHarnessAgent,
  type HarnessObserver,
} from "../src/harness-agent.ts";

/** 按顺序返回预设回合；回合用完后重复最后一个，避免测试挂起。 */
class FakeModel implements Model {
  private index = 0;
  private readonly turns: ModelTurn[];

  constructor(turns: ModelTurn[]) {
    this.turns = turns;
  }

  async complete(): Promise<ModelTurn> {
    const turn = this.turns[Math.min(this.index, this.turns.length - 1)];
    this.index += 1;
    return turn;
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "lcc-harness-agent-"));
}

test("createHarnessAgent 执行工具并记录观察事件", async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, "note.txt"), "hello", "utf8");
  const events: string[] = [];
  const observer: HarnessObserver = {
    onModelTurn: (event) => events.push(`model:${event.turn}:${event.stopReason}`),
    onToolCall: (event) => events.push(`tool:${event.name}:${event.result}:${event.error}`),
  };
  const model = new FakeModel([
    {
      stopReason: "tool_use",
      content: "读取",
      toolUses: [{ id: "1", name: "read_file", args: { path: "note.txt" } }],
    },
    {
      stopReason: "end",
      content: "完成",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  ]);

  try {
    const agent = createHarnessAgent({ cwd, model, observer });
    const result = await agent.run("读取 note.txt");

    assert.equal(result.finalAnswer, "完成");
    assert.deepEqual(events, [
      "model:1:tool_use",
      "tool:read_file:hello:false",
      "model:2:end",
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("观察器能拿到 usage 和 max_tokens 信号", async () => {
  const cwd = tempDir();
  let stopReason = "";
  let inputTokens: number | undefined;
  const observer: HarnessObserver = {
    onModelTurn: (event) => {
      stopReason = event.stopReason;
      inputTokens = event.usage?.input_tokens;
    },
  };
  const model = new FakeModel([
    {
      stopReason: "max_tokens",
      content: "被截断的回答",
      usage: { input_tokens: 7, output_tokens: 3 },
    },
  ]);

  try {
    const agent = createHarnessAgent({ cwd, model, observer });
    const result = await agent.run("随便说点什么");

    assert.equal(result.finalAnswer, "被截断的回答");
    assert.equal(stopReason, "max_tokens");
    assert.equal(inputTokens, 7);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("需要审批的工具默认被拒绝，循环继续", async () => {
  const cwd = tempDir();
  const approvals: Array<{
    toolName: string;
    decision: string;
    approved: boolean;
    requestReason: string;
  }> = [];
  const observer: HarnessObserver = {
    onApproval: (event) =>
      approvals.push({
        toolName: event.toolName,
        decision: event.decision,
        approved: event.approved,
        requestReason: event.requestReason,
      }),
  };
  const model = new FakeModel([
    {
      stopReason: "tool_use",
      content: "删除 build",
      toolUses: [{ id: "1", name: "bash", args: { command: "rm -rf build" } }],
    },
    { stopReason: "end", content: "已停止" },
  ]);

  try {
    const agent = createHarnessAgent({ cwd, model, observer });
    const result = await agent.run("删除 build 目录");

    assert.equal(result.finalAnswer, "已停止");
    assert.deepEqual(approvals, [
      {
        toolName: "bash",
        decision: "ask",
        approved: false,
        requestReason: "工具 bash 需要审批",
      },
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
