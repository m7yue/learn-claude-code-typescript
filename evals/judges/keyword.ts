/**
 * 零配置裁判：答案包含全部 expectKeywords 就算通过。
 *
 * 它不看推理过程，也不处理同义表达，只适合演示评测链路和作为 LLM 裁判的回退。
 */

import type { Judge, JudgeInput, JudgeResult } from "../types.ts";

export class KeywordJudge implements Judge {
  readonly name = "keyword";

  async evaluate(input: JudgeInput): Promise<JudgeResult> {
    const missing = input.task.expectKeywords.filter(
      (keyword) => !input.finalAnswer.includes(keyword),
    );
    if (missing.length === 0) {
      return {
        score: 5,
        passed: true,
        reason: "最终回答包含全部关键词",
        source: "keyword",
      };
    }
    return {
      score: 0,
      passed: false,
      reason: `最终回答缺少关键词: ${missing.join("、")}`,
      source: "keyword",
    };
  }
}
