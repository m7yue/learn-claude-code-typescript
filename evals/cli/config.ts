/**
 * Evals 的可选默认配置。
 *
 * 这里只放固定参数的默认值；单次运行用 CLI 覆盖。
 * 优先级：CLI 参数 > 这里的值 > options.ts 里的模式默认值。
 *
 * 不要在这里放 token、endpoint、模型 ID，也不要放 mode：
 *   - 凭据和端点属于 .env；
 *   - mode 由 --real / --mock 显式选择，避免配置文件让 npm run eval 意外触网。
 */

import type { EvalOptions } from "./options.ts";

export const evalConfig: Partial<EvalOptions> = {
  // trials: 3,
  // judge: "keyword",
  // tasks: ["fix-single-file"],
  // baseline: "evals/results/<runId>/run.json",
  // keepWorkspace: false,
  // keepIo: false,
  // outDir: "evals/results/my-run",
};
