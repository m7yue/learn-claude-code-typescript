# s18: Git Worktree Isolation — Worktree 是代码变更的效应沙箱

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

三个 Effect 管理 Worktree 的生命周期：

```typescript
// 创建独立工作树（独立文件系统视图）
const wt = yield* perform({
  type: 'CreateWorktree',
  input: { worktreeId: 'wt_feature_a', branch: 'feature/auth-refactor' }
});
// wt.path → '/tmp/.../wt_feature_a/'（独立目录，隔离文件变更）

// 将任务绑定到工作树（路径注入）
yield* perform({
  type: 'BindWorktree',
  input: { worktreeId: 'wt_feature_a', taskId: 'task_auth_001' }
});

// 在工作树目录中执行操作（cwd 注入路径，隔离命令作用域）
yield* perform({
  type: 'BashExec',
  input: { command: 'echo "auth refactor" > auth.patch', cwd: wt.path }
});

// 清理工作树（任务完成后）
yield* perform({ type: 'RemoveWorktree', input: { worktreeId: 'wt_feature_a' } });
```

**关键洞见**：隔离通过 `cwd` 注入实现。`BindWorktree` 关联任务 ID 和文件系统路径，Generator 在执行 BashExec 时查询该映射，自动路由到正确沙箱。

| Git worktree 命令 | 代数效应 TypeScript |
|-----------------|-------------------|
| `git worktree add .wt/feature-a feature/auth` | `CreateWorktree` Effect |
| `git worktree remove .wt/feature-a` | `RemoveWorktree` Effect |
| 在 worktree 目录中执行命令 | `BashExec` + `cwd` 参数注入 |
| 记录 task ↔ worktree 映射 | `BindWorktree` Effect |

---

## 工作原理

### 隔离机制：cwd 注入

```
/tmp/.../s18/worktrees/
  wt_feature_a/    ← 独立目录（模拟 git worktree add）
    .worktree       ← 元数据（worktreeId, branch）
    auth.patch      ← 在此目录的变更不影响 wt_feature_b/
  wt_feature_b/
    api.patch
events.jsonl        ← 所有 worktree 操作的审计日志
```

```typescript
// BashExec Handler：接受 cwd 路由到对应沙箱
BashExec: async (effect) => {
  const { command, cwd } = effect.input;
  return execSync(command, { cwd: cwd ?? process.cwd() });
}

// Generator 中：查询 worktree 路径，注入 cwd
const cwd = wtId ? worktrees.get(wtId)?.path : undefined;
output = yield* perform({ type: 'BashExec', input: { command, cwd } });
```

### events.jsonl：Worktree 操作审计日志

每次 worktree 操作都追加一行 JSON 到 `events.jsonl`：

```typescript
type WorktreeEventType = 'create' | 'remove' | 'keep' | 'bind';

function logWorktreeEvent(type: WorktreeEventType, worktreeId: string, extra?: Record<string, string>): void {
  const entry = JSON.stringify({ ts: new Date().toISOString(), type, worktreeId, ...extra });
  fs.appendFileSync(EVENTS_LOG, entry + '\n', 'utf8');
}
```

演示输出：
```
04:22:05 create wt_feature_a (feature/auth-refactor)
04:22:05 create wt_feature_b (feature/api-v2)
04:22:05 bind   wt_feature_a ← task_auth_001
04:22:05 remove wt_feature_a (feature/auth-refactor)
04:22:05 remove wt_feature_b (feature/api-v2)
```

---

## 相对 s17 的变更

| 组件 | 之前 (s17) | 之后 (s18) |
|------|-----------|-----------|
| 隔离粒度 | 无（单目录执行） | 文件系统级（独立 worktree 目录） |
| BashExec | 固定 `cwd` | 接受 `cwd` 参数，路由到指定 worktree |
| 任务绑定 | 无 | `BindWorktree` 关联 taskId ↔ worktreePath |
| 审计日志 | 无 | `events.jsonl` JSONL 格式事件流 |
| 新 Effect | — | `CreateWorktree`、`RemoveWorktree`、`BindWorktree` |

---

## 运行

```bash
npm run s18
```

---

## 本章小结

**Worktree = 文件系统层面的效应作用域隔离。CreateWorktree 创建独立目录，BindWorktree 关联任务与路径，BashExec 的 cwd 参数将命令路由到正确的隔离沙箱，events.jsonl 记录所有操作的审计日志。与 s06 Delegate（消息隔离）和 s08 Compact（上下文隔离）构成三个维度的 Agent 隔离体系。**

---

<details>
<summary>深入 CC 源码</summary>

> 以下基于 CC 源码 `worktree/manager.ts`、`git.ts` 的分析。

### 一、真实 git worktree API

教学版用临时目录模拟，真实 CC 调用 `git worktree add`：

```bash
git worktree add .git/worktrees/wt_feature_a feature/auth-refactor
# 创建关联 branch 的独立工作目录
# .git/worktrees/wt_feature_a/HEAD 指向 feature/auth-refactor
```

`RemoveWorktree` 对应 `git worktree remove .git/worktrees/wt_feature_a`，若目录有未提交修改则 CC 先 `git stash`。

### 二、路径穿越防护

CC 对 worktree 路径做了严格验证，防止路径穿越攻击：

```typescript
// CC 伪代码
function validateWorktreePath(p: string, base: string): boolean {
    const resolved = path.resolve(p);
    return resolved.startsWith(path.resolve(base));
}
```

如果 worktreeId 包含 `../` 等特殊字符，CC 拒绝创建。教学版直接 `path.join(WORKTREE_BASE, worktreeId)`，未做此验证。

### 三、孤立 worktree 清理

CC 启动时扫描所有存在的 worktree，与任务系统对比：
- 有对应活跃任务 → 保留（`keep` 事件）
- 无对应任务（孤立）→ 自动清理（`remove` 事件）

这正是 `events.jsonl` 中会出现 `keep` 类型的原因。教学版无此启动扫描。

### 四、worktree 与 subagent 的组合

CC 的 Worktree 和 Subagent（s06）通常组合使用：
- 主 Agent：管理任务分发，调用 `CreateWorktree`
- 子 Agent：在指定 worktree 路径中工作，通过 `cwd` 约束
- 子 Agent 退出后：主 Agent 调用 `RemoveWorktree` 或保留等待合并

教学版演示了单 Agent 管理多 worktree，实际场景常见每个 worktree 配一个子 Agent。

### 教学版的简化

| 简化项 | 教学版 | CC |
|--------|--------|-----|
| Worktree 创建 | 临时目录 `mkdir` | `git worktree add` |
| 路径安全检查 | 无 | 防穿越验证 |
| 孤立清理 | 无 | 启动时扫描 + `keep`/`remove` |
| 与 subagent 组合 | 无 | 每个 worktree 通常绑定一个子 Agent |
| 事件日志 | `events.jsonl` 4 种类型 | 含 `keep` 共 5 种类型 |

</details>
