/**
 * 错误分类 —— 按错误类名与小写 message 做子串匹配，识别可恢复错误。
 *
 * 识别方式用「错误类名 + 小写 message 字符串」做子串匹配（429 限流 / 529 过载 /
 * prompt 过长），而不是 `instanceof`。这一点在真实路径下很关键：Anthropic SDK
 * 抛出的异常类型名（RateLimitError / InternalServerError / APIError）与教学用的
 * 自定义类并不一致，只有字符串匹配才能同时覆盖 SDK 原生错误与脚本化错误。
 *
 * 因此这里导出 classifyError()，供各章在 catch 中统一调用，替代 `instanceof`。
 */

export type ErrorKind = "rate_limit" | "overloaded" | "prompt_too_long" | "other";

/** 提取错误的类名：优先 constructor.name，其次 name 字段。 */
function errorName(error: unknown): string {
  if (error && typeof error === "object") {
    const ctor = (error as { constructor?: { name?: string } }).constructor;
    if (ctor?.name) return ctor.name;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name) return name;
  }
  return "";
}

/** 提取错误消息文本（小写）。 */
function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message.toLowerCase();
  }
  return String(error).toLowerCase();
}

/** 提取 HTTP 状态码（SDK 错误通常带 status 字段）。 */
function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

/**
 * 把任意错误归类到恢复路径。
 *
 * 匹配顺序：先判 prompt_too_long（消息特征最具体），再判 429/529。
 */
export function classifyError(error: unknown): ErrorKind {
  const name = errorName(error).toLowerCase();
  const msg = errorMessage(error);
  const status = errorStatus(error);

  // Path 2: prompt / context 过长
  if (
    (msg.includes("prompt") && msg.includes("long")) ||
    msg.includes("prompt_is_too_long") ||
    msg.includes("context_length_exceeded") ||
    msg.includes("max_context_window")
  ) {
    return "prompt_too_long";
  }

  // Path 3a: 429 限流
  if (status === 429 || name.includes("ratelimit") || msg.includes("429") || msg.includes("rate limit")) {
    return "rate_limit";
  }

  // Path 3b: 529 过载
  if (status === 529 || name.includes("overloaded") || msg.includes("529") || msg.includes("overloaded")) {
    return "overloaded";
  }

  return "other";
}
