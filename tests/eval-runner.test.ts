import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeywordJudge } from "../evals/judges/keyword.ts";
import { renderReport } from "../evals/report.ts";
import { runEvals } from "../evals/runner.ts";
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
  EvalTask,
  Judge,
} from "../evals/types.ts";

function makeFixture(): { root: string; fixtureDir: string } {
  const root = mkdtempSync(join(tmpdir(), "lcc-eval-runner-"));
  const fixtureDir = join(root, "fixture");
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, "seed.txt"), "seed", "utf8");
  return { root, fixtureDir };
}

function makeTask(fixtureDir: string): EvalTask {
  return {
    id: "demo",
    title: "演示任务",
    promptTemplate: "在 {{WORKSPACE}} 写 result.txt",
    fixtureDir,
    timeoutMs: 5000,
    maxTurns: 2,
    expectKeywords: ["完成"],
    referencePoints: ["写 result.txt"],
    checks: [
      { id: "result", type: "file-content", path: "result.txt", contains: "ok", required: true },
      { id: "answer", type: "final-answer", contains: ["完成"], required: true },
    ],
    selfCheck: {
      gold: [{ final: "完成" }],
      broken: [{ final: "失败" }],
    },
  };
}

/** 模拟一个会（或不会）写结果文件的 agent，用来单独验证 Runner 和裁判的配合。 */
class FakeAgentRunner implements AgentRunner {
  calls = 0;
  lastInput?: AgentRunInput;
  private readonly writeResult: boolean;

  constructor(writeResult: boolean) {
    this.writeResult = writeResult;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.calls += 1;
    this.lastInput = input;
    if (input.keepIo) input.onIoKept?.("fake-io-dir");
    if (this.writeResult) {
      writeFileSync(join(input.workspace, "result.txt"), "ok", "utf8");
    }
    return {
      status: "ok",
      finalAnswer: "完成 47",
      tokens: { input: 10, output: 5 },
      durationMs: 100,
      truncated: false,
      trace: [],
    };
  }
}

test("runEvals 汇总成功率、token 和延迟", async () => {
  const { root, fixtureDir } = makeFixture();
  try {
    const report = await runEvals([makeTask(fixtureDir)], new FakeAgentRunner(true), new KeywordJudge(), {
      trials: 2,
      mode: "fake",
      model: "mock",
      judge: "keyword",
      script: "gold",
    });

    assert.equal(report.summary.totalTrials, 2);
    assert.equal(report.summary.passedTrials, 2);
    assert.equal(report.summary.successRate, 1);
    assert.equal(report.summary.avgTokens?.total, 15);
    assert.equal(report.summary.avgDurationMs, 100);
    assert.equal(report.tasks[0].passed, 2);
    assert.equal(report.trials[0].checks.every((check) => check.passed), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("检查失败时 trial 记为未通过，并保留失败原因", async () => {
  const { root, fixtureDir } = makeFixture();
  try {
    const report = await runEvals([makeTask(fixtureDir)], new FakeAgentRunner(false), new KeywordJudge(), {
      trials: 1,
      mode: "fake",
      model: "mock",
      judge: "keyword",
      script: "gold",
    });

    assert.equal(report.summary.passedTrials, 0);
    assert.equal(report.tasks[0].failures.length > 0, true);
    assert.equal(report.trials[0].passed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("换裁判不改变 Runner 调用和任务结果", async () => {
  const { root, fixtureDir } = makeFixture();
  try {
    const task = makeTask(fixtureDir);
    const agent = new FakeAgentRunner(true);
    const options = {
      trials: 2,
      mode: "fake" as const,
      model: "mock",
      judge: "injection",
      script: "gold" as const,
    };
    const judgeA: Judge = {
      name: "judge-a",
      async evaluate() {
        return { score: 1, passed: true, reason: "A 的判断", source: "llm" };
      },
    };
    const judgeB: Judge = {
      name: "judge-b",
      async evaluate() {
        return { score: 5, passed: true, reason: "B 的判断", source: "llm" };
      },
    };

    const reportA = await runEvals([task], agent, judgeA, options);
    assert.equal(agent.calls, 2);
    const reportB = await runEvals([task], agent, judgeB, options);
    assert.equal(agent.calls, 4);

    assert.deepEqual(
      reportA.trials.map((trial) => trial.passed),
      reportB.trials.map((trial) => trial.passed),
    );
    assert.deepEqual(
      reportA.trials.map((trial) => trial.checks.map((check) => check.passed)),
      reportB.trials.map((trial) => trial.checks.map((check) => check.passed)),
    );
    assert.equal(reportA.trials[0].judge.reason, "A 的判断");
    assert.equal(reportB.trials[0].judge.reason, "B 的判断");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keepIo 和 onIoKept 会传给 AgentRunner", async () => {
  const { root, fixtureDir } = makeFixture();
  try {
    const agent = new FakeAgentRunner(true);
    const kept: string[] = [];
    await runEvals([makeTask(fixtureDir)], agent, new KeywordJudge(), {
      trials: 1,
      mode: "fake",
      model: "mock",
      judge: "keyword",
      script: "gold",
      keepIo: true,
      onIoKept: (path) => kept.push(path),
    });

    assert.equal(agent.lastInput?.keepIo, true);
    assert.deepEqual(kept, ["fake-io-dir"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report.md 包含总览、逐任务、裁判理由和基线对比", async () => {
  const { root, fixtureDir } = makeFixture();
  try {
    const report = await runEvals([makeTask(fixtureDir)], new FakeAgentRunner(true), new KeywordJudge(), {
      trials: 1,
      mode: "fake",
      model: "mock",
      judge: "keyword",
      script: "gold",
    });
    const markdown = renderReport(report, report);

    assert.match(markdown, /# Eval Report/);
    assert.match(markdown, /成功率/);
    assert.match(markdown, /demo/);
    assert.match(markdown, /与基线对比/);
    assert.match(markdown, /mock 演示/);
    assert.match(markdown, /最终回答包含全部关键词/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
