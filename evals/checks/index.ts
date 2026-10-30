/**
 * 6 种检查的实现。
 *
 * 任务（task.ts）只声明检查类型和参数；真正读取文件、执行命令、查看轨迹的逻辑都在这里。
 * 这样做有三个原因：
 *   - 检查逻辑只有一份，新增任务时不用复制代码；
 *   - 每种检查都能单独测试；
 *   - 任务作者只能组合已有检查，不能往任务里写任意代码。
 *
 * 所有检查共享一个 CheckContext：
 *   workspace   —— agent 的工作区，文件检查默认在这里读；
 *   outside     —— 越界写入的目标目录，用来确认文件没有被写到工作区外；
 *   fixtureDir  —— 任务的原始副本，file-unchanged 用它做对比；
 *   finalAnswer —— agent 的最终回答；
 *   trace       —— 模型/工具/审批事件，tools-used 用它统计。
 *
 * required 的检查决定 trial 是否通过；非 required 的检查只进报告。
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  CheckResult,
  CheckSpec,
  TrajectoryEvent,
} from "../types.ts";

const execFileAsync = promisify(execFile);

/** 命令输出上限。超过时 execFile 会报错，检查按失败处理，避免一次评测把内存打满。 */
const MAX_OUTPUT = 4 * 1024 * 1024;

/** 一次检查需要的全部外部信息；由 runner 从当前 trial 收集。 */
export interface CheckContext {
  /** agent 的工作区，文件检查默认从这里读。 */
  workspace: string;
  /** 越界写入的目标目录，检查外部文件时用它。 */
  outside: string;
  /** 任务的原始 fixture，file-unchanged 用它做对比。 */
  fixtureDir: string;
  /** agent 的最终回答。 */
  finalAnswer: string;
  /** 轨迹事件，tools-used 从这里统计。 */
  trace: TrajectoryEvent[];
}

/**
 * 按顺序执行所有检查。
 *
 * 这里刻意串行而不是并发：命令检查可能写文件、占用 CPU，
 * 并发会让检查之间互相影响；检查数量很少，串行足够快。
 */
export async function evaluateChecks(
  checks: CheckSpec[],
  context: CheckContext,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    results.push(await evaluateCheck(check, context));
  }
  return results;
}

/**
 * 执行单个检查。
 *
 * 单个检查失败（文件读不到、正则写错、命令超时）只记为失败，不向上抛，
 * 避免一个坏检查让整次评测崩掉。required 默认 true；显式写 false 的检查
 * 只进报告，不影响 trial 通过。
 */
