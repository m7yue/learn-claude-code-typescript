/**
 * 工程层可运行入口：把 src/modules 的 harness 组合成一个真正能跑的 agent。
 *
 *   npm run harness         # mock 模式（零配置）
 *   npm run harness:real    # 真实模型（需 .env 配置 DeepSeek）
 *
 * 与各章不同，这里执行真实的工具（bash / 读写文件 / glob），
 * 并接入权限管线与真实模型。
 */

import { describeMode, resolveMode } from "../runtime/env.ts";
import { WORKSPACE_ROOT } from "../runtime/workspace.ts";
import { agentLoop, createCoreHandlers, runAgent } from "./core/agent.ts";
import { createModel } from "./core/anthropic-model.ts";
import { ScriptedModel, finalTurn, toolTurn } from "./core/scripted-model.ts";
import type { Message } from "./core/types.ts";
import { createTeachingHarness } from "./modules/comprehensive.ts";
import { buildHarnessTools } from "./modules/harness-tools.ts";

// 工作区根目录（可用 AGENT_WORKSPACE 覆盖）。
const cwd = WORKSPACE_ROOT;
const harness = createTeachingHarness(cwd);

// 工具定义与执行器一起从 runtime 注册表派生（base + 任务 + 团队 + 待办）。
const { definitions: tools, handlers } = buildHarnessTools({
  cwd,
  tasks: harness.tasks,
  team: harness.team,
  todos: harness.todos,
});

// 权限管线 → ApprovalEffect 的批准函数
function approve(reason: string, payload: unknown): boolean {
  const { name, args } = payload as { name: string; args: Record<string, unknown> };
  const result = harness.permission.check(name, args);
  if (result.decision === "deny") {
    console.log(`[Permission] 拒绝 ${name}: ${result.reason}`);
    return false;
  }
  if (result.decision === "ask") {
    // 非交互式 harness 默认保守拒绝；如需放行可调用 harness.permission 自定义规则。
    console.log(`[Permission] 需人工确认 ${name}（默认拒绝）: ${result.reason} - ${reason}`);
    return false;
  }
  return true;
}

const fakeScriptedTurns = [
  toolTurn("bash", { command: "echo harness-ready && ls" }, "先看看当前目录。"),
  finalTurn("harness 演示完成。配置 .env 后用 --real 运行真实模型。"),
];

const query = process.argv.filter((arg) => !arg.startsWith("-")).slice(2).join(" ").trim()
  || "列出当前目录的文件，并说明你是什么。";

const system = harness.prompt.assemble({ cwd, hasOpenTodos: false, hasTeam: false });
const model = resolveMode() === "real" ? createModel() : new ScriptedModel(fakeScriptedTurns);

console.log(`[harness] 模式: ${describeMode()}`);
console.log(`[harness] 工作区: ${cwd}`);
console.log(`[harness] 用户: ${query}\n`);

const messages: Message[] = await runAgent(
  agentLoop({
    system,
    query,
    tools,
    requiresApproval: (name, args) => harness.permission.check(name, args).decision !== "allow",
  }),
  createCoreHandlers({ model, tools: handlers, approve, log: (message) => console.log(`[harness] ${message}`) }),
);

const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
console.log(`\n[harness] 完成:\n${lastAssistant?.content ?? "(无输出)"}`);
