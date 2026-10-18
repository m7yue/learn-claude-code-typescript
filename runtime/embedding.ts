/**
 * embedding 调用入口 —— 与 runtime/model.ts 的 callChat 同一个 mock/real 风格。
 *
 * 作用：把一段文字变成一个向量（一串数字）。
 *
 * mock 模式：返回「占位向量」（零配置、可运行，但没有真实语义，仅用于把代码结构跑通）。
 * real 模式：调用 OpenAI 兼容的 /v1/embeddings 接口，需要在 .env 里配置三个变量：
 *   EMBEDDING_BASE_URL   例如 https://api.siliconflow.cn
 *   EMBEDDING_API_KEY    平台的 API Key
 *   EMBEDDING_MODEL      例如 BAAI/bge-large-zh-v1.5
 *
 * 铁律：存向量和查向量必须用同一个模型（同一份配置），否则余弦相似度没有意义。
 */

import { resolveMode } from "./env.ts";

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 读取 embedding 配置；缺任一变量返回 null（表示未配置）。 */
export function getEmbeddingConfig(): EmbeddingConfig | null {
  const baseUrl = (process.env.EMBEDDING_BASE_URL || "").trim();
  const apiKey = (process.env.EMBEDDING_API_KEY || "").trim();
  const model = (process.env.EMBEDDING_MODEL || "").trim();
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl, apiKey, model };
}

/**
 * 占位向量：零配置可运行，但没有真实语义。
 * 只是用一个固定 32 维、按字符编码累加的简单算法，让「结构」能跑起来。
 * 填了 key 之后这段不会被走（real 模式走下面的真实调用）。
 */
function mockEmbed(text: string): number[] {
  const dim = 32;
  const vec = new Array<number>(dim).fill(0);
  for (let i = 0; i < text.length; i += 1) {
    vec[i % dim] += text.charCodeAt(i);
  }
  return vec;
}

/** 把文字变成向量。mock 模式用占位向量，real 模式调真实接口。 */
export async function embedText(text: string): Promise<number[]> {
  if (resolveMode() === "real") {
    const config = getEmbeddingConfig();
    if (!config) {
      throw new Error(
        "[embedding] real 模式缺少配置：请在 .env 设置 EMBEDDING_BASE_URL / EMBEDDING_API_KEY / EMBEDDING_MODEL",
      );
    }
    const url = `${config.baseUrl.replace(/\/+$/, "")}/v1/embeddings`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: config.model, input: text }),
    });
    if (!resp.ok) {
      throw new Error(`[embedding] 请求失败：${resp.status} ${await resp.text()}`);
    }
    const json = (await resp.json()) as { data: Array<{ embedding: number[] }> };
    return json.data[0].embedding;
  }
  return mockEmbed(text);
}
