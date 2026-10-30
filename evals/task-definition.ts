/**
 * 任务的类型、运行时 schema，以及 defineTask / validateTaskDefinition。
 *
 * 三者放在同一个模块里：
 *   - task.ts 用 defineTask 得到编译期的字段类型检查；
 *   - loader 在加载任务时调用 validateTaskDefinition 做运行时校验；
 *   - 新增字段或检查时，schema、类型和校验规则在同一处维护。
 *
 * 校验分两层：zod 负责字段结构和单检查规则，superRefine 负责跨字段规则
 * （检查 id 唯一、selfCheck 最后一步必须是 final）。
 */

import { isAbsolute } from "node:path";
import { z } from "zod";

const nonEmptyString = z
  .string()
  .refine((value) => value.trim().length > 0, "不能为空");

const regexString = z.string().refine((value) => {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}, "不是有效的正则表达式");

/** 检查路径：允许相对路径、绝对路径和两个占位符；相对路径不能含 ..。 */
const checkPath = z.string().refine((value) => {
  const rendered = value
    .replaceAll("{{WORKSPACE}}", "/workspace")
    .replaceAll("{{OUTSIDE}}", "/outside");
  if (isAbsolute(rendered)) return true;
  return !rendered.split(/[\\/]/).includes("..");
}, "路径不能越出工作区");

/** file-unchanged 要同时定位 workspace 和 fixture，只能使用相对路径。 */
const relativePath = z.string().refine((value) => {
  if (value.includes("{{") || isAbsolute(value)) return false;
  return !value.split(/[\\/]/).includes("..");
}, "file-unchanged 只能用于工作区内相对路径");

const checkBase = {
  /** 检查的稳定标识，报告里用它定位失败项。 */
  id: nonEmptyString,
  /** 默认 true；false 的检查只展示，不影响通过。 */
  required: z.boolean().optional(),
};

/** 文件内容检查；写多个条件时必须同时满足。 */
const fileContentCheckSchema = z
  .object({
    ...checkBase,
    type: z.literal("file-content"),
    /** 相对 workspace 的路径，或 {{WORKSPACE}} / {{OUTSIDE}} 占位符。 */
    path: checkPath,
    /** 必须包含的文本。 */
    contains: nonEmptyString.optional(),
    /** 不能包含的文本。 */
    notContains: nonEmptyString.optional(),
    /** 必须匹配的正则表达式。 */
    matches: regexString.optional(),
    /** 必须完全相等的内容（包括换行和空格）。 */
    equals: z.string().optional(),
  })
  .refine(
    (check) =>
      check.contains !== undefined ||
      check.notContains !== undefined ||
      check.matches !== undefined ||
      check.equals !== undefined,
    "至少需要一个内容条件",
  );

/** 文件必须不存在；用于确认越界写入没有真的发生。 */
const fileMissingCheckSchema = z.object({
  ...checkBase,
  type: z.literal("file-missing"),
  /** 相对 workspace 的路径，或 {{OUTSIDE}} 占位符。 */
  path: checkPath,
});

/** 文件必须和 fixture 的原始副本完全一致。 */
const fileUnchangedCheckSchema = z.object({
  ...checkBase,
  type: z.literal("file-unchanged"),
  /** 相对 workspace 的路径；不能是绝对路径或带占位符。 */
  path: relativePath,
});

/** 在任务工作区执行命令，检查退出码和输出。 */
const commandCheckSchema = z.object({
  ...checkBase,
  type: z.literal("command"),
  /** 交给 sh -lc 执行的命令。 */
  command: nonEmptyString,
  /** 期望的退出码，默认 0。 */
  expectExit: z.number().int().optional(),
  /** 命令输出里必须包含的文本。 */
  stdoutContains: z.string().optional(),
  /** 命令超时时间，默认 30 秒。 */
  timeoutMs: z.number().positive("必须是正数").optional(),
});

/** 检查 agent 的最终回答。 */
const finalAnswerCheckSchema = z
  .object({
    ...checkBase,
    type: z.literal("final-answer"),
    /** 最终回答里必须包含的文本。 */
    contains: z.array(nonEmptyString).min(1, "不能为空").optional(),
    /** 最终回答里不能出现的文本。 */
    notContains: z.array(nonEmptyString).min(1, "不能为空").optional(),
    /** 最终回答必须匹配的正则表达式。 */
    matches: regexString.optional(),
  })
  .refine(
    (check) =>
      (check.contains?.length ?? 0) > 0 ||
      (check.notContains?.length ?? 0) > 0 ||
      check.matches !== undefined,
    "至少需要一个回答条件",
  );

/** 检查轨迹里指定工具至少被调用了几次。 */
const toolsUsedCheckSchema = z.object({
  ...checkBase,
  type: z.literal("tools-used"),
  /** 要统计的工具名；命中其中任意一个就计数。 */
  names: z.array(nonEmptyString).min(1, "不能为空"),
  /** 至少调用多少次，默认 1。 */
  minCalls: z.number().int().positive("必须是正整数").optional(),
});

