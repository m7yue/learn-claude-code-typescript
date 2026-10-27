/** s20 的小工具函数。 */

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 落盘文件名由工具调用 id / 记忆键名拼成，先净化。 */
export const sanitizeFilePart = (value: string): string =>
  value.replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';

/**
 * 按字面替换第一处文本。
 *
 * 不能用 `content.replace(oldText, newText)`：字符串形式的 newText 会把
 * `$&`、`$'`、`` $` `` 当成替换模式解释，编辑 shell 脚本时会写坏内容。
 */
export function replaceFirstLiteral(content: string, oldText: string, newText: string): string {
  return content.replace(oldText, () => newText);
}

/**
 * 格式化前台命令的执行结果；非零退出码抛出带输出的错误，交给外层标 is_error。
 * 这样模型既能看到 stdout/stderr，也能从协议层知道命令失败了。
 */
export function commandOutput(
  status: number | null,
  signal: NodeJS.Signals | null,
  stdout: string,
  stderr: string,
): string {
  // s20 要演示 L3 落盘（最后一条消息的工具结果总量 >200KB），
  // 因此这里放宽到 1MB；s08 的 BashExec 也是同样的上限。
  const out = `${stdout}${stderr}`.slice(0, 1_000_000);
  if (status !== 0) {
    const why = status === null ? signal ?? 'unknown signal' : `exit ${status}`;
    throw new Error(`command failed (${why})${out ? `\n${out}` : ''}`);
  }
  return out || '(no output)';
}
