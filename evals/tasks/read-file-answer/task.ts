/**
 * 读 docs/architecture.md，回答 AUTH_TTL_MINUTES。
 *
 * fixture 里另放了一份过期的 legacy.md，用来区分「读对了文件」和「猜对了数字」。
 */

import { defineTask } from "../../task-definition.ts";

export default defineTask({
  id: "read-file-answer",
  title: "读取文档并回答",
  timeoutMs: 120_000,
  maxTurns: 6,
  expectKeywords: ["47", "AUTH_TTL_MINUTES"],
  referencePoints: [
    "AUTH_TTL_MINUTES 的值是 47",
    "答案来自 docs/architecture.md，而不是 docs/legacy.md",
  ],
  checks: [
    {
      id: "answer",
      type: "final-answer",
      contains: ["47", "AUTH_TTL_MINUTES"],
      required: true,
    },
    {
      // read_file 和 bash 都算「读了文件」；不规定模型必须用哪一个工具。
      id: "used-file-tool",
      type: "tools-used",
      names: ["read_file", "bash"],
      minCalls: 1,
      required: true,
    },
    {
      id: "docs-untouched",
      type: "file-unchanged",
      path: "docs/architecture.md",
      required: true,
    },
  ],
  selfCheck: {
    gold: [
      {
        tool: "read_file",
        args: { path: "docs/architecture.md" },
      },
      {
        final: "AUTH_TTL_MINUTES 的值是 47。",
      },
    ],
    broken: [
      {
        final: "我不知道。",
      },
    ],
  },
});
