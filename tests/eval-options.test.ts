import test from "node:test";
import assert from "node:assert/strict";
import { resolveOptions } from "../evals/cli/options.ts";
import { buildProgram, resolveMode } from "../evals/cli/program.ts";

function parse(argv: string[]) {
  const program = buildProgram();
  // 测试里不要真的退出进程；非法参数改为抛 CommanderError。
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  program.parse(argv, { from: "user" });
  return program.opts();
}

test("Commander 解析任务、次数、裁判、路径和布尔开关", () => {
  const opts = parse([
    "--tasks",
    "read-file-answer, fix-single-file",
    "--trials",
    "2",
    "--judge",
    "keyword",
    "--baseline",
    "base.json",
    "--keep-workspace",
    "--keep-io",
    "--out",
    "tmp/out",
  ]);

  assert.deepEqual(opts.tasks, ["read-file-answer", "fix-single-file"]);
  assert.equal(opts.trials, 2);
  assert.equal(opts.judge, "keyword");
  assert.equal(opts.baseline, "base.json");
  assert.equal(opts.keepWorkspace, true);
  assert.equal(opts.keepIo, true);
  assert.equal(opts.out, "tmp/out");
});

test("Commander 解析命令开关，并拒绝非法值", () => {
  const opts = parse(["--real", "--self-check"]);
  assert.equal(opts.real, true);
  assert.equal(opts.selfCheck, true);

  assert.throws(() => parse(["--trials", "0"]), /必须是正整数/);
  assert.throws(() => parse(["--judge", "other"]), /只能是 keyword 或 llm/);
  assert.throws(() => resolveMode({ real: true, mock: true }), /不能同时使用/);
});

test("resolveOptions 按 CLI > config > 模式默认值合并", () => {
  const resolved = resolveOptions(
    "real",
    { trials: 2, keepIo: true },
    {
      trials: 5,
      judge: "keyword",
      tasks: ["from-config"],
      keepIo: false,
      keepWorkspace: true,
    },
  );

  assert.equal(resolved.trials, 2);
  assert.equal(resolved.judge, "keyword");
  assert.deepEqual(resolved.tasks, ["from-config"]);
  assert.equal(resolved.keepIo, true);
  assert.equal(resolved.keepWorkspace, true);
});

test("resolveOptions 在未配置时使用模式默认值", () => {
  assert.deepEqual(resolveOptions("fake", {}, {}), {
    tasks: undefined,
    trials: 1,
    judge: "keyword",
    baseline: undefined,
    keepWorkspace: false,
    keepIo: false,
    outDir: undefined,
  });

  assert.equal(resolveOptions("real", {}, {}).trials, 3);
  assert.equal(resolveOptions("real", {}, {}).judge, "llm");
});

test("resolveOptions 的显式 false 能覆盖 config 的 true", () => {
  const resolved = resolveOptions(
    "fake",
    { keepIo: false, keepWorkspace: false },
    { keepIo: true, keepWorkspace: true },
  );
  assert.equal(resolved.keepIo, false);
  assert.equal(resolved.keepWorkspace, false);
});

test("resolveOptions 拒绝非法 trials", () => {
  assert.throws(() => resolveOptions("fake", {}, { trials: 0 }), /trials/);
  assert.throws(() => resolveOptions("fake", {}, { trials: 1.5 }), /trials/);
});

test("Commander 自动 help 包含所有参数", () => {
  const help = buildProgram().helpInformation();
  for (const flag of [
    "--tasks",
    "--trials",
    "--judge",
    "--baseline",
    "--keep-workspace",
    "--keep-io",
    "--out",
    "--real",
    "--mock",
    "--self-check",
    "--help",
  ]) {
    assert.ok(help.includes(flag), `帮助里缺少 ${flag}`);
  }
});
