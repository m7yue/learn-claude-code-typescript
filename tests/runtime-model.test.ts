import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBaseUrl } from "../runtime/model.ts";
import { resolveMode } from "../runtime/env.ts";
import type { Message } from "../runtime/types.ts";

test("normalizeBaseUrl 兼容 Anthropic / DeepSeek / 已含 /v1 的 base", () => {
  assert.equal(normalizeBaseUrl("https://api.anthropic.com"), "https://api.anthropic.com");
  assert.equal(normalizeBaseUrl("https://api.deepseek.com/anthropic"), "https://api.deepseek.com/anthropic");
  assert.equal(normalizeBaseUrl("https://api.deepseek.com/anthropic/"), "https://api.deepseek.com/anthropic");
  assert.equal(normalizeBaseUrl("https://host/v1"), "https://host");
});

test("resolveMode 命令行优先于环境变量，默认 mock", () => {
  const original = process.env.AGENT_MODE;
  try {
    delete process.env.AGENT_MODE;
    assert.equal(resolveMode(["--mock"]), "mock");
    assert.equal(resolveMode(["--real"]), "real");
    process.env.AGENT_MODE = "real";
    assert.equal(resolveMode([]), "real");
    assert.equal(resolveMode(["--mock"]), "mock");
  } finally {
    if (original === undefined) delete process.env.AGENT_MODE;
    else process.env.AGENT_MODE = original;
  }
});

test("callChat 在 mock 模式使用各章 mockFn", async () => {
  const { callChat } = await import("../runtime/model.ts");
  const original = process.env.AGENT_MODE;
  process.env.AGENT_MODE = "mock";
  try {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const response = await callChat(
      () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "mocked" }] }),
      messages,
      { label: "test" },
    );
    assert.equal(response.stop_reason, "end_turn");
    assert.equal(response.content[0].type === "text" ? response.content[0].text : "", "mocked");
  } finally {
    if (original === undefined) delete process.env.AGENT_MODE;
    else process.env.AGENT_MODE = original;
  }
});
