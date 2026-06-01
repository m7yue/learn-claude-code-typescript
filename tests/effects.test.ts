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
