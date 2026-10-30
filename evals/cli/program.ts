/**
 * Commander 参数定义。
 *
 * 这里负责「CLI 上叫什么、怎么解析、--help 怎么写」；
 * EvalOptions、模式默认值和配置合并仍在 options.ts。
 */

import { Command, InvalidArgumentError } from "@commander-js/extra-typings";
import type { RunMode } from "../types.ts";

function parseTasks(value: string): string[] | undefined {
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}

function parseTrials(value: string): number {
  const trials = Number(value);
  if (!Number.isInteger(trials) || trials <= 0) {
    throw new InvalidArgumentError("必须是正整数");
  }
  return trials;
}

function parseJudge(value: string): "keyword" | "llm" {
  if (value !== "keyword" && value !== "llm") {
    throw new InvalidArgumentError("只能是 keyword 或 llm");
  }
  return value;
}

/**
 * 构建 Commander 命令。
 *
 * 不显式标注返回类型，让 extra-typings 保留每个 option 的类型，
 * program.opts() 才能推断出 tasks、trials、judge 等字段。
 */
export function buildProgram() {
  return new Command()
    .name("eval")
    .description("运行工程层 harness 的固定任务评测")
    .option("--tasks <ids>", "只跑指定任务，逗号分隔", parseTasks)
    .option(
      "--trials <n>",
      "每个任务跑几次（mock 默认 1，real 默认 3）",
      parseTrials,
    )
    .option("--judge <name>", "裁判：keyword 或 llm", parseJudge)
    .option("--baseline <path>", "基线 run.json 路径，用于在报告里做对比")
    .option("--keep-workspace", "保留 workspace/outside 并打印路径")
    .option("--keep-io", "保留 prompt/result/trace 并打印路径")
    .option("--out <dir>", "结果目录；默认写到 evals/results/<runId>/")
    .option("--real", "使用真实模型")
    .option("--mock", "显式使用脚本模型")
    .option("--self-check", "运行 gold/broken 自检，不进入普通评测")
    .helpOption("-h, --help", "显示帮助")
    .showHelpAfterError();
}

/** 从 --real / --mock 推出评测模式；两者同时出现直接报错。 */
export function resolveMode(opts: { real?: boolean; mock?: boolean }): RunMode {
  if (opts.real && opts.mock) {
    throw new Error("--real 和 --mock 不能同时使用");
  }
  return opts.real ? "real" : "fake";
}
