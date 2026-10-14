/**
 * 系统提示词基础片段
 *
 * 提供基础句所需的两部分信息：
 *   - 身份 + 工作目录（WORKDIR）
 *   - OS 条件环境说明（process.platform === "win32" 时给 Windows 措辞，否则给类 Unix 措辞）
 *
 * 各章在此基础句上追加自己的子句，避免逐章重复工作目录与环境措辞。
 */

/** 当前工作目录（模块加载时求值一次）。 */
export const WORKDIR: string = process.cwd();

/** 按运行平台给出的环境说明。 */
export const ENVIRONMENT_PROMPT: string =
  process.platform === "win32"
    ? "Windows：bash 工具通过 cmd.exe 运行，请使用 cmd.exe 语法而非 Unix Bash 或 PowerShell 语法，并优先使用专用文件工具进行文件操作"
    : "类 Unix 系统：bash 工具运行系统 shell";

/** 基础句：身份 + 工作目录 + 运行环境。 */
export function baseSystemPrompt(): string {
  return `你是一个编码助手，工作目录：${WORKDIR}。运行环境：${ENVIRONMENT_PROMPT}。`;
}

/** 基础句 + 各章节子句（空格分隔）；空子句自动忽略。 */
export function buildSystemPrompt(...clauses: string[]): string {
  return [baseSystemPrompt(), ...clauses.filter(Boolean)].join(" ");
}