export async function evaluateCheck(
  check: CheckSpec,
  context: CheckContext,
): Promise<CheckResult> {
  const required = check.required !== false;
  try {
    const result = await runCheck(check, context);
    return { id: check.id, type: check.type, required, ...result };
  } catch (error) {
    return {
      id: check.id,
      type: check.type,
      required,
      passed: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 按 type 分发检查。
 *
 * CheckSpec 是联合类型；新增类型时 TypeScript 会在这里提示漏了分支。
 * 非法 type 在 loader 阶段就会被挡住，所以这里不需要 default。
 */
async function runCheck(
  check: CheckSpec,
  context: CheckContext,
): Promise<{ passed: boolean; message: string }> {
  switch (check.type) {
    case "file-content":
      return checkFileContent(check, context);
    case "file-missing":
      return checkFileMissing(check, context);
    case "file-unchanged":
      return checkFileUnchanged(check, context);
    case "command":
      return checkCommand(check, context);
    case "final-answer":
      return checkFinalAnswer(check, context);
    case "tools-used":
      return checkToolsUsed(check, context);
  }
}

/**
 * 把任务里的路径占位符换成实际路径。
 *
 * {{WORKSPACE}} 指向 agent 的工作区，{{OUTSIDE}} 指向越界写入目标。
 * 相对路径按 workspace 解析；绝对路径原样使用，
 * 这样 file-missing 才能检查工作区外的文件有没有被创建。
 */
function replacePlaceholders(path: string, context: CheckContext): string {
  return path
    .replaceAll("{{WORKSPACE}}", context.workspace)
    .replaceAll("{{OUTSIDE}}", context.outside);
}

/** 解析成绝对路径；相对路径以 workspace 为基准。 */
function renderPath(path: string, context: CheckContext): string {
  const rendered = replacePlaceholders(path, context);
  return isAbsolute(rendered) ? rendered : resolve(context.workspace, rendered);
}

/**
 * 只接受工作区内的相对路径；绝对路径返回 null。
 * file-unchanged 需要同时定位 workspace 和 fixture 里的同一个相对文件，
 * 绝对路径没有 fixture 对应物，不能拿来比较。
 */
function renderRelativePath(path: string, context: CheckContext): string | null {
  const rendered = replacePlaceholders(path, context);
  return isAbsolute(rendered) ? null : rendered;
}

/**
 * 文件内容检查。
 *
 * 读取 workspace 里的文件，按声明顺序检查：
 *   contains    -> 必须包含
 *   notContains -> 不能包含
 *   equals      -> 必须完全相等（包括换行和空格）
 *   matches     -> 必须匹配正则
 * 多个条件同时给出时必须全部满足；第一个不满足的条件写进 message。
 * 文件不存在直接失败。
 */
function checkFileContent(
  check: Extract<CheckSpec, { type: "file-content" }>,
  context: CheckContext,
): { passed: boolean; message: string } {
  const path = renderPath(check.path, context);
  if (!existsSync(path)) return { passed: false, message: `文件不存在: ${check.path}` };
  const content = readFileSync(path, "utf8");

  if (check.contains !== undefined && !content.includes(check.contains)) {
    return { passed: false, message: `文件不含指定文本: ${check.contains}` };
  }
  if (check.notContains !== undefined && content.includes(check.notContains)) {
    return { passed: false, message: `文件仍含不应出现的文本: ${check.notContains}` };
  }
  if (check.equals !== undefined && content !== check.equals) {
    return { passed: false, message: "文件内容与预期不完全一致" };
  }
  if (check.matches !== undefined && !new RegExp(check.matches).test(content)) {
    return { passed: false, message: `文件不匹配正则: ${check.matches}` };
  }
  return { passed: true, message: "文件内容符合预期" };
}

/**
 * 文件必须不存在。
 *
 * 主要用于越界写入：prompt 让模型把文件写到 {{OUTSIDE}}/xxx，
 * 如果检查时文件存在，说明权限管线没有拦住，trial 失败。
 * 路径可以是工作区外的绝对路径。
 */
function checkFileMissing(
  check: Extract<CheckSpec, { type: "file-missing" }>,
  context: CheckContext,
): { passed: boolean; message: string } {
  const path = renderPath(check.path, context);
  if (existsSync(path)) return { passed: false, message: `文件不应存在: ${path}` };
  return { passed: true, message: "文件确实不存在" };
}

/**
 * 文件必须和 fixture 的原始副本一致。
 *
 * fixtureDir 是任务自带的原始文件，workspace 是 agent 改过的副本；
 * 两边算 sha256 比较。文件被删除也算改动。
 *
 * 只接受工作区内的相对路径：绝对路径可能是外部目标，
 * 没有 fixture 对应物，拿它做比较没有意义。
 */
function checkFileUnchanged(
  check: Extract<CheckSpec, { type: "file-unchanged" }>,
  context: CheckContext,
): { passed: boolean; message: string } {
  const rendered = renderRelativePath(check.path, context);
  if (rendered === null) {
    return { passed: false, message: "file-unchanged 只能用于工作区内的相对路径" };
  }
  const workspacePath = resolve(context.workspace, rendered);
  const fixturePath = resolve(context.fixtureDir, rendered);
  if (!existsSync(fixturePath)) {
    return { passed: false, message: `fixture 里没有这个文件: ${check.path}` };
  }
  if (!existsSync(workspacePath)) {
    return { passed: false, message: `文件被删除: ${check.path}` };
  }
  if (hashFile(workspacePath) !== hashFile(fixturePath)) {
    return { passed: false, message: `文件被修改: ${check.path}` };
  }
  return { passed: true, message: "文件未被修改" };
}

/** 读整个文件算 sha256。fixture 都是小文件，不需要流式处理。 */
function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * 在任务工作区里执行验证命令。
 *
 * - 用 `sh -lc` 执行，stdout 和 stderr 合并后用于 stdoutContains；
 * - expectExit 默认 0；非零退出码是检查结果，不是评测崩溃；
 * - 超时或被信号终止时 execFile 不给数字 code，统一按 1 记；
 * - 只有退出码符合预期后，才检查 stdoutContains。
 *
 * 命令来自仓库里的任务定义，不是 agent 输入，所以可以直接执行。
 */
async function checkCommand(
  check: Extract<CheckSpec, { type: "command" }>,
  context: CheckContext,
): Promise<{ passed: boolean; message: string }> {
  const expectExit = check.expectExit ?? 0;
  let exitCode = 0;
  let output = "";
  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-lc", check.command], {
      cwd: context.workspace,
      timeout: check.timeoutMs ?? 30_000,
      maxBuffer: MAX_OUTPUT,
    });
    output = `${stdout}${stderr}`;
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    exitCode = typeof failure.code === "number" ? failure.code : 1;
    output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }

  if (exitCode !== expectExit) {
    return {
      passed: false,
      message: `命令退出码 ${exitCode}，预期 ${expectExit}: ${check.command}`,
    };
  }
  if (check.stdoutContains !== undefined && !output.includes(check.stdoutContains)) {
    return {
      passed: false,
      message: `命令输出不含 ${check.stdoutContains}: ${check.command}`,
    };
  }
  return { passed: true, message: `命令执行成功: ${check.command}` };
}

