/**
 * s20 的后台任务适配层。
 *
 * 注册表、状态、输出文件和 <task-notification> 格式都在 runtime/background.ts
 * （s13/s20 共用）。本章沿用“后台命令执行是模拟的”约定，但模拟执行也要产出
 * 结果、写 .task_outputs/bg_xxxx.log，并能标记 failed。
 */

import { BackgroundRegistry } from '../runtime/background.ts';
import { truncate } from '../runtime/text.ts';
import type { ToolUseBlock } from '../runtime/types.ts';
import { TASK_OUTPUTS_DIR } from '../runtime/workspace.ts';

const registry = new BackgroundRegistry({
  executor: async (block) =>
    `[simulated] ${block.name} ${truncate(JSON.stringify(block.input), 60)} 已完成`,
  outputDir: TASK_OUTPUTS_DIR,
  log: (event, bgId) => {
    if (event === 'start') {
      console.log(`  \x1b[36m[background] ${bgId} started\x1b[0m`);
    } else if (event === 'done') {
      console.log(`  \x1b[32m[background] ${bgId} done\x1b[0m`);
    } else {
      console.log(`  \x1b[31m[background] ${bgId} failed\x1b[0m`);
    }
  },
});

export function startBackground(block: ToolUseBlock): string {
  return registry.start(block);
}

export async function collectBackgroundResults(wait = false): Promise<string[]> {
  return registry.collect(wait);
}

export async function flushBackground(): Promise<void> {
  await registry.waitForAll();
}
