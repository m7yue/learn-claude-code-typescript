/**
 * 加载任务：校验定义、补齐 prompt 正文和 fixture 路径。
 *
 * 数据校验在 task-definition.ts 里完成；这里只关心任务在磁盘上的位置。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateTaskDefinition } from "./task-definition.ts";
import { TASK_IDS, TASK_MODULES, type TaskId } from "./tasks/index.ts";
import type { EvalTask } from "./types.ts";

const EVALS_ROOT = dirname(fileURLToPath(import.meta.url));
const KNOWN_IDS = new Set<string>(TASK_IDS);

export function loadTasks(ids?: string[]): EvalTask[] {
  return (ids && ids.length > 0 ? ids : [...TASK_IDS]).map((id) => loadTask(id));
}

export function loadTask(id: string): EvalTask {
  if (!KNOWN_IDS.has(id)) {
    throw new Error(`未知任务: ${id}（已登记: ${[...TASK_IDS].join(", ")}）`);
  }

  const definition = TASK_MODULES[id as TaskId];
  const task = validateTaskDefinition(definition, id);

  const dir = join(EVALS_ROOT, "tasks", id);
  // prompt.md 和 fixture/ 是任务目录的固定文件名，不在 task.ts 里重复写。
  const promptTemplate = readFileSync(join(dir, "prompt.md"), "utf8");
  const fixtureDir = join(dir, "fixture");
  if (!existsSync(fixtureDir)) {
    throw new Error(`${id} 缺少 fixture 目录: ${fixtureDir}`);
  }

  return { ...task, promptTemplate, fixtureDir };
}
