# s18: Git Worktree Isolation — Worktree 是代码变更的隔离环境

[s17](../s17_autonomous_agents/) → [s18] → [s19](../s19_mcp_plugin/)

---

## 第一性原理

**问题的本质**：并行开发多个功能时，代码变更会相互干扰。A 功能修改了 `auth.ts`，B 功能也要修改 `auth.ts`，怎么避免冲突？

Git Worktree 提供了文件系统层面的隔离——每个功能在独立目录中工作，互不干扰，最终通过 merge 合并。

这和 s06 的 Delegate（消息隔离）、s08 的 Compact（上下文隔离）是同一个原理：**隔离 = 效应作用域的边界**。

---

## 问题

```bash
# 没有 worktree 时，并行开发很危险
git checkout feature-a
# 修改 auth.ts
git checkout feature-b  # 必须 commit 或 stash，否则会丢失变更
# 修改 auth.ts  ← 文件系统层面的冲突
```

---

## 代数效应视角

三个 Effect 管理 Worktree 的生命周期（本章在 s12 任务系统之上扩展）：

```typescript
// 创建独立工作树（真实执行 git worktree add）
const wt = yield* perform({
  type: 'CreateWorktree',
  input: { name: 'auth' }
});
// → git worktree add <workspace>/.worktrees/auth -b wt/auth HEAD
// wt.message → "Worktree 'auth' created at <path>"

// 将任务绑定到工作树（真实写入 .tasks/*.json 的 worktree 字段）
yield* perform({
  type: 'BindWorktree',
  input: { name: 'auth', taskId: 'task_...' }
});

// 在工作树目录中执行操作（cwd 注入路径，隔离命令作用域）
yield* perform({
  type: 'BashExec',
  input: { command: 'echo "auth refactor" > auth.patch', cwd: wt.path }
});

// 清理工作树（真实执行 git worktree remove --force + git branch -D）
yield* perform({ type: 'RemoveWorktree', input: { name: 'auth' } });
```

**关键洞见**：隔离通过 `cwd` 注入实现。`BindWorktree` 关联任务 ID 和文件系统路径，Generator 在执行 BashExec 时查询该映射，自动路由到正确的隔离目录。

| 真实 git 命令 | 代数效应 TypeScript |
|--------------|-------------------|
| `git worktree add <path> -b wt/<name> HEAD` | `CreateWorktree` Effect |
| `git worktree remove <path> --force` + `git branch -D wt/<name>` | `RemoveWorktree` Effect |
| 在 worktree 目录中执行命令（`cwd` 注入） | `BashExec` + `cwd` 参数注入 |
| 写 `.tasks/<id>.json` 的 `worktree` 字段 | `BindWorktree` Effect |

> 这里**没有 mkdir + 标记文件**：git 命令全部真实执行，
> mock 只替代「模型调用」这一件事。

---

## 工作原理

### 真实 git worktree 生命周期

```
<workspace>/                         ← WORKSPACE_ROOT（git 仓库）
  .git/
  .worktrees/
    auth/                            ← git worktree 工作目录（branch: wt/auth）
      .git                           ← 指向主仓库的 git 文件（git 自动生成）
      auth.patch                     ← 在此目录的变更不影响 ui/
    events.jsonl                     ← 所有 worktree 操作的审计日志
  .tasks/
    task_xxx.json                    ← 含 worktree: "auth" 字段
```

创建：

```typescript
// validateWorktreeName → 只允许 [A-Za-z0-9._-]{1,64}
const res = runGit(['worktree', 'add', wtPath, '-b', `wt/${name}`, 'HEAD']);
// wtPath = path.join(WORKTREES_DIR, name) = <workspace>/.worktrees/<name>
```

移除（先过变更守卫，再强制删除并删分支）：

```typescript
// 不丢弃变更时，先统计未提交文件 / 本地提交
const res = runGit(['worktree', 'remove', wtPath, '--force']);
runGit(['branch', '-D', `wt/${name}`]);
```

