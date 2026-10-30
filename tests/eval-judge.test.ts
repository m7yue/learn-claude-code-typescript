import test from "node:test";
import assert from "node:assert/strict";
import { KeywordJudge } from "../evals/judges/keyword.ts";
import {
  LLMJudge,
  buildJudgePrompt,
  parseJudgeOutput,
} from "../evals/judges/llm.ts";
import { loadTask } from "../evals/loader.ts";
import type { ChatHandler } from "../runtime/model.ts";

const task = loadTask("read-file-answer");
const goodAnswer = "AUTH_TTL_MINUTES 的值是 47。";

/** 假的模型调用：只返回一段文本，测试裁判解析和回退，不触网。 */
function chatReturning(text: string): ChatHandler {
  return async () => ({
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
  });
}

test("KeywordJudge 要求全部关键词", async () => {
  const judge = new KeywordJudge();
  const good = await judge.evaluate({ task, finalAnswer: goodAnswer, trace: [] });
  assert.equal(good.passed, true);
  assert.equal(good.score, 5);

  const bad = await judge.evaluate({ task, finalAnswer: "我不知道。", trace: [] });
  assert.equal(bad.passed, false);
  assert.match(bad.reason, /缺少关键词/);
});

test("LLMJudge 解析 JSON 并给出分数", async () => {
  const judge = new LLMJudge({
    chat: chatReturning('{"score": 4, "reason": "回答了 47，但没提到文档来源"}'),
    model: "fake-judge",
  });
  const verdict = await judge.evaluate({ task, finalAnswer: goodAnswer, trace: [] });

  assert.equal(verdict.source, "llm");
  assert.equal(verdict.score, 4);
  assert.equal(verdict.passed, true);
  assert.match(verdict.reason, /47/);
});

test("LLMJudge 兼容 Markdown 代码块，解析失败时回退 KeywordJudge", async () => {
  const withCodeBlock = new LLMJudge({
    chat: chatReturning('```json\n{"score": 5, "reason": "完整"}\n```'),
    model: "fake-judge",
  });
  const parsed = await withCodeBlock.evaluate({ task, finalAnswer: goodAnswer, trace: [] });
  assert.equal(parsed.score, 5);
  assert.equal(parsed.source, "llm");

  const broken = new LLMJudge({
    chat: chatReturning("我觉得还不错，但懒得打分。"),
    model: "fake-judge",
    fallback: new KeywordJudge(),
  });
  const fallback = await broken.evaluate({ task, finalAnswer: goodAnswer, trace: [] });
  assert.equal(fallback.source, "fallback");
  assert.equal(fallback.passed, true);
  assert.match(fallback.reason, /LLM 裁判失败/);
});

test("parseJudgeOutput 拒绝非法分数并夹在 0-5", () => {
  assert.equal(parseJudgeOutput("no json"), null);
  assert.deepEqual(parseJudgeOutput('{"score": 9, "reason": "x"}'), {
    score: 5,
    reason: "x",
  });
  assert.deepEqual(parseJudgeOutput('{"score": -2, "reason": "x"}'), {
    score: 0,
    reason: "x",
  });
});

test("裁判提示词包含参考要点和最终回答", () => {
  const prompt = buildJudgePrompt({ task, finalAnswer: goodAnswer, trace: [] });
  assert.match(prompt, /参考要点/);
  assert.match(prompt, /AUTH_TTL_MINUTES 的值是 47/);
  assert.match(prompt, /docs\/architecture\.md/);
  assert.match(prompt, /最终回答/);
});
