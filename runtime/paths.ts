/**
 * 路径边界校验 —— 把模型给的相对路径解析到指定 base 之下。
 *
 * 这是词法校验，不解析符号链接：工作区里的符号链接仍可能指向外面，
 * 教学版接受这个边界；生产实现应在读取前再做 realpath 校验。
 */

import * as path from 'node:path';

/** 把 p 解析到 base 之下；越界（含 `..`、绝对路径、同前缀兄弟目录）即抛错。 */
export function resolveWithin(base: string, p: string): string {
  const baseResolved = path.resolve(base);
  const resolved = path.resolve(baseResolved, p);
  const rel = path.relative(baseResolved, resolved);

  // 不要只判断 startsWith('..')：`..foo` 是合法的普通文件名。
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`路径越界: ${p}`);
  }
  return resolved;
}
