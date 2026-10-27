import test from "node:test";
import assert from "node:assert/strict";

import { commandOutput, replaceFirstLiteral } from "../s20_comprehensive/util.ts";

test("replaceFirstLiteral 按字面写入 $& / $' / $`", () => {
  const content = "before token after";
  for (const replacement of ["new-$&-value", "new-$'-value", "new-$`-value"]) {
    assert.equal(
      replaceFirstLiteral(content, "token", replacement),
      `before ${replacement} after`,
      `replacement ${replacement} 不应被 String.replace 当成替换模式`,
    );
  }
});

test("commandOutput 成功时返回输出，空输出有占位", () => {
  assert.equal(commandOutput(0, null, "ok", ""), "ok");
  assert.equal(commandOutput(0, null, "out", "err"), "outerr");
  assert.equal(commandOutput(0, null, "", ""), "(no output)");
});

test("commandOutput 非零退出码抛出带输出的错误", () => {
  assert.throws(
    () => commandOutput(1, null, "stdout", "stderr"),
    (error: unknown) =>
      error instanceof Error &&
      /exit 1/.test(error.message) &&
      error.message.includes("stdout") &&
      error.message.includes("stderr"),
  );
});

test("commandOutput 被信号终止时报告信号", () => {
  assert.throws(
    () => commandOutput(null, "SIGTERM", "", ""),
    (error: unknown) => error instanceof Error && /SIGTERM/.test(error.message),
  );
});
