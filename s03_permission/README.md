# s03: Permission — 权限是副作用的守门人

[s02](../s02_tool_use/) → [s03] → [s04](../s04_hooks/) → s05 → ... → s20

---

## 第一性原理

**问题的本质**：谁来决定副作用能不能发生？

Agent 通过 Effect 声明"我要做 X"。但并非所有 X 都应该被允许执行。`rm -rf /`、`sudo shutdown`、把文件写到工作区外——这些操作的后果是不可逆的。

**关键洞察**：权限检查本身也是一种**副作用**。它需要读取规则（I/O）、可能需要问用户（I/O）。因此权限检查应该在 **Handler 层**发生——正是所有副作用被实现的地方。

---

## 问题

s02 的 `BashExec` Handler 直接执行命令，没有任何拦截：

```typescript
BashExec: async (effect) => {
  return execSync(effect.input.command).toString(); // 完全信任！
},
```

模型可以生成任意命令，包括破坏性操作。我们需要在执行前插入一道检查。

---

## 代数效应视角

权限检查需要一个新的 Effect：

```typescript
interface RequestPermissionEffect extends BaseEffect {
  type: 'RequestPermission';
  input: {
    toolName: string;
    args: Record<string, unknown>;
    reason: string;
  };
  output: { allowed: boolean; reason?: string };
}
```

**三道闸门**，在 Handler 内部串联：

```
BashExec Handler 被调用
      │
      ▼
Gate 1: DenyList 检查（硬否，无商量）
  ├─ 命中 → 拒绝，返回错误消息
  └─ 通过 ↓

Gate 2: Rules 检查（条件判断）
  ├─ 命中 → 升级到 Gate 3
  └─ 通过 → 直接执行 ✓

Gate 3: 用户审批（RequestPermission Effect）
  ├─ 拒绝 → 返回错误消息
  └─ 同意 → 执行 ✓
```

| Python | 代数效应 TypeScript |
|--------|-------------------|
| `check_permission(block)` 函数内嵌在循环 | `RequestPermission` Effect，由 Handler 处理 |
| `DENY_LIST`、`PERMISSION_RULES` 写死在函数里 | Handler 实现可替换（测试时跳过审批） |
| 用 `input()` 阻塞等待用户 | `RequestPermission` Handler 可实现任意审批方式 |

**测试时的优雅**：把 `RequestPermission` Handler 换成自动同意——同一业务逻辑，零改动：

```typescript
const testHandlers = {
  ...prodHandlers,
  RequestPermission: async () => ({ allowed: true }), // 测试自动放行
};
```

---

## 解决方案

### 三道闸门实现

```typescript
const DENY_LIST = ['rm -rf /', 'sudo', 'shutdown', 'reboot', ':(){ :|:& };:'];

const PERMISSION_RULES = [
  {
    match: (tool: string, args: Record<string, unknown>) =>
      tool === 'BashExec' && DENY_LIST.some(d => String(args.command).includes(d)),
    reason: '命令在硬否列表中',
    autoReject: true,
  },
  {
    match: (tool: string, args: Record<string, unknown>) =>
      tool === 'WriteFile' && !String(args.path).startsWith(WORKDIR),
    reason: '写入工作区外的路径',
    autoReject: false, // 需要用户审批
  },
];
```

### 业务逻辑不变

Agent Generator 与 s02 完全相同。权限逻辑完全封装在 Handler 内部：

```typescript
BashExec: async (effect) => {
  // 先检查权限（通过 RequestPermission Effect）
  const perm = await checkPermissionPipeline('BashExec', effect.input);
  if (!perm.allowed) return `[拒绝] ${perm.reason}`;

  // 权限通过后才执行
  return execSync(effect.input.command).toString();
},
```

---

## 工作原理

```
Agent: yield* perform({ type: 'BashExec', input: { command: 'rm -rf /' } })
                     │
                     ▼
          runAgent → BashExec Handler
                     │
                     ▼
              Gate 1: DenyList
              ├─ 'rm -rf /' 命中！
              └─ return "[拒绝] 命令在硬否列表中"
                     │
                     ▼（若未命中 DenyList）
              Gate 2: Rules 匹配
              ├─ autoReject → 直接拒绝
              └─ 需审批 → yield RequestPermission Effect
                               │
                               ▼
                    RequestPermission Handler
                    （询问用户 y/N）
                               │
                    ├─ 拒绝 → return { allowed: false }
                    └─ 同意 → return { allowed: true }
                               │
                               ▼（若 allowed）
              execSync(command) → 返回结果
```

---

## 运行

```bash
npm run s03
```

输出示例：
```
[S03] Permission 启动

[Chat] → 发送 1 条消息...
[LLM]  ← stop_reason: tool_use, 工具: bash
[Gate1] ✓ 通过硬否列表
[Gate2] ⚠ 命中规则: 可能的破坏性命令
[Permission] → 询问用户: 是否允许执行 BashExec?
[Permission] ← 用户: 同意（mock）
[BashExec] → ls -la
[BashExec] ← (文件列表)

[Chat] → 发送 1 条消息...
[LLM]  ← stop_reason: tool_use, 工具: bash
[Gate1] ✗ 命中硬否列表: rm -rf /
[BashExec] ← [拒绝] 命令在硬否列表中

[Chat] → 发送 3 条消息...
[LLM]  ← stop_reason: end_turn
[S03] 完成
```

---

## 本章小结

**权限是副作用的守门人，它本身也是副作用，因此住在 Handler 层。三道闸门（硬否/规则/用户审批）完全封装在 Handler 实现中，业务逻辑（Generator）零感知。**
