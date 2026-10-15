# s04: Hooks — 效应拦截层

[s03](../s03_permission/) → [s04] → [s05](../s05_todo_write/) → s06 → ... → s20

---

## 第一性原理

**问题的本质**：s03 的权限检查是"一种到处都要用到的公共逻辑"。

s03 里，权限检查通过 `checkPermissionPipeline()` 写在 Agent Generator 里。但权限不是业务逻辑——它和"读文件、写文件、调用 LLM"等业务操作不是**同一类**东西。

如果权限检查写在 Generator 里，那日志记录、监控、缓存、审计呢？每加一种这样的公共逻辑，Generator 就膨胀一次。

**解法**：把这类公共逻辑提升为 `FireHook` Effect，让 Handler 在不同生命周期节点注入逻辑。Generator 只描述业务流程，Hook 系统负责这些公共逻辑。

---

## 问题

s03 的 Agent Generator 里有权限检查的痕迹：

```typescript
// s03：权限检查嵌入 Generator
const perm = yield* checkPermissionPipeline(toolName, args, perform);
if (!perm.allowed) { ... }
```

这让 Generator 承担了它不该承担的职责。下一章如果要加日志，还要改 Generator？

**理想状态**：Generator 只关心"顺序是什么"，不关心"每步前后发生了什么"。

---

## 代数效应视角

引入 `FireHook` Effect：

```typescript
interface FireHookEffect extends Effect<
  'FireHook',
  {
    event: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop';
    data: Record<string, unknown>;
  },
  { blocked: boolean; reason?: string }
> {}
```

**Hook 系统 = Effect 拦截器**：

| 概念 | 代数效应含义 |
|------|------------|
| `PreToolUse` Hook | 在 `BashExec` Effect 被 Handler 处理**之前**运行 |
| `PostToolUse` Hook | 在 `BashExec` Effect 被 Handler 处理**之后**运行 |
| Hook 返回 `blocked: true` | 阻止原 Effect 执行（等价于 s03 的权限拒绝） |
| 多个 Hook 串联 | 第一个返回 blocked 的 Hook 生效，后续跳过 |

| Python | 代数效应 TypeScript |
|--------|-------------------|
| `HOOKS = { 'PreToolUse': [fn1, fn2, ...] }` | `FireHook` Handler 内部维护 Hook 注册表 |
| `trigger_hooks("PreToolUse", block)` | `yield* perform({ type: 'FireHook', input: { event: 'PreToolUse', ... } })` |
| `register_hook(event, callback)` | Handler 初始化时注册；或在 Handler 实现中硬编码 |

**s03 的权限逻辑现在移入 Hook**：

```typescript
// 权限 Hook — 在 PreToolUse 运行
function permissionHook(toolName: string, args: Record<string, unknown>) {
  if (DENY_LIST.some(d => String(args.command ?? '').includes(d))) {
    return { blocked: true, reason: '命令在禁止清单中' };
  }
  return { blocked: false };
}

// 日志 Hook — 在 PreToolUse 运行（不拦截）
function logHook(toolName: string) {
  console.log(`[Hook:Log] 即将执行 ${toolName}`);
  return { blocked: false };
}
```

Generator 里只剩一行：

```typescript
const hook = yield* perform({ type: 'FireHook', input: { event: 'PreToolUse', data: { toolName, args } } });
if (hook.blocked) { ... }
```

---

## 解决方案

### Hook 注册表

```typescript
type HookFn = (data: Record<string, unknown>) => { blocked: boolean; reason?: string };
const HOOKS: Record<string, HookFn[]> = {
  PreToolUse: [permissionHook, logHook],
  PostToolUse: [largeOutputHook],
  UserPromptSubmit: [contextInjectHook],
  Stop: [summaryHook],
};
```

### FireHook Handler

```typescript
FireHook: async (effect: FireHookEffect) => {
  const { event, data } = effect.input;
  const hooks = HOOKS[event] ?? [];
  for (const hook of hooks) {
    const result = hook(data);
    if (result.blocked) return result; // 第一个拦截生效
  }
  return { blocked: false };
},
```

---

## 工作原理

```
Agent Generator
    │
    ├─ yield FireHook({ event: 'PreToolUse', ... })
    │           │
    │   ┌───────▼────────────────────────────────┐
    │   │  FireHook Handler                      │
    │   │  for hook of HOOKS['PreToolUse']:      │
    │   │    result = hook(data)                 │
    │   │    if result.blocked → return blocked  │
    │   │  return { blocked: false }             │
    │   └───────────────────────────────────────┘
    │           │
    │   blocked? ├─ Yes → 跳过工具执行，返回拒绝消息
    │            └─ No  ↓
    │
    ├─ yield BashExec(...)  ← 执行（本章是教学实现：只回显命令文本）
    │
    └─ yield FireHook({ event: 'PostToolUse', ... })
              │
        [大输出警告、日志记录等]
```

---

## 运行

```bash
npm run s04
```

输出示例：
```
[S04] Hooks 启动

[Hook:UserPromptSubmit] 注入上下文: 当前时间 <HH:MM:SS>

[Chat] → 发送 1 条消息...
[LLM]  ← stop_reason: tool_use, 工具: bash
[Hook:Permission] ✓ 允许执行 bash
[Hook:Log] 即将执行 bash
[BashExec] → ls -la
[Hook:PostToolUse] bash 输出 14 字符
（本章的 BashExec 只回显命令文本，所以「输出」是 `(执行结果: ls -la)` 这 14 个字符；
  system prompt 里也告诉了模型这一点，避免它依赖这个输出。）

[Chat] → 发送 3 条消息...
[LLM]  ← stop_reason: tool_use, 工具: bash
[Hook:Permission] ✗ 拒绝 bash: 命中禁止清单 "rm -rf /"

[Chat] → 发送 5 条消息...
[LLM]  ← stop_reason: end_turn

[Hook:Stop] 循环结束，共 3 轮
[S04] 完成: 操作完成，部分命令被 Hook 拦截。
```

---

## 本章小结

**FireHook Effect 是"效应的效应"——它在其他效应被处理前后插入这类公共逻辑，让权限、日志、监控与业务逻辑彻底分开。Generator 只描述顺序，Hook 系统负责这些公共逻辑。**
