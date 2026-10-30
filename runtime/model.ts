/**
 * 模型调用入口 —— 全仓共用的 callChat。
 *
 * mock 模式：直接调用传入的 mockFn（各章脚本化的「模型」），不读任何网络配置。
 * real 模式：按 env 构造 Anthropic 客户端发起真实请求；缺少凭据时回退 mock 并只告警一次。
 * 两者共用同一条调用签名，因此章节的机制代码在两种模式下完全一致。
 */

import Anthropic from "@anthropic-ai/sdk";
import { getModelConfig, loadEnvOnce, resolveMode, type ModelConfig } from "./env.ts";
import { sanitizeToolPairs } from "./response.ts";
import type { LLMResponse, LLMUsage, Message, TextBlock, ToolUseBlock } from "./types.ts";

/** 工具入参 JSON Schema：直接复用 SDK 类型，保证与真实报文兼容。 */
export type ToolInputSchema = Anthropic.Messages.Tool.InputSchema;

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
}

export interface ChatInput {
  messages: Message[];
  system?: string;
  tools?: ToolSchema[];
  /** 覆盖本次请求的模型；缺省用 env 中的 MODEL_ID（s11 备用模型切换用）。 */
  model?: string;
  /** 覆盖本次请求的 max_tokens；缺省用 env 中的 MODEL_MAX_TOKENS（s11 升级用）。 */
  maxTokens?: number;
}

export type ChatHandler = (input: ChatInput) => Promise<LLMResponse>;

export interface ChatHandlerOptions {
  tools?: ToolSchema[];
  system?: string;
  label?: string;
  model?: string;
  maxTokens?: number;
}

// SDK 会自行追加 /v1/messages，这里去掉尾部的 / 和 /v1，避免路径重复。
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

function toAnthropicMessages(messages: Message[]) {
  // MessageContent 与 Anthropic 的 content 形状一致（文本 / tool_use / tool_result），
  // 直接透传即可：字符串按纯文本发送，块数组按结构化内容发送。
  // 发送前清理悬空配对，避免压缩/截断后的消息列表触发 API 报错。
  return sanitizeToolPairs(messages).map((message) => ({
    role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: message.content as Anthropic.Messages.MessageParam["content"],
  }));
}

function mapStopReason(reason: string | null | undefined): LLMResponse["stop_reason"] {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  return "end_turn";
}

/** 把 SDK 的 usage 转成仓库内部类型；缺失的缓存字段不填 0，保持 undefined。 */
function mapUsage(usage: Anthropic.Messages.Usage | undefined): LLMUsage | undefined {
  if (!usage) return undefined;
  const cacheCreation = usage.cache_creation_input_tokens;
  const cacheRead = usage.cache_read_input_tokens;
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    ...(cacheCreation == null ? {} : { cache_creation_input_tokens: cacheCreation }),
    ...(cacheRead == null ? {} : { cache_read_input_tokens: cacheRead }),
  };
}

function mapContent(content: Anthropic.Messages.ContentBlock[]): LLMResponse["content"] {
  const blocks: Array<TextBlock | ToolUseBlock> = [];
  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      blocks.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }
  return blocks;
}

export function createAnthropicChatHandler(config: ModelConfig): ChatHandler {
  // AUTH_TOKEN 走 Bearer，API_KEY 走 x-api-key。只发一个，避免两个头值不一致返回 401。
  const auth =
    config.authHeader === "authToken"
      ? { authToken: config.apiKey }
      : { apiKey: config.apiKey };

  const client = new Anthropic({
    ...auth,
    baseURL: normalizeBaseUrl(config.baseUrl),
    timeout: config.timeoutMs,
    maxRetries: 2,
  });

  return async (input) => {
    const message = await client.messages.create({
      model: input.model ?? config.model,
      max_tokens: input.maxTokens ?? config.maxTokens,
      ...(input.system ? { system: input.system } : {}),
      messages: toAnthropicMessages(input.messages),
      ...(input.tools?.length ? { tools: input.tools } : {}),
    });

    return {
      stop_reason: mapStopReason(message.stop_reason),
      content: mapContent(message.content),
      usage: mapUsage(message.usage),
    };
  };
}

let cached: { key: string; handler: ChatHandler } | null = null;
let warnedUnconfigured = false;

function realHandler(config: ModelConfig): ChatHandler {
  const key = `${config.baseUrl}|${config.model}|${config.apiKey}|${config.authHeader}`;
  if (!cached || cached.key !== key) {
    cached = { key, handler: createAnthropicChatHandler(config) };
  }
  return cached.handler;
}

export async function callChat(
  mockFn: (messages: Message[]) => LLMResponse | Promise<LLMResponse>,
  messages: Message[],
  options: ChatHandlerOptions = {},
): Promise<LLMResponse> {
  loadEnvOnce();

  if (resolveMode() === "real") {
    const config = getModelConfig();
    if (config) {
      return realHandler(config)({
        messages,
        system: options.system,
        tools: options.tools,
        model: options.model,
        maxTokens: options.maxTokens,
      });
    }
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn(
        "[model] 已请求 real 模式，但缺少 ANTHROPIC_AUTH_TOKEN / MODEL_ID，本次回退到 mock。",
      );
    }
  }

  return mockFn(messages);
}
