/** 日志预览用：超过 n 个字符时截断并在末尾加省略号。 */
export function truncate(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…` : text;
}
