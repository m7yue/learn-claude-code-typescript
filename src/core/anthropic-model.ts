/**
 * 工程层的真实模型实现：把 src/core 的 Model 接口接到 Anthropic 兼容端点。
 *
 * 复用 runtime/model.ts 的底层请求（无 SDK，仅 fetch），
 * 在这里完成 src/core 类型 ↔ Anthropic 报文之间的转换。
 */

import { getModelConfig, type ModelConfig } from "../../runtime/env.ts";
import { createAnthropicChatHandler, type ChatHandler, type ToolSchema } from "../../runtime/model.ts";
import type { LLMResponse, Message as RuntimeMessage } from "../../runtime/types.ts";
import { ScriptedModel, finalTurn } from "./scripted-model.ts";
import type { Message, Model, ModelTurn, ToolDefinition } from "./types.ts";

function toRuntimeMessages(messages: Message[]): RuntimeMessage[] {
  const converted: RuntimeMessage[] = [];
  for (const message of messages) {
    // system 走顶层的 system 字段，其余角色按文本转发。
    // tool 结果在工程层以文本消息承载，保持与各章一致。
    if (message.role === "system") continue;
    converted.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    });
  }
  return converted;
}

function toToolSchemas(tools: ToolDefinition[]): ToolSchema[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters ?? { type: "object", properties: {} },
  }));
}

function toModelTurn(response: LLMResponse): ModelTurn {
  const content = response.content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");

  if (response.stop_reason === "tool_use") {
    return {
      stopReason: "tool_use",
      content,
      toolUses: response.content
        .filter((block) => block.type === "tool_use")
        .map((block) => ({ id: block.id, name: block.name, args: block.input })),
      usage: response.usage,
    };
  }

  if (response.stop_reason === "max_tokens") {
    return { stopReason: "max_tokens", content, usage: response.usage };
  }

  return { stopReason: "end", content, usage: response.usage };
}

export class AnthropicModel implements Model {
  private readonly handler: ChatHandler;

  constructor(config: ModelConfig) {
    this.handler = createAnthropicChatHandler(config);
  }

  async complete(input: {
    system: string;
    messages: Message[];
    tools: ToolDefinition[];
  }): Promise<ModelTurn> {
    const response = await this.handler({
      messages: toRuntimeMessages(input.messages),
      system: input.system,
      tools: toToolSchemas(input.tools),
    });
    return toModelTurn(response);
  }
}

/**
 * 选择模型：配置了真实模型就用 AnthropicModel，否则回退到 ScriptedModel，
 * 保证 harness 零配置也能跑。
 */
export function createModel(): Model {
  const config = getModelConfig();
  if (config) return new AnthropicModel(config);
  return new ScriptedModel([
    finalTurn("（mock 模式）未配置真实模型。设置 ANTHROPIC_AUTH_TOKEN 与 MODEL_ID 后可用 --real 运行。"),
  ]);
}
