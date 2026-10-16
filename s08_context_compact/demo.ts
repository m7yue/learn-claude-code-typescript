/**
 * s08 的演示素材与剧本 —— 脚手架，不是本章要教的机制。机制在 agent.ts。
 *
 * 素材建在 s08_context_compact/.output/demo/（已被 gitignore，每次启动重建）。它同时
 * 是模型的工作目录：agent.ts 里 bash 的 cwd 与系统提示词里告知的目录都指向 DEMO_ABS。
 *
 * 各文件的大小与顺序不是随手定的，相互之间有约束：
 *   - notes/ 要 26 份、每份约 2.5KB —— 这两个数字分别对着真实模型的两种自然行为：
 *     逐条读时，要靠 26 轮才攒够 L1 的 52 条消息（snipCompact 的「头 3 + 尾 47」在
 *     第 51 条消息时正好重叠，配对保护会让它什么都不做，所以要到第 27 轮才真动手）；
 *     一把 `cat notes/*` 读完时，26 × 2.5KB ≈ 65KB，会顶破 CONTEXT_LIMIT 触发 L4。
 *     每份还必须超过 120 字符，否则 L2 只会输出「压缩 0 个旧工具结果」；
 *   - bulk.log 必须排在笔记之后 —— 笔记本身若顶破 CONTEXT_LIMIT，L4 会在第 4 轮就把
 *     历史收成摘要，消息数再也攒不到 L1 的阈值。这是整套素材里唯一一处「顺序错了就
 *     演示不全」的地方；
 *   - large.log 的单块要超过 MAX_BYTES，L3 才落盘。
 *
 * 四层因此分散在各自该触发的轮次：L2 第 5 轮起、L1 第 27–29 轮、L4 第 29 轮、L3 第 30 轮。
 */

import type { LLMResponse } from '../runtime/types.ts';
import { WORKSPACE_ROOT } from '../runtime/workspace.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const DEMO_DIR = 's08_context_compact/.output/demo';
export const DEMO_ABS = path.resolve(WORKSPACE_ROOT, DEMO_DIR);

const DEMO_TASK_FILE = 'TASK.md';
const DEMO_NOTE_DIR = 'notes';
const DEMO_NOTE_COUNT = 26;
const DEMO_NOTE_BYTES = 2_500;
const DEMO_BULK_FILE = 'bulk.log';
const DEMO_BULK_BYTES = 90_000;
const DEMO_BIG_FILE = 'large.log';
const DEMO_BIG_BYTES = 220_000;

const DEMO_TASK_BODY = `# 演示任务

本目录是一段模拟的日志现场。请：
1. 读 notes/ 下的笔记，了解现场；
2. 统计 large.log 里 status=500 的行数；
3. 用一句话给出结论。

只处理当前目录里的文件。
`;

const noteName = (i: number): string => `${DEMO_NOTE_DIR}/note-${String(i).padStart(2, '0')}.md`;

/** 反复调用 makeLine 攒出约 targetBytes 字符的文本；head 计入总长度。 */
function buildDemoText(targetBytes: number, makeLine: (i: number) => string, head = ''): string {
  const parts: string[] = head ? [head] : [];
  let size = head.length;
  for (let i = 0; size < targetBytes; i += 1) {
    const line = makeLine(i);
    parts.push(line);
    size += line.length;
  }
  return parts.join('');
}

// 每 200 行掺一条 500，让 TASK.md 里「统计 status=500 的行数」有个真实答案
const buildDemoLog = (targetBytes: number): string =>
  buildDemoText(
    targetBytes,
    (i) =>
      `2026-01-01 00:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')} INFO request #${i} path=/api/v1/items status=${i % 200 === 0 ? 500 : 200} duration=${(i % 47) + 3}ms\n`,
  );

const buildDemoNote = (index: number): string =>
  buildDemoText(
    DEMO_NOTE_BYTES,
    (i) => {
      const line = i + 1;
      return `- 第 ${line} 条观察：采集链路正常，队列无堆积，响应时间稳定在 ${(line % 40) + 5}ms。\n`;
    },
    `# 演示笔记 ${String(index).padStart(2, '0')}\n\n`,
  );

/** 重建整个演示沙箱；返回文件数与字符总数，供启动日志使用。 */
export function buildDemoSandbox(): { files: number; bytes: number } {
  fs.rmSync(DEMO_ABS, { recursive: true, force: true });
  fs.mkdirSync(path.join(DEMO_ABS, DEMO_NOTE_DIR), { recursive: true });

  const files: Array<[string, string]> = [
    [DEMO_TASK_FILE, DEMO_TASK_BODY],
    ...Array.from(
      { length: DEMO_NOTE_COUNT },
      (_, i): [string, string] => [noteName(i + 1), buildDemoNote(i + 1)],
    ),
    [DEMO_BULK_FILE, buildDemoLog(DEMO_BULK_BYTES)],
    [DEMO_BIG_FILE, buildDemoLog(DEMO_BIG_BYTES)],
  ];
  for (const [rel, body] of files) fs.writeFileSync(path.join(DEMO_ABS, rel), body, 'utf8');

  return { files: files.length, bytes: files.reduce((sum, [, body]) => sum + body.length, 0) };
}

// 演示剧本：前 27 轮读小文件（撑 L2 与 L1），再读 bulk.log（撑 L4），最后读 large.log（撑 L3）
const DEMO_COMMANDS: string[] = [
  `cat ${DEMO_TASK_FILE}`,
  ...Array.from({ length: DEMO_NOTE_COUNT }, (_, i) => `cat ${noteName(i + 1)}`),
  `cat ${DEMO_BULK_FILE}`,
  `cat ${DEMO_BIG_FILE}`,
];

let mockTurn = 0;

/** 脚本化的「模型」：逐轮发出 DEMO_COMMANDS 里的命令，跑完主动压缩一次，再收尾。 */
export function mockLLM(): LLMResponse {
  const turn = mockTurn;
  mockTurn += 1;

  const command = DEMO_COMMANDS[turn];
  if (command) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: `第 ${turn + 1} 轮：${command}` },
        { type: 'tool_use', id: `demo_${turn + 1}`, name: 'bash', input: { command } },
      ],
    };
  }
  // 命令跑完 → 主动压缩一次（手动路径）→ 结束
  if (turn === DEMO_COMMANDS.length) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '上下文有点长了，主动压缩一下。' },
        { type: 'tool_use', id: 'compact_001', name: 'compact', input: { reason: '上下文过长' } },
      ],
    };
  }
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '任务完成，上下文已通过多层策略管理。' }],
  };
}
