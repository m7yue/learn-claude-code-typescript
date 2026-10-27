/**
 * s20 worktree 管理 —— 真实 git worktree 的创建、删除、保留与清理。
 *
 * 状态由 manager 实例持有，便于测试；agent.ts 只注入 git 执行器、事件日志和仓库初始化。
 * 这里多做一层路径校验：worktree 是模型可以命名的资源，名字会被拼进文件路径，
 * 不能允许 `.`/`..` 或任何能把删除操作带出 worktreesDir 的输入。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GitResult {
  ok: boolean;
  out: string;
}

export interface WorktreeManagerOptions {
  worktreesDir: string;
  runGit: (args: string[], cwd?: string) => GitResult;
  logEvent: (type: 'create' | 'bind' | 'remove' | 'keep', name: string, taskId?: string) => void;
  ensureGitRepo: () => void;
}

export interface WorktreeCreateResult {
  ok: boolean;
  worktreeId: string;
  path?: string;
  reason?: string;
}

export interface WorktreeRemoveResult {
  removed: boolean;
  reason?: string;
}

export interface WorktreeKeepResult {
  kept: boolean;
  reason?: string;
}

const VALID_WT_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** 返回错误信息表示非法，返回 null 表示合法。 */
export function validateWorktreeName(name: string): string | null {
  if (!name) return 'worktree name 不能为空';
  if (name === '.' || name === '..') return `'${name}' 不是合法的 worktree 名`;
  if (!VALID_WT_NAME.test(name)) return `invalid worktree name: ${JSON.stringify(name)}`;
  return null;
}

/**
 * 把 worktree 名解析到 worktreesDir 之下；越界即抛错。
 *
 * 注意不能只判断 startsWith('..')：合法的文件名可以以 `..` 开头（例如 `..foo`），
 * 必须按路径分隔符判断“上一级目录”。
 */
export function resolveWorktreePath(worktreesDir: string, name: string): string {
  const base = path.resolve(worktreesDir);
  const resolved = path.resolve(base, name);
  const rel = path.relative(base, resolved);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`worktree path escapes ${base}: ${JSON.stringify(name)}`);
  }
  return resolved;
}