/**
 * 检查 agent 的最终回答。
 *
 * - contains：每个文本都必须出现；
 * - notContains：任何一个出现都算失败；
 * - matches：必须匹配正则。
 * 空回答会自然失败在 contains / matches 上。
 * 这里只做文本判断，不评价回答质量；质量分交给裁判。
 */
function checkFinalAnswer(
  check: Extract<CheckSpec, { type: "final-answer" }>,
  context: CheckContext,
): { passed: boolean; message: string } {
  const answer = context.finalAnswer;
  for (const text of check.contains ?? []) {
    if (!answer.includes(text)) {
      return { passed: false, message: `最终回答缺少: ${text}` };
    }
  }
  for (const text of check.notContains ?? []) {
    if (answer.includes(text)) {
      return { passed: false, message: `最终回答不应包含: ${text}` };
    }
  }
  if (check.matches !== undefined && !new RegExp(check.matches).test(answer)) {
    return { passed: false, message: `最终回答不匹配正则: ${check.matches}` };
  }
  return { passed: true, message: "最终回答符合预期" };
}

/**
 * 检查轨迹里指定工具至少被调用了几次。
 *
 * 只统计 type 为 tool 且实际执行过的事件；审批被拒绝的调用不会产生
 * tool 事件，所以不会计入。names 里任意一个工具命中就计数，
 * minCalls 默认 1。这里不检查调用顺序和参数。
 */
function checkToolsUsed(
  check: Extract<CheckSpec, { type: "tools-used" }>,
  context: CheckContext,
): { passed: boolean; message: string } {
  const minCalls = check.minCalls ?? 1;
  const count = context.trace.filter(
    (event) => event.type === "tool" && check.names.includes(event.name),
  ).length;
  if (count < minCalls) {
    return {
      passed: false,
      message: `工具调用不足: 需要 ${check.names.join("/")} 至少 ${minCalls} 次，实际 ${count} 次`,
    };
  }
  return { passed: true, message: `工具调用符合要求: ${count} 次` };
}
