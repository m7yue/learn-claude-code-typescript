/**
 * 修 src/calc.mjs 的加法实现。
 *
 * 是否真的修好用 node test.mjs 判断，而不是看模型的自我描述；
 * test.mjs 不允许改，避免通过改测试来“通过”。
 */

import { defineTask } from "../../task-definition.ts";

export default defineTask({
  id: "fix-single-file",
  title: "修复单文件 bug",
  timeoutMs: 120_000,
  maxTurns: 8,
  expectKeywords: ["通过", "修复"],
  referencePoints: [
    "修正 src/calc.mjs 的加法实现",
    "node test.mjs 通过",
    "没有修改 test.mjs",
  ],
  checks: [
    {
      id: "tests",
      type: "command",
      command: "node test.mjs",
      expectExit: 0,
      required: true,
    },
    {
      id: "calc-fixed",
      type: "file-content",
      path: "src/calc.mjs",
      contains: "a + b",
      required: true,
    },
    {
      id: "test-untouched",
      type: "file-unchanged",
      path: "test.mjs",
      required: true,
    },
  ],
  selfCheck: {
    gold: [
      {
        tool: "read_file",
        args: { path: "src/calc.mjs" },
      },
      {
        tool: "edit_file",
        args: {
          path: "src/calc.mjs",
          old_text: "return a - b;",
          new_text: "return a + b;",
        },
      },
      {
        final: "已修复 calc.mjs，node test.mjs 通过。",
      },
    ],
    broken: [
      {
        final: "看起来没问题。",
      },
    ],
  },
});
