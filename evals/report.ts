/** 把 runEvals 的结果渲染成一份人读报告；纯函数，便于单测。 */

import type { EvalReport, TaskSummary } from "./types.ts";

/**
 * 纯函数：只根据 report 和 baseline 生成 Markdown，不读磁盘、不发请求，
 * 所以可以直接在测试里断言输出。
 */
export function renderReport(report: EvalReport, baseline?: EvalReport | null): string {
  const lines: string[] = [];
  const { summary } = report;

  lines.push(`# Eval Report: ${report.runId}`);
  lines.push("");
  lines.push(`- 模式: ${report.mode}`);
  lines.push(`- 模型: ${report.model}`);
  lines.push(`- 裁判: ${report.judge}${report.selfJudge ? "（与候选模型相同，结果可能偏高）" : ""}`);
  lines.push(`- 开始时间: ${report.startedAt}`);
  lines.push(`- 总耗时: ${formatMs(report.durationMs)}`);
  lines.push("");
  lines.push(
    `**一句话**: 成功率 ${summary.passedTrials}/${summary.totalTrials} (${pct(
      summary.successRate,
    )})，平均 ${formatTokens(summary.avgTokens)} token，平均 ${formatMs(
      summary.avgDurationMs,
    )}`,
  );
  if (summary.truncatedTrials > 0) {
    lines.push("");
    lines.push(`截断次数: ${summary.truncatedTrials}`);
  }
  if (report.mode === "fake") {
    lines.push("");
    lines.push("> mock 演示：这里验证的是评测链路，不是模型能力结论。");
  }

  lines.push("");
  lines.push("## 逐任务");
  lines.push("");
  lines.push("| 任务 | 通过 | 成功率 | 平均 token | 平均延迟 | 裁判 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const task of report.tasks) {
    lines.push(
      `| ${task.taskId} | ${task.passed}/${task.trials} | ${pct(task.successRate)} | ${formatTokens(
        task.avgTokens,
      )} | ${formatMs(task.avgDurationMs)} | ${formatJudges(task)} |`,
    );
  }

  const failedTrials = report.trials.filter((trial) => !trial.passed);
  if (failedTrials.length > 0) {
    lines.push("");
    lines.push("## 失败明细");
    for (const trial of failedTrials) {
      lines.push("");
      lines.push(`### ${trial.taskId} / trial ${trial.trial}`);
      for (const check of trial.checks.filter((item) => item.required && !item.passed)) {
        lines.push(`- ${check.id}: ${check.message}`);
      }
      if (trial.error) lines.push(`- agent 错误: ${trial.error}`);
      if (trial.finalAnswer) {
        lines.push(`- 最终回答摘录: ${excerpt(trial.finalAnswer)}`);
      }
    }
  }

  lines.push("");
  lines.push("## 裁判明细");
  for (const task of report.tasks) {
    for (const [index, verdict] of task.judges.entries()) {
      lines.push(
        `- ${task.taskId} #${index + 1}: ${verdict.source} ${verdict.score ?? "—"} 分，${
          verdict.passed === null ? "未判定" : verdict.passed ? "通过" : "未通过"
        }；${verdict.reason}`,
      );
    }
  }

  // 基线是上一次 run.json；这里只展示变化，不做自动通过/失败判定。
  if (baseline) {
    lines.push("");
    lines.push("## 与基线对比");
    lines.push("");
    lines.push(`基线: ${baseline.runId}`);
    lines.push("");
    lines.push("| 指标 | 基线 | 候选 | 变化 |");
    lines.push("| --- | --- | --- | --- |");
    lines.push(
      `| 成功率 | ${pct(baseline.summary.successRate)} | ${pct(
        report.summary.successRate,
      )} | ${signedPercent(report.summary.successRate - baseline.summary.successRate)} |`,
    );
    const baselineTokenTotal = baseline.summary.avgTokens?.total;
    const candidateTokenTotal = report.summary.avgTokens?.total;
    const tokenDelta =
      baselineTokenTotal === undefined || candidateTokenTotal === undefined
        ? "—"
        : signedNumber(candidateTokenTotal - baselineTokenTotal);
    lines.push(
      `| 平均 token | ${formatTokens(baseline.summary.avgTokens)} | ${formatTokens(
        report.summary.avgTokens,
      )} | ${tokenDelta} |`,
    );
    lines.push(
      `| 平均延迟 | ${formatMs(baseline.summary.avgDurationMs)} | ${formatMs(
        report.summary.avgDurationMs,
      )} | ${signedMs(report.summary.avgDurationMs - baseline.summary.avgDurationMs)} |`,
    );
    const sameModel = baseline.model === report.model;
    const sameJudge = baseline.judge === report.judge;
    const sameTasks =
      baseline.tasks.length === report.tasks.length &&
      baseline.tasks.every((task, index) => task.taskId === report.tasks[index]?.taskId);
    if (!sameModel || !sameJudge || !sameTasks) {
      lines.push("");
      lines.push("> 注意：基线与候选的模型、裁判或任务集不同，对比只能作参考。");
    }
    lines.push("");
    lines.push("> 样本小，变化可能只是波动；先看成功率，再看 token 和延迟。");
  }

  lines.push("");
  lines.push("## 限制");
  lines.push("- 任务集只有 3 个，覆盖基础工具、权限和回答，不代表通用编码能力。");
  lines.push("- 真实模型有随机性；3 次结果仍然少，只看趋势。");
  lines.push("- 没有操作系统沙箱，权限沿用 harness 默认管线。");
  lines.push(
    "- 权限只覆盖 write_file/edit_file；bash 重定向仍可能写到工作区外，deny-outside-write 失败时先查这个原因。",
  );
  lines.push("- 裁判分不参与通过；只做点对点评分，多裁判、顺序交换、人工抽检未实现。");
  lines.push("- 成本用 token 表示，不是货币成本。");
  lines.push("");

  return lines.join("\n");
}

function formatJudges(task: TaskSummary): string {
  if (task.judges.length === 0) return "—";
  return task.judges
    .map((verdict) => `${verdict.source}:${verdict.score ?? "—"}`)
    .join("<br>");
}

function pct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function signedPercent(value: number): string {
  const points = Math.round(value * 1000) / 10;
  return `${points >= 0 ? "+" : ""}${points}pp`;
}

function formatTokens(tokens: { total: number } | null): string {
  return tokens ? String(tokens.total) : "—";
}

function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

function signedNumber(value: number): string {
  return `${value >= 0 ? "+" : ""}${value}`;
}

function signedMs(ms: number): string {
  return `${ms >= 0 ? "+" : ""}${Math.round(ms)}ms`;
}

function excerpt(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}
