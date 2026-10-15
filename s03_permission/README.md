# s03: Permission — 权限是副作用的守门人

[s02](../s02_tool_use/) → [s03] → [s04](../s04_hooks/) → s05 → ... → s20

---

## 第一性原理

**问题的本质**：谁来决定副作用能不能发生？

Agent 通过 Effect 声明"我要做 X"。但并非所有 X 都应该被允许执行。`rm -rf /`、`sudo shutdown`、把文件写到工作区外——这些操作的后果是不可逆的。

**关键洞察**：权限检查本身也是一种**副作用**。它需要读取规则（I/O）、可能需要问用户（I/O）。因此权限检查应该在 **Handler 层**发生——正是所有副作用被实现的地方。

---

## 问题

s02 没有权限层：Handler 拿到命令就直接执行，没有任何拦截。本章的命令是真执行的，模型生成什么就跑什么：

```typescript
BashExec: async (effect) => {
  const r = spawnSync(effect.input.command, { shell: true, cwd: WORKDIR }); // 完全信任！
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
},
```

模型可以生成任意命令，包括破坏性操作。我们需要在执行前插入一道检查。

---

## 代数效应视角

权限检查需要一个新的 Effect：

```typescript
interface RequestPermissionEffect extends Effect<
  'RequestPermission',
  {
    toolName: string;
    args: Record<string, unknown>;
    reason: string;
  },
  { allowed: boolean; reason?: string }
> {}
```

**三道检查关口**，在工具执行前串联；其中「问用户」这一步本身就是副作用，走 `RequestPermission` Effect 交给 Handler：

```
执行工具之前（Generator 里串起前两关）
      │
      ▼
Gate 1: DenyList 检查（命中禁止清单就拒绝，没有商量余地）
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
  RequestPermission: async () => ({ allowed: true }), // 测试里自动允许
};
```

---

## 解决方案

### 三道检查关口实现

```typescript
const DENY_LIST = ['rm -rf /', 'sudo', 'shutdown', 'reboot', ':(){ :|:& };:'];

const PERMISSION_RULES = [
  {
    match: (tool: string, args: Record<string, unknown>) =>
      tool === 'bash' && DENY_LIST.some(d => String(args.command).includes(d)),
    reason: '命令在禁止清单中',
    autoReject: true,
  },
  {
    match: (tool: string, args: Record<string, unknown>) => {
      if (tool !== 'write_file') return false;
      const rel = path.relative(WORKDIR, path.resolve(WORKDIR, String(args.path ?? '')));
      return rel.startsWith('..') || path.isAbsolute(rel);
    },
    reason: '写入工作区外的路径',
    autoReject: false, // 需要用户审批
  },
];
```

### 业务逻辑不变

Agent Generator 的循环结构与 s02 相同，只是在执行工具前多走了一步检查。

闸门收的是**模型给的**工具名（`bash` / `write_file`），和规则表里写的是同一套名字，中间不做任何改名。

批准本身是副作用（要问用户），所以它是一条 Effect：Generator 里串起三关，第 3 关命中规则时才 `yield` 一个 `RequestPermission` 交给 Handler 处理。

```typescript
// Generator：执行工具之前
const perm = yield* checkPermissionPipeline(block.name, block.input, perform);
if (!perm.allowed) { /* 把拒绝原因作为工具结果喂回模型 */ }

// Handler：批准之后才真正执行
BashExec: async (effect) => {
  const r = spawnSync(effect.input.command, { shell: true, cwd: WORKDIR });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
},
```

---

## 工作原理

```
模型返回 tool_use: bash，参数 { command: 'rm -rf /' }
                     │
                     ▼
          checkPermissionPipeline（Generator 里串起三关）
                     │
                     ▼
              Gate 1: DenyList
              ├─ 'rm -rf /' 命中！
              └─ return "[拒绝] 命令在禁止清单中"
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
              perform({ type: 'BashExec' }) → spawnSync(command) → 返回结果
```

---

## 运行

```bash
npm run s03
```

章节启动时先建好演示用的临时文件（`s03_permission/.output/tmp.txt`，落在章节目录的 `.output/` 里，已被 gitignore），每次运行都重建，所以「清理」这一步有真实目标。

命令是真执行的，工作目录就是工作区根目录（`AGENT_WORKSPACE` 可覆盖），所以第 3 关会在终端里停下来等你输入 y/N，空回车按拒绝。管道、CI、e2e 测试这类非交互环境读不到输入，自动同意。

输出示例（按 y 的那次）：
```
[S03] Permission 启动

[准备] 已建好演示临时文件: s03_permission/.output/tmp.txt

[Chat] → 发送 1 条消息...
[LLM]  ← stop_reason: tool_use, 工具: bash
[Gate1] ✓ 未命中禁止清单
[Gate2] ⚠ 命中规则: 可能的破坏性命令
[Permission] → 询问用户: 是否允许执行 bash? (原因: 可能的破坏性命令)
  允许执行 `rm s03_permission/.output/tmp.txt` 吗？[y/N] y
[Permission] ← 用户: 同意
[BashExec] → rm s03_permission/.output/tmp.txt

[Chat] → 发送 3 条消息...
[LLM]  ← stop_reason: tool_use, 工具: bash
[Gate1] ✗ 命中禁止清单: rm -rf /
[拒绝] bash: 命令在禁止清单中: "rm -rf /"

[Chat] → 发送 5 条消息...
[LLM]  ← stop_reason: end_turn

[S03] 完成: 操作已完成（部分被拒绝）。
```

`rm s03_permission/.output/tmp.txt` 真的执行了，那个临时文件被删掉；命中禁止清单的那条根本没进入执行。

---

## 本章小结

**权限是副作用的守门人，它本身也是副作用，因此住在 Handler 层。三道检查关口（禁止清单/规则/用户审批）完全封装在 Handler 实现中，业务逻辑（Generator）零感知。**
