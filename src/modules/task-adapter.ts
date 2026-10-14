/**
 * 两套 TaskRecord 的互操作层。
 *
 * 工程层（src/modules/tasks.ts）：id 为数字、owner 用空串、持久化到磁盘文件。
 * 教学层（runtime/types.ts）：id 为字符串、owner 用 null、面向依赖图。
 *
 * 这里只做字段映射，不改动任一方的定义，保证 s12/s16/s20 章节与模块测试都不受影响。
 */

import type { TaskRecord as RuntimeTaskRecord } from "../../runtime/types.ts";
import type { TaskRecord as ModuleTaskRecord } from "./tasks.ts";

export function toRuntimeTask(task: ModuleTaskRecord): RuntimeTaskRecord {
  return {
    id: String(task.id),
    subject: task.subject,
    description: task.description,
    status: task.status,
    owner: task.owner === "" ? null : task.owner,
    blockedBy: task.blockedBy ?? [],
  };
}

export function fromRuntimeTask(task: RuntimeTaskRecord): ModuleTaskRecord {
  const now = new Date().toISOString();
  return {
    id: Number(task.id),
    subject: task.subject,
    description: task.description,
    status: task.status,
    owner: task.owner ?? "",
    worktree: "",
    createdAt: now,
    updatedAt: now,
    blockedBy: task.blockedBy,
  };
}
