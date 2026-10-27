/**
 * s20 的任务存储 —— 每个任务一个 `.tasks/<id>.json`，带 blockedBy 依赖图。
 * 逻辑与 s12/s17 同源，本章额外带一个 worktree 字段。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveWithin } from '../runtime/paths.ts';
import type { TaskRecord } from '../runtime/types.ts';
import { TASKS_DIR } from '../runtime/workspace.ts';

export interface WorktreeTask extends TaskRecord {
  worktree: string | null;
  /** 预订的 owner；有值时只有该 agent 能认领（用于演示自主认领不抢 lead 的任务）。 */
  preferredOwner?: string | null;
}

export interface ClaimResult {
  ok: boolean;
  task?: TaskRecord;
  error?: string;
}

export interface CompleteResult {
  ok: boolean;
  task?: TaskRecord;
  unblocked: string[];
  error?: string;
}

function ensureTasksDir(): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
}

/**
 * 任务 ID 由 createTask 生成，格式固定；模型传入的 id 必须先过白名单，
 * 避免 `../../x` 之类的路径穿越。
 */
export function validateTaskId(id: string): boolean {
  return /^task_[A-Za-z0-9_]+$/.test(id);
}

function taskPath(id: string): string {
  if (!validateTaskId(id)) throw new Error(`非法任务 ID: ${JSON.stringify(id)}`);
  return resolveWithin(TASKS_DIR, `${id}.json`);
}

// 同一毫秒内创建多个任务时，用自增序号保证 listTasksOrdered 的排序稳定
// （自动认领依赖“先创建的任务排在前面”来选中演示任务）。
let taskSeq = 0;
function newTaskId(): string {
  taskSeq += 1;
  return `task_${Date.now()}_${String(taskSeq).padStart(6, '0')}`;
}

function saveTask(task: WorktreeTask): void {
  ensureTasksDir();
  fs.writeFileSync(taskPath(task.id), JSON.stringify(task, null, 2), 'utf8');
}

/** 任务文件必须至少有 id/subject/blockedBy；缺字段的 JSON 也按损坏处理。 */
function isTaskRecord(value: unknown): value is WorktreeTask {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<WorktreeTask>;
  return (
    typeof task.id === 'string' &&
    typeof task.subject === 'string' &&
    Array.isArray(task.blockedBy)
  );
}

export function loadTask(id: string): WorktreeTask | null {
  try {
    const p = taskPath(id);
    if (!fs.existsSync(p)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(p, 'utf8'));
    return isTaskRecord(parsed) ? parsed : null;
  } catch {
    // 非法 id / 损坏 JSON：调用方按“任务不存在”处理，不要抛到主循环。
    return null;
  }
}

export function listTasksOrdered(): WorktreeTask[] {
  ensureTasksDir();
  const tasks: WorktreeTask[] = [];
  for (const f of fs.readdirSync(TASKS_DIR).sort()) {
    if (!/^task_.*\.json$/.test(f)) continue;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8'));
      if (!isTaskRecord(parsed)) {
        console.warn(`[tasks] 跳过字段不完整的任务文件: ${f}`);
        continue;
      }
      tasks.push(parsed);
    } catch {
      console.warn(`[tasks] 跳过损坏的任务文件: ${f}`);
    }
  }
  return tasks;
}

export function blockingDeps(task: WorktreeTask): string[] {
  return (task.blockedBy || []).filter((id) => {
    const dep = loadTask(id);
    // 缺失的依赖和未完成的依赖一样算阻塞：写错 id 时不能让任务被放行。
    return dep === null || dep.status !== 'completed';
  });
}

export function canStart(id: string): boolean {
  const task = loadTask(id);
  if (!task) return false;
  return blockingDeps(task).length === 0;
}

export function createTask(
  subject: string,
  description: string,
  blockedBy: string[],
  preferredOwner?: string,
): WorktreeTask {
  const task: WorktreeTask = {
    id: newTaskId(),
    subject,
    description,
    status: 'pending',
    owner: null,
    blockedBy,
    worktree: null,
    preferredOwner: preferredOwner ?? null,
  };
  saveTask(task);
  return task;
}

export function claimTask(id: string, owner: string): ClaimResult {
  const task = loadTask(id);
  if (!task) return { ok: false, error: `task ${id} not found` };
  if (task.preferredOwner && task.preferredOwner !== owner) {
    return { ok: false, error: `task ${id} is reserved for ${task.preferredOwner}` };
  }
  if (task.status !== 'pending' || task.owner) {
    return { ok: false, error: `task ${id} not claimable (status=${task.status}, owner=${task.owner ?? '-'})` };
  }
  const blockers = blockingDeps(task);
  if (blockers.length > 0) return { ok: false, error: `task ${id} blocked by ${blockers.join(', ')}` };
  task.status = 'in_progress';
  task.owner = owner;
  saveTask(task);
  return { ok: true, task };
}

export function completeTask(id: string, owner: string): CompleteResult {
  const task = loadTask(id);
  if (!task) return { ok: false, unblocked: [], error: `task ${id} not found` };
  if (task.status !== 'in_progress') return { ok: false, unblocked: [], error: `task ${id} not in progress` };
  if (!task.owner || task.owner !== owner) {
    return { ok: false, unblocked: [], error: `task ${id} owned by ${task.owner ?? '(none)'}, not ${owner}` };
  }
  task.status = 'completed';
  saveTask(task);
  const unblocked = listTasksOrdered()
    .filter((t) => t.status === 'pending' && t.blockedBy.includes(id) && canStart(t.id))
    .map((t) => t.id);
  return { ok: true, task, unblocked };
}

/** 把任务绑定到 worktree；任务不存在时返回错误，由调用方转成工具错误。 */
export function bindTaskToWorktree(taskId: string, name: string): { ok: boolean; reason?: string } {
  const task = loadTask(taskId);
  if (!task) return { ok: false, reason: `task ${taskId} not found` };
  task.worktree = name;
  saveTask(task);
  return { ok: true };
}

/** worktree 被删除后清掉任务上的绑定，避免 list_tasks 指向不存在的目录。 */
export function unbindTasksFromWorktree(name: string): void {
  for (const task of listTasksOrdered()) {
    if (task.worktree === name) {
      task.worktree = null;
      saveTask(task);
    }
  }
}

export function formatTaskList(
  tasks: (TaskRecord & { worktree?: string | null; preferredOwner?: string | null })[],
): string {
  if (tasks.length === 0) return 'No tasks.';
  return tasks
    .map((t) => {
      const mark = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : '○';
      const blockedBy = t.blockedBy.length > 0 ? ` (blockedBy: ${t.blockedBy.join(', ')})` : '';
      const owner = t.owner ? ` owner=${t.owner}` : '';
      const reserved = t.preferredOwner ? ` reserved=${t.preferredOwner}` : '';
      const wt = t.worktree ? ` wt=${t.worktree}` : '';
      return `  ${mark} ${t.id}: ${t.subject} [${t.status}]${blockedBy}${owner}${reserved}${wt}`;
    })
    .join('\n');
}
