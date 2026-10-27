import test from "node:test";
import assert from "node:assert/strict";
import {
  isToolResultMessage,
  messageText,
  sanitizeToolPairs,
  toolErrorResult,
} from "../runtime/response.ts";
import type { Message } from "../runtime/types.ts";

const toolUse = (id: string) =>
  ({ type: "tool_use", id, name: "bash", input: { command: "ls" } }) as const;
const toolResult = (id: string, content = "out") =>
  ({ type: "tool_result", tool_use_id: id, content }) as const;

test("messageText 压平字符串与各类内容块", () => {
  assert.equal(messageText("plain"), "plain");
  assert.equal(
    messageText([{ type: "text", text: "a" }, toolResult("t1", "b"), toolUse("t2")]),
    'a' + 'b' + JSON.stringify({ command: "ls" }),
  );
});

test("isToolResultMessage 只认含 tool_result 的 user 消息", () => {
  assert.equal(isToolResultMessage({ role: "user", content: [toolResult("t1")] }), true);
  assert.equal(isToolResultMessage({ role: "user", content: "plain" }), false);
  assert.equal(isToolResultMessage({ role: "assistant", content: [toolUse("t1")] }), false);
});

test("sanitizeToolPairs 完整保留合法配对", () => {
  const messages: Message[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "ok" }, toolUse("t1")] },
    { role: "user", content: [toolResult("t1")] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];
  assert.deepEqual(sanitizeToolPairs(messages), messages);
});

test("sanitizeToolPairs 剔除悬空 tool_use（连同空掉的 assistant 消息）", () => {
  const messages: Message[] = [
    { role: "assistant", content: [toolUse("t2")] },
    { role: "user", content: "no tool_result here" },
  ];
  assert.deepEqual(sanitizeToolPairs(messages), [
    { role: "user", content: "no tool_result here" },
  ] satisfies Message[]);
});

test("sanitizeToolPairs 剔除悬空 tool_result", () => {
  const messages: Message[] = [
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
    { role: "user", content: [toolResult("tX")] },
  ];
  assert.deepEqual(sanitizeToolPairs(messages), [
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ] satisfies Message[]);
});

test("sanitizeToolPairs 对部分配对只保留已匹配的 tool_use", () => {
  const messages: Message[] = [
    { role: "assistant", content: [{ type: "text", text: "a" }, toolUse("t3"), toolUse("t4")] },
    { role: "user", content: [toolResult("t9")] },
  ];
  assert.deepEqual(sanitizeToolPairs(messages), [
    { role: "assistant", content: [{ type: "text", text: "a" }] },
  ] satisfies Message[]);
});

test("sanitizeToolPairs 原样保留 is_error 标记", () => {
  const messages: Message[] = [
    { role: "assistant", content: [toolUse("t1")] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }] },
  ];
  assert.deepEqual(sanitizeToolPairs(messages), messages);
});

test("toolErrorResult 生成带 is_error 的错误结果", () => {
  const fromError = toolErrorResult("t1", new Error("boom"));
  assert.equal(fromError.type, "tool_result");
  assert.equal(fromError.tool_use_id, "t1");
  assert.equal(fromError.content, "[错误] boom");
  assert.equal(fromError.is_error, true);

  const fromValue = toolErrorResult("t2", "plain failure");
  assert.equal(fromValue.content, "[错误] plain failure");
  assert.equal(fromValue.is_error, true);
});

