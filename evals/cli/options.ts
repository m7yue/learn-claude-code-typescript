/**
 * Evals 的参数类型、模式默认值和配置合并。
 *
 * CLI 的定义和解析在 program.ts；config.ts 只提供可选默认值。
 * 最终优先级：CLI > config > 模式默认值。
 */

import type { RunMode } from "../types.ts";

/** 一次评测的运行参数；mode 和 self-check 属于命令开关，不在这里。 */
export interface EvalOptions {
  /** 只跑这些任务；不填就是全部任务。 */
  tasks?: string[];
  /** 每个任务跑几次。 */
  trials: number;
  /** 默认裁判：关键词或大模型。 */
  judge: "keyword" | "llm";
  /** 对比的基线报告路径；不填就不做对比。 */
  baseline?: string;
  /** 是否保留 workspace/outside。 */
  keepWorkspace: boolean;
  /** 是否保留 prompt/result/trace。 */
  keepIo: boolean;
  /** 结果目录；不填就写到 evals/results/<runId>/。 */
  outDir?: string;
}

/** mock 和 real 的默认值不同：mock 只验证链路，real 需要重复几次看波动。 */
export const MODE_DEFAULTS: Record<RunMode, EvalOptions> = {
  fake: {
    trials: 1,
    judge: "keyword",
    keepWorkspace: false,
    keepIo: false,
  },
  real: {
    trials: 3,
    judge: "llm",
    keepWorkspace: false,
    keepIo: false,
  },
};

/**
 * 合并三个来源：CLI > config > 模式默认值。
 * 布尔值用 ??，保证显式 false 能覆盖 config 里的 true。
 */
export function resolveOptions(
  mode: RunMode,
  cli: Partial<EvalOptions>,
  config: Partial<EvalOptions>,
): EvalOptions {
  const defaults = MODE_DEFAULTS[mode];
  const trials = cli.trials ?? config.trials ?? defaults.trials;
  if (!Number.isInteger(trials) || trials <= 0) {
    throw new Error(`trials 必须是正整数，收到: ${trials}`);
  }

  return {
    tasks: cli.tasks ?? config.tasks,
    trials,
    judge: cli.judge ?? config.judge ?? defaults.judge,
    baseline: cli.baseline ?? config.baseline,
    keepWorkspace:
      cli.keepWorkspace ?? config.keepWorkspace ?? defaults.keepWorkspace,
    keepIo: cli.keepIo ?? config.keepIo ?? defaults.keepIo,
    outDir: cli.outDir ?? config.outDir,
  };
}
