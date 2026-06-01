export type RecoveryAction = "continue" | "compact" | "retry" | "fallback_model" | "fail";

export interface RecoveryDecision {
  action: RecoveryAction;
  reason: string;
  delayMs?: number;
}

export function classifyError(error: unknown, attempt: number): RecoveryDecision {
  const message = error instanceof Error ? error.message : String(error);
  if (/max_tokens|truncated/i.test(message)) {
    return { action: "continue", reason: "输出被截断，追加 continuation prompt" };
  }
  if (/context|token/i.test(message)) {
    return { action: "compact", reason: "上下文超限，先压缩历史" };
  }
  if (/529|overloaded|rate/i.test(message) && attempt >= 2) {
    return { action: "fallback_model", reason: "连续过载，切换 fallback model" };
  }
  if (attempt < 3) {
    return { action: "retry", reason: "临时错误，指数退避重试", delayMs: 500 * 2 ** attempt };
  }
  return { action: "fail", reason: "超过恢复次数" };
}