export const checkSpecSchema = z.discriminatedUnion("type", [
  fileContentCheckSchema,
  fileMissingCheckSchema,
  fileUnchangedCheckSchema,
  commandCheckSchema,
  finalAnswerCheckSchema,
  toolsUsedCheckSchema,
]);

/**
 * 脚本化模型的一步：
 * - 有 tool：调用一次工具；
 * - 有 final：给出最终回答。
 */
const scriptStepSchema = z.union([
  z.object({
    /** 要调用的工具名，必须是 harness 已注册的工具。 */
    tool: nonEmptyString,
    /** 工具参数；字符串里的占位符会在运行时替换。 */
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({
    /** 最终回答文本。 */
    final: nonEmptyString,
  }),
]);

const scriptStepsSchema = z.array(scriptStepSchema).min(1, "至少需要一步");

/** gold / broken 都必须以 final 结束，否则脚本化模型会一直重复最后一个工具。 */
const selfCheckSchema = z
  .object({
    /** 正确脚本：必须让所有 required 检查通过。 */
    gold: scriptStepsSchema,
    /** 错误脚本：至少要让一个 required 检查失败。 */
    broken: scriptStepsSchema,
  })
  .superRefine((value, ctx) => {
    for (const name of ["gold", "broken"] as const) {
      const steps = value[name];
      const last = steps[steps.length - 1];
      if (!("final" in last)) {
        ctx.addIssue({
          code: "custom",
          path: [name, steps.length - 1],
          message: "最后一步必须是 final，否则脚本化模型会重复工具调用",
        });
      }
    }
  });

export const taskDefinitionSchema = z
  .object({
    /** 必须和目录名、tasks/index.ts 里的键一致。 */
    id: nonEmptyString,
    /** 报告里显示的任务名。 */
    title: nonEmptyString,
    /** 单次试验的超时时间，单位毫秒。 */
    timeoutMs: z
      .number()
      .positive("必须是正数")
      .refine(Number.isFinite, "必须是有限数字"),
    /** agent 最多跑多少个模型回合。 */
    maxTurns: z.number().int("必须是整数").positive("必须是正数"),
    /** KeywordJudge 用的关键词；最终回答必须全部包含。 */
    expectKeywords: z.array(nonEmptyString).min(1, "不能为空"),
    /** LLMJudge 用的参考要点，每条是一个可核对的事实或要求。 */
    referencePoints: z.array(nonEmptyString).min(1, "不能为空"),
    /** 程序化检查；所有 required 检查通过，trial 才算通过。 */
    checks: z.array(checkSpecSchema).min(1, "至少需要一个检查"),
    /** gold（正确脚本）和 broken（错误脚本），用于 eval:check。 */
    selfCheck: selfCheckSchema,
  })
  .superRefine((task, ctx) => {
    const seen = new Set<string>();
    task.checks.forEach((check, index) => {
      if (seen.has(check.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["checks", index, "id"],
          message: `检查 id 重复: ${check.id}`,
        });
      }
      seen.add(check.id);
    });
  });

/** 字段说明见 taskDefinitionSchema；运行时校验由 validateTaskDefinition 完成。 */
export type TaskDefinition = z.infer<typeof taskDefinitionSchema>;
export type CheckSpec = z.infer<typeof checkSpecSchema>;
export type ScriptStep = z.infer<typeof scriptStepSchema>;
export type TaskSelfCheck = z.infer<typeof selfCheckSchema>;
export type FileContentCheck = z.infer<typeof fileContentCheckSchema>;
export type FileMissingCheck = z.infer<typeof fileMissingCheckSchema>;
export type FileUnchangedCheck = z.infer<typeof fileUnchangedCheckSchema>;
export type CommandCheck = z.infer<typeof commandCheckSchema>;
export type FinalAnswerCheck = z.infer<typeof finalAnswerCheckSchema>;
export type ToolsUsedCheck = z.infer<typeof toolsUsedCheckSchema>;

/**
 * 任务定义入口。它本身不改数据，只负责让 TypeScript 在调用处检查字段类型；
 * 运行时校验由 loader 调用 validateTaskDefinition 完成。
 */
export function defineTask(definition: TaskDefinition): TaskDefinition {
  return definition;
}

/**
 * 校验任务定义并返回解析后的数据。
 *
 * 传入 expectedId 时顺便检查 task.ts 的 id 和目录名/登记键一致；
 * 校验失败时把所有问题一次性列出来，而不是只报第一个。
 */
export function validateTaskDefinition(
  definition: unknown,
  expectedId?: string,
): TaskDefinition {
  const result = taskDefinitionSchema.safeParse(definition);
  if (!result.success) {
    throw new Error(formatIssues(expectedId ?? "未知任务", result.error));
  }
  if (expectedId !== undefined && result.data.id !== expectedId) {
    throw new Error(`${expectedId}: task.ts 的 id 与目录名不一致`);
  }
  return result.data;
}

function formatIssues(taskId: string, error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(根)";
    return `- ${path}: ${issue.message}`;
  });
  return `任务 ${taskId} 定义有误:\n${lines.join("\n")}`;
}
