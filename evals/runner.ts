/**
 * 评测调度：任务 × trials，负责临时工作区、评分、裁判和汇总。
 *
 * 这个文件只依赖 types.ts 里的 Judge / AgentRunner 接口，
 * 不 import 具体的裁判或子进程实现；装配在 cli/index.ts。
 */

import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateChecks } from "./checks/index.ts";
import { renderTemplate } from "./render.ts";
import type {
  AgentRunner,
  AgentRunResult,
  EvalReport,
  EvalTask,
  Judge,
  JudgeResult,
  RunOptions,
  TaskSummary,
  TokenSummary,
  TrialResult,
} from "./types.ts";

export async function runEvals(
  tasks: EvalTask[],
  agent: AgentRunner,
  judge: Judge,
  options: RunOptions,
): Promise<EvalReport> {
  const startedAt = new Date();
  const startedMs = Date.now();
  const trials: TrialResult[] = [];

  for (const task of tasks) {
    for (let index = 1; index <= options.trials; index += 1) {
      const base = await mkdtemp(join(tmpdir(), `lcc-eval-${task.id}-`));
      // workspace 是 agent 的现场；outside 是越界写入的目标。
      // 两者分开，检查器才能确定文件到底写到了哪边。
      const workspace = join(base, "workspace");
      const outside = join(base, "outside");

      try {
        await cp(task.fixtureDir, workspace, { recursive: true });
        await mkdir(outside, { recursive: true });
        const prompt = renderTemplate(task.promptTemplate, {
          WORKSPACE: workspace,
          OUTSIDE: outside,
        });

        let run: AgentRunResult;
        try {
          run = await agent.run({
            task,
            workspace,
            outside,
            prompt,
            mode: options.mode,
            script: options.script,
            timeoutMs: task.timeoutMs,
            maxTurns: task.maxTurns,
            keepIo: options.keepIo,
            onIoKept: options.onIoKept,
          });
        } catch (error) {
          // AgentRunner 自己抛错时也要继续评分：失败前可能已经写了文件。
          run = errorRun(error, options.mode);
        }

        // 检查总是执行，不因 agent 报错而跳过；否则「跑挂了但留下副作用」会被漏报。
        const checks = await evaluateChecks(task.checks, {
          workspace,
          outside,
          fixtureDir: task.fixtureDir,
          finalAnswer: run.finalAnswer,
          trace: run.trace,
        });
        const verdict = await safeJudge(judge, task, run);
        // 通过只看 required 检查；裁判分只展示，不参与通过/失败。
        const passed = checks.filter((check) => check.required).every((check) => check.passed);

        trials.push({
          taskId: task.id,
          trial: index,
          status: run.status,
          passed,
          checks,
          judge: verdict,
          finalAnswer: run.finalAnswer,
          tokens: run.tokens,
          durationMs: run.durationMs,
          truncated: run.truncated,
          error: run.error,
        });
      } finally {
        // 默认清理；--keep-workspace 时保留现场，方便人工核对失败原因。
        if (options.keepWorkspace) {
          options.onWorkspaceKept?.(base);
        } else {
          await rm(base, { recursive: true, force: true });
        }
      }
    }
  }

  const taskSummaries = summarizeTasks(tasks, trials);
  const passedTrials = trials.filter((trial) => trial.passed).length;

  return {
    schemaVersion: 1,
    runId: createRunId(options.mode, options.judge),
    mode: options.mode,
    model: options.model,
    judge: options.judge,
    selfJudge: options.selfJudge ?? false,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    trials,
    tasks: taskSummaries,
    summary: {
      totalTrials: trials.length,
      passedTrials,
      successRate: trials.length === 0 ? 0 : passedTrials / trials.length,
      avgTokens: averageTokens(trials),
      avgDurationMs: averageDuration(trials),
      truncatedTrials: trials.filter((trial) => trial.truncated).length,
    },
  };
}

/** AgentRunner 自己抛错时合成一个失败结果，让检查器仍能执行。 */
function errorRun(error: unknown, mode: "fake" | "real"): AgentRunResult {
  return {
    status: "error",
    finalAnswer: "",
    tokens: mode === "fake" ? { input: 0, output: 0 } : null,
    durationMs: 0,
    truncated: false,
    trace: [],
    error: error instanceof Error ? error.message : String(error),
  };
}

/** 裁判失败不影响 trial 通过；只记录失败原因，避免评测被裁判拖垮。 */
async function safeJudge(
  judge: Judge,
  task: EvalTask,
  run: AgentRunResult,
): Promise<JudgeResult> {
  try {
    return await judge.evaluate({
      task,
      finalAnswer: run.finalAnswer,
      trace: run.trace,
    });
  } catch (error) {
    return {
      score: null,
      passed: null,
      reason: `裁判失败: ${error instanceof Error ? error.message : String(error)}`,
      source: "fallback",
    };
  }
}

function summarizeTasks(tasks: EvalTask[], trials: TrialResult[]): TaskSummary[] {
  return tasks.map((task) => {
    const taskTrials = trials.filter((trial) => trial.taskId === task.id);
    const passed = taskTrials.filter((trial) => trial.passed).length;
    return {
      taskId: task.id,
      title: task.title,
      trials: taskTrials.length,
      passed,
      successRate: taskTrials.length === 0 ? 0 : passed / taskTrials.length,
      avgTokens: averageTokens(taskTrials),
      avgDurationMs: averageDuration(taskTrials),
      judges: taskTrials.map((trial) => trial.judge),
      failures: taskTrials.flatMap((trial) =>
        trial.checks
          .filter((check) => check.required && !check.passed)
          .map((check) => `${check.id}: ${check.message}`),
      ),
    };
  });
}

function knownTokens(trials: TrialResult[]): Array<{ input: number; output: number }> {
  return trials
    .map((trial) => trial.tokens)
    .filter((tokens): tokens is { input: number; output: number } => tokens !== null);
}

/** 只对有 token 数据的 trial 求平均；全部缺失时返回 null，不按 0 计算。 */
function averageTokens(trials: TrialResult[]): TokenSummary | null {
  const known = knownTokens(trials);
  if (known.length === 0) return null;
  const input = known.reduce((sum, tokens) => sum + tokens.input, 0) / known.length;
  const output = known.reduce((sum, tokens) => sum + tokens.output, 0) / known.length;
  return {
    input: Math.round(input),
    output: Math.round(output),
    total: Math.round(input + output),
  };
}

function averageDuration(trials: TrialResult[]): number {
  if (trials.length === 0) return 0;
  return Math.round(
    trials.reduce((sum, trial) => sum + trial.durationMs, 0) / trials.length,
  );
}

function createRunId(mode: string, judge: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const random = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${mode}-${judge}-${random}`;
}
