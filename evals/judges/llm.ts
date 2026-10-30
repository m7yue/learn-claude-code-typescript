/**
 * 大模型裁判：按 referencePoints 给最终回答打 0-5 分。
 *
 * 提示词里明确写了「简洁但正确不扣分、冗长不额外加分」，
 * 用来压制常见的长度偏见；评分规则写死，避免模型自由发挥。
 * 这是点对点评分，不比较两个答案，因此没有位置偏见。
 *
 * 当前只做单裁判。
 */

import type { ModelConfig } from "../../runtime/env.ts";
import {
  createAnthropicChatHandler,
  type ChatHandler,
} from "../../runtime/model.ts";
import type { Judge, JudgeInput, JudgeResult } from "../types.ts";
import { KeywordJudge } from "./keyword.ts";

const JUDGE_SYSTEM_PROMPT = `你是严格的评测裁判。按参考要点给最终回答打分，0-5 分。
规则：
- 简洁但正确的答案不扣分，冗长不额外加分；不要因为答案长就给高分。
- 只根据参考要点和回答本身判断，不要猜测，不要补充回答里没有的信息。
- 只输出 JSON：{"score": <0-5 的数字>, "reason": "<一句话理由>"}。`;

export interface LLMJudgeOptions {
  chat: ChatHandler;
  model: string;
  maxTokens?: number;
  fallback?: Judge;
}

export class LLMJudge implements Judge {
  readonly name = "llm";
  private readonly chat: ChatHandler;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly fallback: Judge;

  constructor(options: LLMJudgeOptions) {
    this.chat = options.chat;
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? 512;
    this.fallback = options.fallback ?? new KeywordJudge();
  }

  async evaluate(input: JudgeInput): Promise<JudgeResult> {
    try {
      const response = await this.chat({
        model: this.model,
        maxTokens: this.maxTokens,
        system: JUDGE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildJudgePrompt(input) }],
      });
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      const parsed = parseJudgeOutput(text);
      if (!parsed) {
        throw new Error(`裁判输出不是有效 JSON: ${text.slice(0, 120)}`);
      }
      return {
        score: parsed.score,
        passed: parsed.score >= 3,
        reason: parsed.reason || "裁判未给出理由",
        source: "llm",
      };
    } catch (error) {
      // 裁判调用失败或输出不合法时回退关键词判定；
      // 在 reason 里保留失败原因，避免看起来像一次正常的裁判结果。
      const verdict = await this.fallback.evaluate(input);
      return {
        ...verdict,
        source: "fallback",
        reason: `${verdict.reason}（LLM 裁判失败: ${
          error instanceof Error ? error.message : String(error)
        }）`,
      };
    }
  }
}

/** 用真实 Anthropic 兼容端点构造裁判；默认复用候选模型配置。 */
export function createLLMJudge(
  config: ModelConfig,
  options: { judgeModel?: string; maxTokens?: number; fallback?: Judge } = {},
): LLMJudge {
  const judgeModel = options.judgeModel ?? config.model;
  return new LLMJudge({
    chat: createAnthropicChatHandler({ ...config, model: judgeModel }),
    model: judgeModel,
    maxTokens: options.maxTokens,
    fallback: options.fallback,
  });
}

/**
 * 只给任务、参考要点和最终回答，不告诉裁判这是哪个模型/哪一版生成的，
 * 减少先入为主；评分标准由系统提示词固定。
 */
export function buildJudgePrompt(input: JudgeInput): string {
  return [
    `任务: ${input.task.title}`,
    `问题: ${input.task.promptTemplate.trim()}`,
    `参考要点:\n${input.task.referencePoints
      .map((point, index) => `${index + 1}. ${point}`)
      .join("\n")}`,
    `最终回答:\n${input.finalAnswer.trim() || "(空)"}`,
    "请按系统提示的格式输出 JSON。",
  ].join("\n\n");
}

/**
 * 解析裁判输出。模型常把 JSON 包在 Markdown 代码块或说明文字里，
 * 所以先取代码块内容，再取第一个 { 到最后一个 }；解析失败返回 null 交给回退。
 */
export function parseJudgeOutput(text: string): { score: number; reason: string } | null {
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const content = codeBlock ? codeBlock[1] : text;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  try {
    const parsed = JSON.parse(content.slice(start, end + 1)) as {
      score?: unknown;
      reason?: unknown;
    };
    if (typeof parsed.score !== "number" || !Number.isFinite(parsed.score)) {
      return null;
    }
    return {
      score: Math.max(0, Math.min(5, parsed.score)),
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch {
    return null;
  }
}
