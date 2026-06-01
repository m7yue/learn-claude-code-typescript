# s09: Memory — 跨会话的效应持久化

[s08](../s08_context_compact/) → [s09] → [s10](../s10_system_prompt/) → s11 → ... → s20

---

## 第一性原理

**问题的本质**：压缩会丢信息，而有些信息不能丢。

s08 的压缩策略（snip、micro、auto）是为了让长任务能够继续——但代价是丢失中间历史。如果用户在第1轮告诉你"我喜欢 Tab 缩进"，而这条信息在第20轮被压缩掉了，下次对话从头开始，你又忘了。

**压缩 vs 记忆**：
- 压缩 = 在单次会话内缩减上下文，允许信息损失
- 记忆 = 跨压缩、跨会话的持久存储，信息不能丢

---

## 问题

每次新会话开始，Agent 对用户一无所知：

```
会话 1: 用户说"我喜欢 Tab"→ 写了很多文件都是 Tab ✓
会话 2: Agent 完全忘了，又用回空格 ✗
```

压缩发生时，早期的用户偏好信息消失：

```
会话内第50轮后，L4 auto-compact 把前面历史摘要掉
→ "喜欢 Tab"的信息在摘要中被省略
→ 同一会话内后期又用了空格 ✗
```

---

## 代数效应视角

三个 Effect 构成记忆系统：

```typescript
// 读记忆（无 filename 则读索引）
interface ReadMemoryEffect extends BaseEffect {
  type: 'ReadMemory';
  input: { filename?: string };
  output: string;
}

// 写记忆（带 YAML frontmatter 的 Markdown 文件）
interface WriteMemoryEffect extends BaseEffect {
  type: 'WriteMemory';
  input: { name: string; type: MemoryType; description: string; body: string };
  output: string;
}

// 选择相关记忆（基于当前上下文）
interface SelectMemoryEffect extends BaseEffect {
  type: 'SelectMemory';
  input: { context: string; maxItems?: number };
  output: string[]; // 相关文件名列表
}
```

**双层索引架构**：

| 层级 | 内容 | 始终在 system prompt？ |
|------|------|----------------------|
| MEMORY.md 索引 | 每条记忆的名称 + 一行描述 | 是（~20 token/条） |
| {name}.md 内容 | 完整记忆正文 | 否，按需通过 SelectMemory 加载 |

| Python | 代数效应 TypeScript |
|--------|-------------------|
| `write_memory_file(name, type, desc, body)` | `WriteMemory` Effect → Handler 写文件 + 重建索引 |
| `read_memory_index()` | `ReadMemory` Effect（无 filename 参数） |
| `select_relevant_memories(messages, max=5)` | `SelectMemory` Effect → Handler 关键词匹配或 LLM 选择 |
| 四种类型: user/feedback/project/reference | `MemoryType` 联合类型 |

---

## 解决方案

### 记忆文件格式（与原项目完全一致）

```markdown
---
name: user-prefers-tabs
description: 用户偏好使用 Tab 而非空格缩进
metadata:
  type: feedback
---

用户明确表示喜欢 Tab 缩进。

**Why:** 用户说"用空格的代码看着头疼"。
**How to apply:** 在生成代码时始终用 Tab。
```

### 会话启动流程

```typescript
function* agentLoop(perform: PerformFn<S09Effect>) {
  // 1. 读取记忆索引，注入 system prompt
  const memoryIndex = yield* perform({ type: 'ReadMemory', input: {} });
  const systemPrompt = `...\n\nMEMORY:\n${memoryIndex}`;

  // 2. 正常对话循环...

  // 3. 循环结束后，从历史中提取新记忆
  // （在真实实现中，通过 LLM 调用分析对话提取）
}
```

---

## 工作原理

```
会话启动
    │
    ▼
ReadMemory (索引) → 注入 system prompt
    │
    ▼
┌─────────────────────────────────────────────┐
│  对话循环                                    │
│                                             │
│  用户: "记住我喜欢 Tab"                      │
│  LLM 决定调用 write_memory                   │
│  → WriteMemory Effect                       │
│  → Handler 写文件 + 重建 MEMORY.md           │
│                                             │
└─────────────────────────────────────────────┘
    │
    ▼
下次会话：ReadMemory 读到 "user-prefers-tabs"
    │
    ▼
SelectMemory 选择与当前任务相关的记忆
    │
    ▼
相关记忆内容注入上下文 → LLM 知道用 Tab ✓
```

---

## 运行

```bash
npm run s09
```

---

## 本章小结

**Memory Effect 是压缩的"豁免层"：它把不能被压缩掉的信息保存到文件系统，跨压缩、跨会话持久存在。ReadMemory/WriteMemory 是文件 I/O 的类型化效应表达。**