### 变更守卫：`_count_worktree_changes`

移除前先统计，防止误删未保存的工作：

```typescript
const files = git status --porcelain 的行数;
const commits = git rev-list --count HEAD --not <base-sha>;  // base = 主工作区 HEAD
if (files > 0 || commits > 0)
  return `... has ${files} uncommitted file(s) and ${commits} unpushed commit(s).
          Use discard_changes=true to force removal.`;
```

只有 `discard_changes=true` 时才跳过守卫。这正是 git 自身 `worktree remove`（无 `--force`）
会因 untracked/modified 文件报错的行为，在 Agent 层提前以可读信息暴露。

### `run_git`：真实执行且永不抛异常

```typescript
function runGit(args: string[], cwd = WORKSPACE_ROOT): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}
```

失败返回 `ok=false` + 错误串，由调用方转成 `Git error: ...`。

### 环境自适应：workspace 可能不是 git 仓库

e2e 会用全新临时目录作为 `AGENT_WORKSPACE`（cwd 仍是仓库根）。启动时：

```typescript
ensureGitRepo();
// 1. git rev-parse --git-dir 失败 → git init
// 2. git -c user.email=... -c user.name=... commit --allow-empty
//    （worktree add -b ... HEAD 需要至少一个 commit 作为基准）
```

所有 git 命令一律以 `WORKSPACE_ROOT`（来自 `runtime/workspace.ts`）为仓库，而不是 `process.cwd()`。

### events.jsonl：Worktree 操作审计日志

每次 worktree 操作都追加一行 JSON 到 `.worktrees/events.jsonl`：

```typescript
function logEvent(type: 'create' | 'bind' | 'remove' | 'keep', worktree: string, taskId = ''): void {
  const event = { type, worktree, task_id: taskId, ts: Date.now() / 1000 };
  fs.appendFileSync(WORKTREE_EVENTS_PATH, JSON.stringify(event) + '\n', 'utf8');
}
```

本次演示的事件流（创建 → 绑定 → 移除）：

```
10:16:22 create auth
10:16:22 create ui
10:16:22 bind   auth ← task_1791886581_5883
10:16:22 bind   ui ← task_1791886581_9740
10:16:22 remove ui
10:16:22 remove auth
```

### 可重复运行：启动与退出双重清理

`cleanupWorktrees()` 在启动和结束（`finally`）各执行一次：

1. `git worktree list --porcelain` → 删除位于 `.worktrees/` 下的已注册 worktree（保留主工作区）；
2. `git worktree prune` → 清理失效的管理数据；
3. 删除 `.worktrees/` 下残留的物理目录；
4. `git for-each-ref refs/heads/wt/` → `git branch -D wt/<name>`。

因此连续运行不会向上累积 worktree 或分支，仓库始终干净。

---

## 工具集

| 工具 | 作用 |
|------|------|
| `bash` | 执行 shell 命令；`worktreeId` 指定在哪个 worktree 中执行（cwd 路由） |
| `create_task` / `list_tasks` / `get_task` / `claim_task` / `complete_task` | s12 持久化任务系统（含 `worktree` 字段） |
| `create_worktree` | 校验名称 → `git worktree add ... -b wt/<name> HEAD` |
| `bind_worktree` | 写任务 `worktree` 字段（保持 `pending`，等待认领） |
| `remove_worktree` | 变更守卫 → `git worktree remove --force` + `git branch -D` |

> `create_worktree` 的 schema 里带有 `branch` 参数（历史遗留），实现中分支名统一派生为
> `wt/<name>`。

---

## 相对 s17 的变更

