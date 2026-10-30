/**
 * 工程层可运行入口：把 src/modules 的 harness 组合成一个真正能跑的 agent。
 *
 *   npm run harness         # mock 模式（零配置）
 *   npm run harness:real    # 真实模型（需 .env 配置 DeepSeek）
 *
 * 与各章不同，这里执行真实的工具（bash / 读写文件 / glob），
 * 并接入权限管线与真实模型。组装逻辑在 src/harness-agent.ts，evals 共用。
 */

import { describeMode, resolveMode } from "../runtime/env.ts";
import { WORKSPACE_ROOT } from "../runtime/workspace.ts";
import { createModel } from "./core/anthropic-model.ts";
import { ScriptedModel, finalTurn, toolTurn } from "./core/scripted-model.ts";
import { createHarnessAgent } from "./harness-agent.ts";

// 工作区根目录（可用 AGENT_WORKSPACE 覆盖）。
const cwd = WORKSPACE_ROOT;

const fakeScriptedTurns = [
  toolTurn("bash", { command: "echo harness-ready && ls" }, "先看看当前目录。"),
  finalTurn("harness 演示完成。配置 .env 后用 --real 运行真实模型。"),
];

const query = process.argv
  .filter((arg) => !arg.startsWith("-"))
  .slice(2)
  .join(" ")
  .trim() || "列出当前目录的文件，并说明你是什么。";

const model = resolveMode() === "real" ? createModel() : new ScriptedModel(fakeScriptedTurns);
const agent = createHarnessAgent({
  cwd,
  model,
  log: (message) => console.log(`[harness] ${message}`),
  observer: {
    // CLI 只打印需要人注意的结论：拒绝和需确认；放行不打印。
    onApproval: (event) => {
      if (event.decision === "deny") {
        console.log(`[Permission] 拒绝 ${event.toolName}: ${event.reason}`);
      } else if (event.decision === "ask") {
        console.log(
          `[Permission] 需人工确认 ${event.toolName}（默认拒绝）: ${event.reason} - ${event.requestReason}`,
        );
      }
    },
  },
});

console.log(`[harness] 模式: ${describeMode()}`);
console.log(`[harness] 工作区: ${cwd}`);
console.log(`[harness] 用户: ${query}\n`);

const { finalAnswer } = await agent.run(query);
console.log(`\n[harness] 完成:\n${finalAnswer || "(无输出)"}`);
