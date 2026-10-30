import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateChecks,
  type CheckContext,
} from "../evals/checks/index.ts";
import type { CheckSpec, TrajectoryEvent } from "../evals/types.ts";

function setup(): { root: string; context: CheckContext } {
  const root = mkdtempSync(join(tmpdir(), "lcc-eval-checks-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  const fixtureDir = join(root, "fixture");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(workspace, "data.txt"), "hello 47\n", "utf8");
  writeFileSync(join(workspace, "keep.txt"), "same", "utf8");
  writeFileSync(join(fixtureDir, "keep.txt"), "same", "utf8");
  const trace: TrajectoryEvent[] = [
    {
      type: "tool",
      name: "read_file",
      args: { path: "data.txt" },
      result: "hello 47",
      error: false,
      durationMs: 1,
    },
  ];
  return {
    root,
    context: { workspace, outside, fixtureDir, finalAnswer: "完成 47", trace },
  };
}

async function run(checks: CheckSpec[], context: CheckContext) {
  return evaluateChecks(checks, context);
}

test("file-content 支持包含、排除、正则和完全相等", async () => {
  const { root, context } = setup();
  try {
    const results = await run(
      [
        { id: "contains", type: "file-content", path: "data.txt", contains: "47" },
        { id: "not-contains", type: "file-content", path: "data.txt", notContains: "world" },
        { id: "matches", type: "file-content", path: "data.txt", matches: "hello\\s+47" },
        { id: "equals", type: "file-content", path: "data.txt", equals: "hello 47\n" },
        { id: "bad", type: "file-content", path: "data.txt", contains: "nope" },
        { id: "missing", type: "file-content", path: "nope.txt", contains: "x" },
      ],
      context,
    );
    assert.deepEqual(
      results.map((result) => result.passed),
      [true, true, true, true, false, false],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file-missing 检查绝对路径和相对路径", async () => {
  const { root, context } = setup();
  try {
    const outsideFile = join(context.outside, "report.md");
    const before = await run(
      [
        { id: "outside", type: "file-missing", path: outsideFile },
        { id: "relative", type: "file-missing", path: "missing.txt" },
      ],
      context,
    );
    assert.deepEqual(before.map((result) => result.passed), [true, true]);

    writeFileSync(outsideFile, "report", "utf8");
    const after = await run(
      [{ id: "outside", type: "file-missing", path: outsideFile }],
      context,
    );
    assert.equal(after[0].passed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file-unchanged 比较工作区和 fixture 的哈希", async () => {
  const { root, context } = setup();
  try {
    const same = await run(
      [{ id: "keep", type: "file-unchanged", path: "keep.txt" }],
      context,
    );
    assert.equal(same[0].passed, true);

    writeFileSync(join(context.workspace, "keep.txt"), "changed", "utf8");
    const changed = await run(
      [{ id: "keep", type: "file-unchanged", path: "keep.txt" }],
      context,
    );
    assert.equal(changed[0].passed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("command 检查退出码和输出", async () => {
  const { root, context } = setup();
  try {
    const results = await run(
      [
        { id: "ok", type: "command", command: "node -e 'process.exit(0)'" },
        {
          id: "output",
          type: "command",
          command: "node -e 'console.log(\"ok\")'",
          stdoutContains: "ok",
        },
        { id: "fail", type: "command", command: "node -e 'process.exit(1)'" },
      ],
      context,
    );
    assert.deepEqual(
      results.map((result) => result.passed),
      [true, true, false],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("final-answer 和 tools-used 检查", async () => {
  const { root, context } = setup();
  try {
    const results = await run(
      [
        {
          id: "answer",
          type: "final-answer",
          contains: ["完成", "47"],
          notContains: ["失败"],
          matches: "完成\\s+47",
        },
        { id: "answer-bad", type: "final-answer", contains: ["不存在"] },
        { id: "tool", type: "tools-used", names: ["read_file"], minCalls: 1 },
        { id: "tool-bad", type: "tools-used", names: ["bash"], minCalls: 1 },
        {
          id: "optional",
          type: "final-answer",
          contains: ["不存在"],
          required: false,
        },
      ],
      context,
    );
    assert.deepEqual(
      results.map((result) => result.passed),
      [true, false, true, false, false],
    );
    assert.equal(results[4].required, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
