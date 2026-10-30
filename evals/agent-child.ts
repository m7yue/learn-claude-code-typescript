/**
 * 评测子进程：在指定的临时工作区里跑一次 agent，写出轨迹和结果。
 *
 * 独立进程的原因：
 *   - AGENT_WORKSPACE 在模块加载时求值，子进程启动前设置最可靠；
 *   - 父进程可以用 timeout 硬杀挂起的请求；
 *   - 每个 trial 的模型和工具状态完全隔离。
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { getModelConfig } from "../runtime/env.ts";
import { AnthropicModel } from "../src/core/anthropic-model.ts";
import { ScriptedModel, finalTurn, toolTurn } from "../src/core/scripted-model.ts";
import type { Model, ModelTurn } from "../src/core/types.ts";
import { createHarnessAgent, type HarnessObserver } from "../src/harness-agent.ts";
import { loadTask } from "./loader.ts";
import { renderValue, type RenderVars } from "./render.ts";
import { appendTrace } from "./trace.ts";
import type {
  AgentRunResult,
  RunMode,
  ScriptName,
  ScriptStep,
  TrajectoryEvent,
} from "./types.ts";

const { values } = parseArgs({
  options: {
    "task-id": { type: "string" },
    workspace: { type: "string" },
    outside: { type: "string" },
    "prompt-file": { type: "string" },
    mode: { type: "string", default: "fake" },
    script: { type: "string", default: "gold" },
    "result-file": { type: "string" },
    "trace-file": { type: "string" },
    "max-turns": { type: "string" },
  },
});

const taskId = requireArg(values["task-id"], "task-id");
const workspace = requireArg(values.workspace, "workspace");
const outside = requireArg(values.outside, "outside");
const promptFile = requireArg(values["prompt-file"], "prompt-file");
const resultFile = requireArg(values["result-file"], "result-file");
const traceFile = requireArg(values["trace-file"], "trace-file");
const mode: RunMode = values.mode === "real" ? "real" : "fake";
const script: ScriptName = values.script === "broken" ? "broken" : "gold";

const task = loadTask(taskId);
const prompt = readFileSync(promptFile, "utf8");
const vars: RenderVars = { WORKSPACE: workspace, OUTSIDE: outside };
const maxTurns = Number(values["max-turns"]) || task.maxTurns;

// 轨迹同时留在内存里给 result.json 用，并逐条追加到文件：
// 父进程超时杀掉本进程时，文件里至少留下已经发生的事件。
const trace: TrajectoryEvent[] = [];
const observer: HarnessObserver = {
  onModelTurn: (event) => {
    push({
      type: "model",
      turn: event.turn,
      stopReason: event.stopReason,
      usage: event.usage,
      durationMs: event.durationMs,
    });
  },
  onToolCall: (event) => {
    push({
      type: "tool",
      name: event.name,
      args: event.args,
      result: event.result,
      error: event.error,
      durationMs: event.durationMs,
    });
  },
  onApproval: (event) => {
    push({
      type: "approval",
      toolName: event.toolName,
      args: event.args,
      approved: event.approved,
      reason: event.reason,
    });
  },
};

// result.json 里保留一份子进程内部的 agent 耗时，排查时可对照 trace；
// 报告里的延迟由父进程按 wall-clock 测量，包含进程启动和 tsx 解析。
const startedAt = Date.now();
let result: AgentRunResult;

try {
  const model = buildModel();
  const agent = createHarnessAgent({
    cwd: workspace,
    model,
    maxTurns,
    observer,
    log: (message) => console.error(`[agent] ${message}`),
  });
  const run = await agent.run(prompt);
  result = {
    status: "ok",
    finalAnswer: run.finalAnswer,
    tokens: sumTokens(trace, mode),
    durationMs: Date.now() - startedAt,
    truncated: trace.some(
      (event) => event.type === "model" && event.stopReason === "max_tokens",
    ),
    trace,
  };
} catch (error) {
  // agent 失败也要写 result.json：父进程仍会跑检查，
  // 确认失败前有没有在磁盘上留下副作用。
  result = {
    status: "error",
    finalAnswer: "",
    tokens: sumTokens(trace, mode),
    durationMs: Date.now() - startedAt,
    truncated: trace.some(
      (event) => event.type === "model" && event.stopReason === "max_tokens",
    ),
    trace,
    error: error instanceof Error ? error.message : String(error),
  };
}

// 成功和失败都写结果文件；父进程靠它区分「agent 做错了」和「agent 跑挂了」。
// 先写临时文件再改名，父进程不会读到写了一半的 JSON。
const resultTemp = `${resultFile}.tmp`;
writeFileSync(resultTemp, `${JSON.stringify(result, null, 2)}\n`, "utf8");
renameSync(resultTemp, resultFile);

function buildModel(): Model {
  if (mode === "fake") {
    // 只把模型换成脚本；createHarnessAgent、工具和权限管线仍然是真实的，
    // 所以 gold/broken 自检验证的是同一条执行路径。
    return new ScriptedModel(toTurns(task.selfCheck[script], vars));
  }
  // 离线保险：即使调用方误传 --real，也不能发请求。
  if (process.env.EVAL_OFFLINE === "1") {
    throw new Error("EVAL_OFFLINE=1，拒绝在离线模式使用真实模型");
  }
  const config = getModelConfig();
  if (!config) {
    // 不静默回退到脚本模型，否则会把配置错误伪装成真实评测结果。
    throw new Error("real 模式缺少 ANTHROPIC_AUTH_TOKEN / MODEL_ID");
  }
  return new AnthropicModel(config);
}

/** 把 task.ts 里的脚本步骤翻译成模型回合，顺便替换路径占位符。 */
function toTurns(steps: ScriptStep[], variables: RenderVars): ModelTurn[] {
  return steps.map((step) => {
    if ("tool" in step) {
      return toolTurn(
        step.tool,
        renderValue(step.args, variables) as Record<string, unknown>,
      );
    }
    return finalTurn(step.final);
  });
}

/**
 * 汇总 token。mock 没有真实请求，记 0；real 拿不到 usage 时记 null，
 * 报告显示「—」，不把「不可用」伪装成 0。
 */
function sumTokens(
  events: TrajectoryEvent[],
  runMode: RunMode,
): { input: number; output: number } | null {
  const usages = events.filter(
    (event): event is Extract<TrajectoryEvent, { type: "model" }> =>
      event.type === "model" && event.usage !== undefined,
  );
  if (usages.length === 0) {
    return runMode === "fake" ? { input: 0, output: 0 } : null;
  }
  return {
    input: usages.reduce((sum, event) => sum + (event.usage?.input_tokens ?? 0), 0),
    output: usages.reduce((sum, event) => sum + (event.usage?.output_tokens ?? 0), 0),
  };
}

/** 内存留一份、文件追加一份：父进程超时杀进程时，已发生的事件不会丢。 */
function push(event: TrajectoryEvent): void {
  trace.push(event);
  appendTrace(traceFile, event);
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`缺少参数 --${name}`);
  }
  return value;
}