| 组件 | 之前 (s17) | 之后 (s18) |
|------|-----------|-----------|
| 隔离粒度 | 无（单目录执行） | 文件系统级（真实 git worktree 目录） |
| BashExec | 固定 `cwd` | 接受 `cwd` 参数，路由到指定 worktree |
| 任务绑定 | 无 | `BindWorktree` 写 `.tasks/*.json` 的 `worktree` 字段 |
| 审计日志 | 无 | `events.jsonl` JSONL 事件流 |
| 安全守卫 | 无 | 未提交变更守卫（`discard_changes` 才强制移除） |
| 新 Effect | — | `CreateWorktree`、`BindWorktree`、`RemoveWorktree` |

---

## 运行

```bash
npm run s18

# 用隔离的临时工作区运行（会自动 git init，不触碰当前仓库）
AGENT_WORKSPACE=$(mktemp -d) npm run s18
```

---

## 本章小结

**Worktree = 文件系统层面的效应作用域隔离。CreateWorktree 真实执行 `git worktree add -b wt/<name>`，BindWorktree 把任务与路径关联，BashExec 的 cwd 参数将命令路由到正确的隔离目录，RemoveWorktree 在变更守卫通过后执行 `git worktree remove --force` 与 `git branch -D`，events.jsonl 记录所有操作。与 s06 Delegate（消息隔离）和 s08 Compact（上下文隔离）构成三个维度的 Agent 隔离体系。**

---

<details>
<summary>深入 CC 源码</summary>

> 以下基于 CC 源码 `worktree/manager.ts`、`git.ts` 的分析。

### 一、真实 git worktree API

本章已实现真实调用：

```bash
git worktree add <workspace>/.worktrees/auth -b wt/auth HEAD
# 创建关联 branch 的独立工作目录；worktree 内 .git 是指向主仓库的 git 文件

git worktree remove <workspace>/.worktrees/auth --force
git branch -D wt/auth
```

`RemoveWorktree` 在有未提交修改时拒绝（除非 `discard_changes=true`）；CC 也会在删除前检查/
处理未提交修改。

### 二、路径穿越防护

名称校验与 CC 的思路保持一致，拒绝路径穿越与非法字符：

```typescript
const VALID_WT_NAME = /^[A-Za-z0-9._-]{1,64}$/;
function validateWorktreeName(name: string): string | null {
  if (!name) return 'Worktree name cannot be empty';
  if (name === '.' || name === '..') return `'${name}' is not a valid worktree name`;
  if (!VALID_WT_NAME.test(name)) return `Invalid worktree name '${name}': ...`;
  return null;
}
```

`/`、`\`、`..` 等一律被拒，worktree 只会落在 `<workspace>/.worktrees/<name>` 之内。

### 三、孤立 worktree 清理

CC 启动时扫描所有存在的 worktree，与任务系统对比：有活跃任务则保留（`keep`），
孤立则清理（`remove`）。本章的 `cleanupWorktrees()` 采取更激进的策略——启动与退出时
清空本章管理的 worktree，保证演示可重复；`events.jsonl` 的 `keep` 类型为此类"保留审查"
场景预留（本章不主动产生）。

### 四、worktree 与 subagent 的组合

CC 的 Worktree 和 Subagent（s06）通常组合使用：主 Agent 管理任务分发并调用
`CreateWorktree`，子 Agent 在 `cwd` 约束下于指定 worktree 中工作，退出后由主 Agent
决定 `RemoveWorktree` 或保留等待合并。本章演示单 Agent 管理多 worktree。

### 教学版与 CC 的差异

| 维度 | 本章 | CC |
|------|------|-----|
| Worktree 创建 | 真实 `git worktree add -b wt/<name>` | 真实 `git worktree add` |
| 路径安全检查 | `validateWorktreeName` | 防穿越验证 |
| 孤立清理 | 启动/退出 `cleanupWorktrees` + `prune` | 启动扫描 + `keep`/`remove` 决策 |
| 与 subagent 组合 | 单 Agent 多 worktree | 每个 worktree 常配一个子 Agent |
| 事件日志 | `create`/`bind`/`remove`/`keep` | 含 `keep` 的完整生命周期 |

</details>
