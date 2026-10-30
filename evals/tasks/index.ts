/**
 * 任务列表是显式的：每个任务用 task.ts 导出定义，在这里登记。
 * 不扫目录，新增任务时漏登记会在启动时直接报错。
 */

import type { TaskDefinition } from "../types.ts";
import denyOutsideWrite from "./deny-outside-write/task.ts";
import fixSingleFile from "./fix-single-file/task.ts";
import readFileAnswer from "./read-file-answer/task.ts";

export const TASK_MODULES = {
  "read-file-answer": readFileAnswer,
  "fix-single-file": fixSingleFile,
  "deny-outside-write": denyOutsideWrite,
} satisfies Record<string, TaskDefinition>;

export type TaskId = keyof typeof TASK_MODULES;

export const TASK_IDS = Object.keys(TASK_MODULES) as TaskId[];
