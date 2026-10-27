/**
 * s20 的 git 执行器与 worktree 管理器实例。
 * worktree 的创建/删除/保留逻辑在 worktree.ts，这里只负责真实调用 git 和事件日志。
 */

import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import {
  WORKSPACE_ROOT,
  WORKTREE_EVENTS_PATH,
  WORKTREES_DIR,
} from '../runtime/workspace.ts';
import { createWorktreeManager } from './worktree.ts';

export function runGit(args: string[], cwd: string = WORKSPACE_ROOT): { ok: boolean; out: string } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, out };
}

export function ensureGitRepo(): void {
  const inside = runGit(['rev-parse', '--is-inside-work-tree']);
  if (inside.ok && inside.out.includes('true')) return;
  runGit(['init']);
  runGit([
    '-c',
    'user.email=agent@example.com',
    '-c',
    'user.name=Agent',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-m',
    'init',
  ]);
}

export function logWorktreeEvent(eventType: string, name: string, taskId = ''): void {
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  fs.appendFileSync(
    WORKTREE_EVENTS_PATH,
    // 字段名与 s18 的读取方对齐：task_id / ts（秒），两章写的是同一个 .worktrees/events.jsonl
    JSON.stringify({ type: eventType, worktree: name, task_id: taskId, ts: Date.now() / 1000 }) + '\n',
    'utf8',
  );
}

export const worktrees = createWorktreeManager({
  worktreesDir: WORKTREES_DIR,
  runGit,
  logEvent: logWorktreeEvent,
  ensureGitRepo,
});
