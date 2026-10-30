/**
 * Evals CLI：装配 AgentRunner + Judge，跑任务并写报告。
 *
 *   npm run eval           # mock + 脚本化 agent + KeywordJudge
 *   npm run eval:check     # gold 必须过、broken 必须失败
 *   npm run eval:real      # 真实模型（需要 .env）
 *   npm run eval -- --help # 查看所有参数和默认值
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getModelConfig } from "../../runtime/env.ts";
import { HarnessAgentRunner } from "../agent-runner.ts";
import { KeywordJudge } from "../judges/keyword.ts";
import { createLLMJudge } from "../judges/llm.ts";
import { loadTasks } from "../loader.ts";
import { renderReport } from "../report.ts";
import { runEvals } from "../runner.ts";
import type { EvalReport, EvalTask, Judge, RunMode } from "../types.ts";
import { evalConfig } from "./config.ts";
import { resolveOptions, type EvalOptions } from "./options.ts";
import { buildProgram, resolveMode } from "./program.ts";

const EVALS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const program = buildProgram();
program.parse(process.argv);
const opts = program.opts();

// 评测模式只由 CLI 决定：默认 mock，只有显式 --real 才发请求。
// 刻意不读 .env 里的 AGENT_MODE，避免本地配置让 npm run eval 意外触网。
let mode: RunMode;
try {
  mode = resolveMode(opts);
} catch (error) {
  console.error(`[eval] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const cliOptions: Partial<EvalOptions> = {
  tasks: opts.tasks,
  trials: opts.trials,
  judge: opts.judge,
  baseline: opts.baseline,
  keepWorkspace: opts.keepWorkspace,
  keepIo: opts.keepIo,
  outDir: opts.out,
};

let options: EvalOptions;
try {
  options = resolveOptions(mode, cliOptions, evalConfig);
} catch (error) {
  console.error(`[eval] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

let tasks: EvalTask[];
try {
  tasks = loadTasks(options.tasks);
} catch (error) {
  console.error(`[eval] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (opts.selfCheck) {
  await selfCheck(tasks);
} else {
  await run(mode, options);
}

async function run(runMode: RunMode, runOptions: EvalOptions): Promise<void> {
  const config = getModelConfig();
  if (runMode === "real" && !config) {
    console.error(
      "[eval] real 模式需要 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY 与 MODEL_ID；请先配置 .env。",
    );
    process.exitCode = 1;
    return;
  }

  let judge: Judge;
  let selfJudge = false;
  if (runOptions.judge === "llm") {
    if (runMode === "fake" || !config) {
      // mock 模式不该触网；缺配置时也不静默发请求。
      console.warn("[eval] mock 模式或缺少真实模型配置，本次使用 KeywordJudge。");
      judge = new KeywordJudge();
    } else {
      const judgeModel = (process.env.JUDGE_MODEL_ID || "").trim() || config.model;
      // 同模型裁判容易偏爱自己的输出，只告警、不阻止，结果里保留标记。
      selfJudge = judgeModel === config.model;
      if (selfJudge) {
        console.warn("[eval] 裁判模型与候选模型相同（selfJudge），分数可能偏高。");
      }
      judge = createLLMJudge(config, {
        judgeModel,
        maxTokens: Number(process.env.JUDGE_MAX_TOKENS) || 512,
      });
    }
  } else {
    judge = new KeywordJudge();
  }
  const modelLabel = runMode === "fake" ? "mock" : config?.model ?? "unknown";

  console.log(
    `[eval] 模式: ${runMode} | 裁判: ${judge.name} | 任务: ${tasks.length} | trials: ${runOptions.trials}`,
  );

  const report = await runEvals(tasks, new HarnessAgentRunner(), judge, {
    trials: runOptions.trials,
    mode: runMode,
    // mock 走 gold 脚本；real 直接用真实模型，script 不生效。
    script: runMode === "fake" ? "gold" : undefined,
    keepWorkspace: runOptions.keepWorkspace,
    onWorkspaceKept: (path) => console.log(`[eval] 保留工作区: ${path}`),
    keepIo: runOptions.keepIo,
    onIoKept: (path) => console.log(`[eval] 保留 IO 目录: ${path}`),
    model: modelLabel,
    judge: judge.name,
    selfJudge,
  });

  // 基线只生成对比段落；不做自动门禁，接受与否由人判断。
  let baseline: EvalReport | null = null;
  if (runOptions.baseline) {
    try {
      baseline = loadReport(runOptions.baseline);
    } catch (error) {
      console.error(`[eval] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }
  }
  const outDir = runOptions.outDir ?? join(EVALS_ROOT, "results", report.runId);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "run.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(join(outDir, "report.md"), renderReport(report, baseline), "utf8");

  console.log(
    `[eval] 成功率: ${report.summary.passedTrials}/${report.summary.totalTrials}，平均 token: ${
      report.summary.avgTokens?.total ?? "—"
    }，平均延迟: ${report.summary.avgDurationMs}ms`,
  );
  console.log(`[eval] 报告: ${join(outDir, "report.md")}`);
}

/**
 * 用同一套 Runner 和检查器跑 gold / broken：
 * gold 必须通过，broken 必须至少失败一项。验证的是评测器本身，不是模型能力。
 */
async function selfCheck(checkTasks: EvalTask[]): Promise<void> {
  const judge = new KeywordJudge();
  const agent = new HarnessAgentRunner();
  let failures = 0;

  for (const task of checkTasks) {
    const gold = await runEvals([task], agent, judge, {
      trials: 1,
      mode: "fake",
      script: "gold",
      model: "mock",
      judge: "keyword",
    });
    const broken = await runEvals([task], agent, judge, {
      trials: 1,
      mode: "fake",
      script: "broken",
      model: "mock",
      judge: "keyword",
    });

    const goldOk = gold.summary.passedTrials === 1;
    const brokenOk = broken.summary.passedTrials === 0;
    if (!goldOk) failures += 1;
    if (!brokenOk) failures += 1;

    console.log(`${goldOk ? "✓" : "✗"} ${task.id} gold: ${gold.summary.passedTrials}/1 通过`);
    console.log(
      `${brokenOk ? "✓" : "✗"} ${task.id} broken: ${broken.summary.passedTrials}/1 通过（预期 0）`,
    );

    if (!goldOk) {
      for (const trial of gold.trials) {
        for (const check of trial.checks.filter((item) => !item.passed)) {
          console.log(`    gold 失败: ${check.id}: ${check.message}`);
        }
        if (trial.error) console.log(`    gold 错误: ${trial.error}`);
      }
    }
    if (!brokenOk) {
      for (const trial of broken.trials) {
        for (const check of trial.checks.filter((item) => item.passed)) {
          console.log(`    broken 仍通过: ${check.id}`);
        }
      }
    }
  }

  if (failures > 0) {
    console.error(`[eval:check] 有 ${failures} 项不符合预期`);
    process.exitCode = 1;
    return;
  }
  console.log(`[eval:check] 全部 ${checkTasks.length} 个任务的 gold/broken 符合预期`);
}

/** 读基线报告；只做最低限度的版本校验，字段结构由同一套代码生成。 */
function loadReport(path: string): EvalReport {
  const raw = JSON.parse(readFileSync(path, "utf8")) as EvalReport;
  if (raw.schemaVersion !== 1) {
    throw new Error(`基线报告 schemaVersion 不是 1: ${path}`);
  }
  return raw;
}
