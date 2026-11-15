import test from "node:test";
import assert from "node:assert/strict";
import { runEffects, type Effect, type Perform } from "../src/core/effects.ts";
import { TodoList } from "../src/modules/todos.ts";
import { microCompact, estimateTokens } from "../src/modules/compact.ts";

interface AskEffect extends Effect<"Ask", { prompt: string }, string> {}
interface SayEffect extends Effect<"Say", { message: string }, void> {}
type TestEffect = AskEffect | SayEffect;

test("Algebraic Effects 能把 handler 结果送回 Agent", async () => {
  const said: string[] = [];
  const result = await runEffects<TestEffect, string>(
    function* program(perform: Perform<TestEffect>) {
      const answer = yield* perform({ type: "Ask", input: { prompt: "目标是什么？" } });
      yield* perform({ type: "Say", input: { message: answer } });
      return `done:${answer}`;
    },
    {
      Ask: () => "学习 Agent",
      Say: (effect) => {
        said.push(effect.input.message);
      },
    },
  );

  assert.equal(result, "done:学习 Agent");
  assert.deepEqual(said, ["学习 Agent"]);
});

test("handler 抛错后 Generator 在 catch 内 yield 的新效应会被执行", async () => {
  const calls: string[] = [];
  const result = await runEffects<TestEffect, string>(
    function* program(perform: Perform<TestEffect>) {
      try {
        yield* perform({ type: "Ask", input: { prompt: "first" } });
        return "unreachable";
      } catch {
        return yield* perform({ type: "Ask", input: { prompt: "retry" } });
      }
    },
    {
      Ask: (effect) => {
        calls.push(effect.input.prompt);
        if (effect.input.prompt === "first") throw new Error("network down");
        return `answered:${effect.input.prompt}`;
      },
      Say: () => {},
    },
  );

  assert.equal(result, "answered:retry");
  assert.deepEqual(calls, ["first", "retry"]);
});

test("TodoList 只允许一个 in_progress", () => {
  const todos = new TodoList();
  assert.throws(() => {
    todos.update([
      { content: "a", status: "in_progress", activeForm: "doing a" },
      { content: "b", status: "in_progress", activeForm: "doing b" },
    ]);
  }, /同时只能有一个/);
});

test("microCompact 会压缩较早的工具结果", () => {
  const messages = microCompact([
    { role: "tool", content: "a".repeat(300) },
    { role: "tool", content: "b".repeat(300) },
    { role: "tool", content: "c".repeat(300) },
    { role: "tool", content: "d".repeat(300) },
  ], 1);

  assert.match(messages[0].content, /已微压缩/);
  assert.equal(messages[3].content.length, 300);
  assert.ok(estimateTokens(messages) > 0);
});