/** 只接受 worktreesDir 的严格子路径；base 本身和祖先都不算。 */
function isStrictChild(base: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(candidate));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWorktreeManager(options: WorktreeManagerOptions) {
  const { worktreesDir, runGit, logEvent, ensureGitRepo } = options;
  const base = path.resolve(worktreesDir);
  const worktreePaths = new Map<string, string>();
  const keptWorktrees = new Set<string>();

  /** 统计未提交文件数与未合并 commit 数；git 状态读不到时返回 ok=false。 */
  function countChanges(wtPath: string, name: string): { files: number; commits: number; ok: boolean } {
    const status = runGit(['-C', wtPath, 'status', '--porcelain']);
    if (!status.ok) return { files: -1, commits: -1, ok: false };
    const files = status.out ? status.out.split('\n').filter((line) => line.trim()).length : 0;
    // worktree 里的提交如果还没合回主分支，也不能被 remove 静默丢掉。
    const ahead = runGit(['rev-list', '--count', `HEAD..wt/${name}`]);
    const commits = ahead.ok ? Number(ahead.out.trim()) || 0 : 0;
    return { files, commits, ok: true };
  }

  function create(name: string, taskId = ''): WorktreeCreateResult {
    const bad = validateWorktreeName(name);
    if (bad) return { ok: false, worktreeId: name, reason: bad };

    let wtPath: string;
    try {
      wtPath = resolveWorktreePath(base, name);
    } catch (error) {
      return { ok: false, worktreeId: name, reason: errorMessage(error) };
    }

    ensureGitRepo();
    // 可以重复执行：先清掉同名残留，避免上次异常中断导致这次 add 失败。
    if (fs.existsSync(wtPath)) {
      runGit(['worktree', 'remove', '--force', wtPath]);
      if (fs.existsSync(wtPath) && isStrictChild(base, wtPath)) {
        fs.rmSync(wtPath, { recursive: true, force: true });
      }
    }
    runGit(['branch', '-D', `wt/${name}`]);

    // git worktree add 不会创建缺失的父目录；干净工作区第一次创建时必须先建。
    fs.mkdirSync(base, { recursive: true });
    const result = runGit(['worktree', 'add', wtPath, '-b', `wt/${name}`, 'HEAD']);
    if (!result.ok) {
      return { ok: false, worktreeId: name, reason: `git worktree add failed: ${result.out}` };
    }

    worktreePaths.set(name, wtPath);
    keptWorktrees.delete(name);
    logEvent('create', name, taskId);
    return { ok: true, worktreeId: name, path: wtPath };
  }

  function remove(name: string, discardChanges = false): WorktreeRemoveResult {
    const bad = validateWorktreeName(name);
    if (bad) return { removed: false, reason: bad };

    let wtPath: string;
    try {
      wtPath = worktreePaths.get(name) ?? resolveWorktreePath(base, name);
    } catch (error) {
      return { removed: false, reason: errorMessage(error) };
    }

    if (!fs.existsSync(wtPath)) {
      worktreePaths.delete(name);
      keptWorktrees.delete(name);
      return { removed: false, reason: `worktree '${name}' not found` };
    }

    if (!discardChanges) {
      const { files, commits, ok } = countChanges(wtPath, name);
      if (!ok) {
        return {
          removed: false,
          reason: `cannot verify worktree '${name}' status; use discard_changes=true to force removal`,
        };
      }
      if (files > 0 || commits > 0) {
        return {
          removed: false,
          reason:
            `worktree '${name}' has ${files} uncommitted change(s) and ${commits} unmerged commit(s); ` +
            `use discard_changes=true or keep_worktree`,
        };
      }
    }

    const result = runGit(['worktree', 'remove', '--force', wtPath]);
    if (!result.ok) {
      // 兜底删除只对 worktreesDir 的严格子目录生效；绝不删除 base 本身或祖先。
      if (isStrictChild(base, wtPath) && fs.existsSync(wtPath)) {
        fs.rmSync(wtPath, { recursive: true, force: true });
      } else {
        return { removed: false, reason: `failed to remove worktree '${name}': ${result.out}` };
      }
    } else if (fs.existsSync(wtPath) && isStrictChild(base, wtPath)) {
      // git 认为删掉了但目录还在（例如从未注册的残留）时，只清严格子目录。
      fs.rmSync(wtPath, { recursive: true, force: true });
    }

    runGit(['branch', '-D', `wt/${name}`]);
    worktreePaths.delete(name);
    keptWorktrees.delete(name);
    logEvent('remove', name);
    return { removed: true };
  }

  function keep(name: string): WorktreeKeepResult {
    const bad = validateWorktreeName(name);
    if (bad) return { kept: false, reason: bad };

    let wtPath: string;
    try {
      wtPath = resolveWorktreePath(base, name);
    } catch (error) {
      return { kept: false, reason: errorMessage(error) };
    }

    if (!worktreePaths.has(name) && !fs.existsSync(wtPath)) {
      return { kept: false, reason: `worktree '${name}' not found` };
    }

    keptWorktrees.add(name);
    logEvent('keep', name);
    return { kept: true, reason: `worktree '${name}' preserved for manual review` };
  }

  /** 收尾清理：跳过明确要求保留的 worktree。 */
  function cleanup(): void {
    for (const name of [...worktreePaths.keys()]) {
      if (keptWorktrees.has(name)) continue;
      remove(name, true);
    }
    runGit(['worktree', 'prune']);
    worktreePaths.clear();
  }

  return {
    create,
    remove,
    keep,
    cleanup,
    getPath: (name: string): string | undefined => worktreePaths.get(name),
    paths: (): string[] => [...worktreePaths.keys()],
  };
}
