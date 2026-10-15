# s02: Tool Use — 工具分发 = 类型路由

[s01](../s01_agent_loop/) → [s02] → [s03](../s03_permission/) → s04 → ... → s20

---

## 第一性原理

**问题的本质**：工具越来越多，分发逻辑怎么不失控？

s01 只有一个工具（bash），所以分发逻辑很简单：

```typescript
// s01：工具只有一种，直接处理
const output = yield* perform({ type: 'BashExec', ... });
```

但真实系统有几十个工具。如果用 `if/else` 或 `switch` 分发，每加一个工具都要修改核心循环——这违反了"只做扩展、不改动已有代码"的原则，也让循环越来越难读。

**解法**：让 **effect.type** 字符串直接成为路由键。新增工具 = 新增 Effect 类型 + 新增 Handler，核心循环完全不变。

---

## 问题

bash 工具虽然万能，但效率低：
- 读文件要用 `cat`，写文件要用 `echo >`，查找文件要用 `find`
- 每次都需要模型知道正确的 shell 语法
- 输出不结构化，难以处理

更重要的是：`bash` 是"一切皆可"，但**没有类型**——你无法从工具名知道它做什么、输入什么格式、会产生什么副作用。

---

## 代数效应视角

在代数效应系统中，**每个工具就是一个 Effect 类型**。

```typescript
// s01：bash 万能工具
interface BashExecEffect extends Effect<
  'BashExec',
  { command: string }, // 无结构
  string
> {}

// s02：专用工具，有明确的类型签名
interface ReadFileEffect extends Effect<
  'ReadFile',
  { path: string; limit?: number }, // 有结构
  string
> {}

interface WriteFileEffect extends Effect<
  'WriteFile',
  { path: string; content: string },
  string
> {}
```

| Python | 代数效应 TypeScript |
|--------|-------------------|
| `TOOL_HANDLERS = { 'bash': run_bash, 'read_file': run_read, ... }` | `handlers = { BashExec: ..., ReadFile: ..., ... }` |
| `TOOL_HANDLERS[block.name](**block.input)` | `handlers[effect.type](effect)` — 由 `runAgent()` 自动路由 |
| 新增工具 = 往字典加一项 | 新增工具 = 新 Effect 类型 + 新 Handler |

**关键差别**：Python 的路由是运行时字符串查找，类型信息丢失。TypeScript 的 Effect Union 让编译器在类型层面验证每个工具调用的输入输出。

---

## 解决方案

### 从 1 个工具到 5 个工具

```typescript
// s02 新增的 4 个 Effect
type S02Effect =
  | ChatEffect      // 继承自 s01
  | BashExecEffect  // 继承自 s01
  | ReadFileEffect  // 新增：读文件
  | WriteFileEffect // 新增：写文件
  | EditFileEffect  // 新增：替换文件片段
  | GlobSearchEffect; // 新增：文件通配搜索
```

### 路由不变，只加 Handler

Agent Generator 的结构与 s01 完全相同。唯一变化是工具执行部分：

```typescript
// s01 只处理一种工具
const output = yield* perform({ type: 'BashExec', input: { command } });

// s02 根据工具名 yield 不同 Effect（类型安全）
switch (block.name) {
  case 'bash':
    output = yield* perform({ type: 'BashExec', input: { command } });
    break;
  case 'read_file':
    output = yield* perform({ type: 'ReadFile', input: { path, limit } });
    break;
  // ...
}
```

实际上 `runAgent()` 内部的路由逻辑 `handlers[effect.type](effect)` 从未改变。

---

## 工作原理

```
LLM 返回 tool_use 块
      │
      ▼
  block.name = ?
      │
  ┌───┴───────────────────────────────┐
  │ 'bash'      → BashExec Effect     │
  │ 'read_file' → ReadFile Effect     │
  │ 'write_file'→ WriteFile Effect    │
  │ 'edit_file' → EditFile Effect     │
  │ 'glob'      → GlobSearch Effect   │
  └───────────────────────────────────┘
      │
      ▼
  runAgent() 路由到对应 Handler
      │
      ▼
  结果通过 generator.next() 注入回 Agent
```

**路径安全校验**：`ReadFile` / `WriteFile` 等文件工具的 Handler 会验证路径不逃逸工作目录：

```typescript
function safePath(p: string, workdir: string): string {
  const resolved = path.resolve(workdir, p);
  const rel = path.relative(workdir, resolved);
  // 用相对路径判断越界：`/工作区-xxx` 这类同前缀兄弟目录也会被拦下。
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径越界: ${p}`);
  }
  return resolved;
}
```

---

## 运行

```bash
npm run s02
```

输出示例：
```
[S02] Tool Use 启动
工作区: /path/to/learn-claude-code-typescript
产物目录: ./s02_tool_use/.output（已在 .gitignore 忽略）

[Chat] → 发送 1 条消息...
[LLM]  ← stop_reason: tool_use, 工具: read_file, glob
[ReadFile] → ./package.json
[ReadFile] ← 100 字符
[GlobSearch] → **/*.ts
[GlobSearch] ← 68 个文件
[Chat] → 发送 3 条消息...
[LLM]  ← stop_reason: tool_use, 工具: write_file
[WriteFile] → ./s02_tool_use/.output/s02_output.txt
[Chat] → 发送 5 条消息...
[LLM]  ← stop_reason: end_turn

[S02] 完成: 已读取 package.json 并写入摘要到 ./s02_tool_use/.output/s02_output.txt
```

> `GlobSearch` 会真正按 `pattern` 在工作区（`WORKSPACE_ROOT`）内递归匹配，
> 命中数随仓库内容变化；`WriteFile` 写入的是**工作区相对路径**，因此能通过 `safePath` 校验。

---

## 本章小结

**每个工具 = 一个 Effect 类型。工具分发 = runAgent() 根据 effect.type 路由到对应 Handler。新增工具不改变任何已有代码。**

这是代数效应系统的核心优势：扩展性通过类型系统保证，而非靠约定或文档。
