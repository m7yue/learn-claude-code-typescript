/**
 * Evals 的公共类型。
 *
 * 评测分两层依赖：
 *   runner.ts 只依赖这里的接口（Judge / AgentRunner），不依赖具体实现；
 *   cli/index.ts 负责把 HarnessAgentRunner、KeywordJudge、LLMJudge 装在一起。
 */

import type { LLMUsage } from "../runtime/types.ts";
import type { CheckSpec, TaskDefinition } from "./task-definition.ts";

export type {
  CheckSpec,
  CommandCheck,
  FileContentCheck,
  FileMissingCheck,
  FileUnchangedCheck,
  FinalAnswerCheck,
  ScriptStep,
  TaskDefinition,
  TaskSelfCheck,
  ToolsUsedCheck,
} from "./task-definition.ts";

// ---------------------------------------------------------------------------
// 任务与检查
// ---------------------------------------------------------------------------

/**
 * 加载后的任务：在 TaskDefinition 基础上补上 prompt 正文和 fixture 路径。
 * 字段说明见 task-definition.ts 里的 zod schema。
 */
export interface EvalTask extends TaskDefinition {
  /** prompt.md 的正文，运行时再替换 {{WORKSPACE}} / {{OUTSIDE}}。 */
  promptTemplate: string;
  /** 任务 fixture 的绝对路径，trial 开始时复制到临时工作区。 */
  fixtureDir: string;
}

/** 单个检查的结果；passed 为 false 时 message 说明原因。 */
export interface CheckResult {
  /** 对应 CheckSpec.id。 */
  id: string;
  /** 检查类型，便于报告分组。 */
  type: CheckSpec["type"];
  /** 是否影响 trial 通过。 */
  required: boolean;
  /** 是否通过。 */
  passed: boolean;
  /** 给人看的结果说明。 */
  message: string;
}

// ---------------------------------------------------------------------------
// 轨迹与 AgentRunner
// ---------------------------------------------------------------------------

/** 一次 trial 的轨迹事件；子进程写 JSONL，父进程读取后用于检查和报告。 */
export type TrajectoryEvent =
  | {
      /** 一次模型调用。 */
      type: "model";
      /** 第几次模型调用，从 1 开始。 */
      turn: number;
      /** 模型为什么停下：end、tool_use 或 max_tokens。 */
      stopReason: string;
      /** 真实调用的 token 用量；mock 或接口没返回时没有。 */
      usage?: LLMUsage;
      /** 这次模型调用花了多久。 */
      durationMs: number;
    }
  | {
      /** 一次工具调用。 */
      type: "tool";
      /** 工具名。 */
      name: string;
      /** 调用参数。 */
      args: Record<string, unknown>;
      /** 工具返回的文本。 */
      result: string;
      /** handler 是否抛了错；被拒绝的调用不会产生这个事件。 */
      error: boolean;
      /** 工具执行耗时。 */
      durationMs: number;
    }
  | {
      /** 一次权限审批。 */
      type: "approval";
      /** 被审批的工具名。 */
      toolName: string;
      /** 调用参数。 */
      args: Record<string, unknown>;
      /** 是否放行；非交互场景里 ask 也会被拒绝。 */
      approved: boolean;
      /** 权限管线给出的原因。 */
      reason: string;
    };

/** 运行模式：fake 用脚本模型，real 用真实模型。 */
export type RunMode = "fake" | "real";

/** 自检脚本名：gold 是正确脚本，broken 是错误脚本。 */
export type ScriptName = "gold" | "broken";

/** 一次 agent 运行的输入；由 runner 准备，由 AgentRunner 执行。 */
export interface AgentRunInput {
  /** 要跑的任务。 */
  task: EvalTask;
  /** 这次 trial 的工作区，agent 在这里读写文件。 */
  workspace: string;
  /** 越界写入的目标目录，用来检查文件有没有被写到外面。 */
  outside: string;
  /** 已经替换好占位符的 prompt 正文。 */
  prompt: string;
  /** fake 或 real。 */
  mode: RunMode;
  /** fake 模式下用哪套脚本；real 模式忽略。 */
  script?: ScriptName;
  /** 子进程超时时间。 */
  timeoutMs: number;
  /** agent 最大模型回合数。 */
  maxTurns: number;
  /** 是否保留 prompt/result/trace 所在的 IO 目录；默认删除。 */
  keepIo?: boolean;
  /** 保留 IO 目录时的回调，用来打印路径。 */
  onIoKept?: (path: string) => void;
}

/** 一次 agent 运行的结果；不包含“是否通过”，通过由检查器判断。 */
export interface AgentRunResult {
  /** ok 表示正常结束；error 表示抛错；timeout 表示被父进程杀掉。 */
  status: "ok" | "error" | "timeout";
  /** agent 的最终回答；失败时为空串。 */
  finalAnswer: string;
  /** mock 记 0，real 拿不到时记 null。 */
  tokens: { input: number; output: number } | null;
  /** agent 执行耗时，不包含父进程启动子进程的时间。 */
  durationMs: number;
  /** 是否有模型回合因为 max_tokens 被截断。 */
  truncated: boolean;
  /** 模型/工具/审批事件。 */
  trace: TrajectoryEvent[];
  /** 失败时的错误信息。 */
  error?: string;
}

