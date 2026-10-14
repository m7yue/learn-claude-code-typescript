import test from "node:test";
import assert from "node:assert/strict";
import { agentLoop, createCoreHandlers, runAgent } from "../src/core/agent.ts";
import { ScriptedModel, finalTurn, toolTurn } from "../src/core/scripted-model.ts";
import type { ToolDefinition } from "../src/core/types.ts";

const bashTool: ToolDefinition = {
  name: "bash",
  description: "执行 shell 命令",
  parameters: { type: "object", properties: { command: { type: "string" } } },
};

function setup() {
  const executed: string[] = [];
  const model = new ScriptedModel([
    toolTurn("bash", { command: "echo hi" }),
    finalTurn("完成"),
  ]);
  const tools = {
    bash: (args: Record<string, unknown>) => {
      executed.push(String(args.command));
      return `ran:${args.command}`;
    },
  };
  return { executed, model, tools };
}

test("审批通过时工具正常执行", async () => {
  const { executed, model, tools } = setup();
  const messages = await runAgent(
    agentLoop({
      system: "",
      query: "跑一下",
      tools: [bashTool],
      requiresApproval: () => true,
    }),
    createCoreHandlers({ model, tools, approve: () => true }),
  );

  assert.deepEqual(executed, ["echo hi"]);
  assert.ok(messages.some((m) => m.content.includes("ran:echo hi")));
});

test("审批拒绝时工具不执行并返回拒绝结果", async () => {
  const { executed, model, tools } = setup();
  const messages = await runAgent(
    agentLoop({
      system: "",
      query: "跑一下",
      tools: [bashTool],
      requiresApproval: () => true,
    }),
    createCoreHandlers({ model, tools, approve: () => false }),
  );

  assert.deepEqual(executed, []);
  assert.ok(messages.some((m) => m.content.includes("[拒绝]")));
});

test("不需要审批时既不触发 approve 也直接执行", async () => {
  const { executed, model, tools } = setup();
  let approveCalls = 0;
  await runAgent(
    agentLoop({ system: "", query: "跑一下", tools: [bashTool] }),
    createCoreHandlers({
      model,
      tools,
      approve: () => {
        approveCalls += 1;
        return true;
      },
    }),
  );

  assert.equal(approveCalls, 0);
  assert.deepEqual(executed, ["echo hi"]);
});
