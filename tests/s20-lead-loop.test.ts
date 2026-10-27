import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PerformFn } from "../runtime/core.ts";
import type { S20Effect } from "../s20_comprehensive/effects.ts";

// lead-loop 的模块会加载 handlers/mailbox/config；先把工作区指到临时目录。
const workspace = mkdtempSync(join(tmpdir(), "lcc-s20-lead-loop-"));
process.env.AGENT_WORKSPACE = workspace;
process.env.AGENT_MODE = "mock";

const { leadLoop } = await import("../s20_comprehensive/lead-loop.ts");

type FakeEffect = { type: string; input: unknown };

function driveUntilChat(): void {
  const fakePerform = (function* (effect: FakeEffect): Generator<FakeEffect, unknown, unknown> {
    return yield effect;
  }) as unknown as PerformFn<S20Effect>;

  const gen = leadLoop(fakePerform) as unknown as Generator<FakeEffect, unknown, unknown>;
  let next: unknown;

  while (true) {
    const step = gen.next(next);
    if (step.done) {
      assert.fail(`leadLoop 意外结束，返回值: ${String(step.value)}`);
    }
    const effect = step.value as FakeEffect;
    switch (effect.type) {
      case "MCPConnect":
        next = { serverId: (effect.input as { serverId: string }).serverId, toolNames: [] };
        break;
      case "CheckInbox":
        next = { messages: [], shutdown: false };
        break;
      case "CollectBackgroundResults":
        next = [];
        break;
      case "PrepareContext":
        next = (effect.input as { messages: unknown[] }).messages;
        break;
      case "AssemblePrompt":
        next = "system";
        break;
      case "AssembleToolPool":
        next = [];
        break;
      case "Chat":
        // 模拟不可恢复的模型错误：leadLoop 必须往上抛，而不是返回 [Error] 字符串。
        assert.throws(() => gen.throw(new Error("boom")), /boom/);
        return;
      default:
        assert.fail(`未预期的 Effect: ${effect.type}`);
    }
  }
}

test("leadLoop 对不可恢复错误向上抛，不把失败编码成返回值", () => {
  driveUntilChat();
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});
