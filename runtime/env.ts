/**
 * 运行模式与真实模型配置
 *
 * 设计原则：默认零配置跑 mock。只有明确要求 real 时，才会读取 .env 并请求网络。
 * 模式优先级：命令行 --real/--mock > 环境变量 AGENT_MODE > 默认 mock
 *
 * .env 由 Node 20.12+ 内置的 process.loadEnvFile 加载；文件缺失时静默跳过。
 */

export type AgentMode = "mock" | "real";

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  authHeader: "apiKey" | "authToken";
  model: string;
  maxTokens: number;
  timeoutMs: number;
}

let envLoaded = false;

/** 加载 .env；重复调用也只会真正执行一次。文件缺失是正常情况，直接跳过。 */
export function loadEnvOnce(): void {
  if (envLoaded) return;
  envLoaded = true;
  try {
    process.loadEnvFile();
  } catch {
    // 没有 .env：保持纯环境变量模式
  }
}

/** 解析当前运行模式。 */
export function resolveMode(argv: readonly string[] = process.argv): AgentMode {
  if (argv.includes("--real")) return "real";
  if (argv.includes("--mock")) return "mock";
  loadEnvOnce();
  return process.env.AGENT_MODE?.trim().toLowerCase() === "real" ? "real" : "mock";
}

/** 读取真实模型配置。缺少 token 或 MODEL_ID 时返回 null（表示未配置）。 */
export function getModelConfig(): ModelConfig | null {
  loadEnvOnce();
  const authToken = (process.env.ANTHROPIC_AUTH_TOKEN || "").trim();
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim();
  const token = authToken || apiKey;
  const model = (process.env.MODEL_ID || "").trim();
  if (!token || !model) return null;

  return {
    baseUrl: (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").trim(),
    apiKey: token,
    authHeader: authToken ? "authToken" : "apiKey",
    model,
    maxTokens: Number(process.env.MODEL_MAX_TOKENS) || 1024,
    timeoutMs: Number(process.env.MODEL_TIMEOUT_MS) || 60_000,
  };
}

/** 供日志使用的一行模式描述。 */
export function describeMode(): string {
  if (resolveMode() !== "real") return "mock";
  const config = getModelConfig();
  return config ? `real (${config.model})` : "real (未配置，回退 mock)";
}