/** 评测器只依赖这个接口；具体是子进程还是假实现由 cli/index.ts 决定。 */
export interface AgentRunner {
  /** 跑一次任务；实现方负责隔离、超时和结果组装。 */
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

// ---------------------------------------------------------------------------
// 裁判
// ---------------------------------------------------------------------------

/** 裁判需要的输入：任务（含参考要点）、最终回答和轨迹。 */
export interface JudgeInput {
  /** 当前任务，裁判从里面读 referencePoints。 */
  task: EvalTask;
  /** agent 的最终回答。 */
  finalAnswer: string;
  /** 轨迹；裁判目前不强制使用，但保留给以后检查过程。 */
  trace: TrajectoryEvent[];
}

/** 裁判的结果；score 和 passed 都可能为 null。 */
export interface JudgeResult {
  /** 0–5 分；KeywordJudge 给 0 或 5。 */
  score: number | null;
  /** 裁判自己的通过判断；只展示，不影响 trial 通过。 */
  passed: boolean | null;
  /** 一句话理由。 */
  reason: string;
  /** 结论来自哪种裁判：keyword、llm，或 LLM 失败后的 fallback。 */
  source: "keyword" | "llm" | "fallback";
}

/** 评测器只依赖这个接口；KeywordJudge 和 LLMJudge 都实现它。 */
export interface Judge {
  /** 裁判名称，报告里用来区分。 */
  readonly name: string;
  /** 给一次运行的最终回答打分。 */
  evaluate(input: JudgeInput): Promise<JudgeResult>;
}

// ---------------------------------------------------------------------------
// 运行结果
// ---------------------------------------------------------------------------

/** 一次 trial 的结果：passed 只看 required 检查，judge 只展示不参与判定。 */
export interface TrialResult {
  /** 任务 id。 */
  taskId: string;
  /** 第几次试验，从 1 开始。 */
  trial: number;
  /** agent 运行状态，来自 AgentRunResult.status。 */
  status: AgentRunResult["status"];
  /** 所有 required 检查是否都通过。 */
  passed: boolean;
  /** 每个检查的详细结果。 */
  checks: CheckResult[];
  /** 裁判结论，只用于展示。 */
  judge: JudgeResult;
  /** agent 的最终回答。 */
  finalAnswer: string;
  /** token 用量；mock 为 0，real 缺失为 null。 */
  tokens: { input: number; output: number } | null;
  /** 这次 trial 的总耗时。 */
  durationMs: number;
  /** 是否有模型回合因为 max_tokens 被截断。 */
  truncated: boolean;
  /** agent 失败时的错误信息。 */
  error?: string;
}

/** 一个任务在所有 trial 上的 token 平均值。 */
export interface TokenSummary {
  /** 平均输入 token。 */
  input: number;
  /** 平均输出 token。 */
  output: number;
  /** 平均总 token。 */
  total: number;
}

/** 一个任务的汇总；用于报告里的逐任务表。 */
export interface TaskSummary {
  /** 任务 id。 */
  taskId: string;
  /** 任务名。 */
  title: string;
  /** 这个任务跑了几次。 */
  trials: number;
  /** 通过了几次。 */
  passed: number;
  /** passed / trials。 */
  successRate: number;
  /** 平均 token；没有数据时为 null。 */
  avgTokens: TokenSummary | null;
  /** 平均耗时，单位毫秒。 */
  avgDurationMs: number;
  /** 每次 trial 的裁判结论。 */
  judges: JudgeResult[];
  /** 失败检查的说明，来自所有未通过的 trial。 */
  failures: string[];
}

/** 一次完整评测的结果，也是 run.json 的结构。 */
export interface EvalReport {
  /** run.json 的结构版本，用于基线校验。 */
  schemaVersion: 1;
  /** 本次运行的唯一 id，结果目录名用它。 */
  runId: string;
  /** fake 或 real。 */
  mode: RunMode;
  /** 候选模型名；mock 模式是 "mock"。 */
  model: string;
  /** 裁判名称。 */
  judge: string;
  /** LLM 裁判与候选模型相同时为 true，报告里要告警。 */
  selfJudge: boolean;
  /** 开始时间，ISO 字符串。 */
  startedAt: string;
  /** 整次运行的总耗时。 */
  durationMs: number;
  /** 每次 trial 的明细。 */
  trials: TrialResult[];
  /** 每个任务的汇总。 */
  tasks: TaskSummary[];
  /** 整次运行的汇总。 */
  summary: {
    /** 总试验次数。 */
    totalTrials: number;
    /** 通过的试验次数。 */
    passedTrials: number;
    /** passedTrials / totalTrials。 */
    successRate: number;
    /** 所有 trial 的平均 token；没有数据时为 null。 */
    avgTokens: TokenSummary | null;
    /** 所有 trial 的平均耗时。 */
    avgDurationMs: number;
    /** 被 max_tokens 截断的 trial 数。 */
    truncatedTrials: number;
  };
}

/** runEvals 的运行参数；由 cli/index.ts 根据 CLI 参数组装。 */
export interface RunOptions {
  /** 每个任务跑几次。 */
  trials: number;
  /** fake 或 real。 */
  mode: RunMode;
  /** fake 模式下用哪套自检脚本。 */
  script?: ScriptName;
  /** 是否保留临时工作区；默认清理。 */
  keepWorkspace?: boolean;
  /** 保留工作区时的回调，用来打印路径。 */
  onWorkspaceKept?: (path: string) => void;
  /** 是否保留 prompt/result/trace 所在的 IO 目录；默认删除。 */
  keepIo?: boolean;
  /** 保留 IO 目录时的回调，用来打印路径。 */
  onIoKept?: (path: string) => void;
  /** 报告里显示的模型名。 */
  model: string;
  /** 报告里显示的裁判名。 */
  judge: string;
  /** 裁判与候选模型是否相同。 */
  selfJudge?: boolean;
}
