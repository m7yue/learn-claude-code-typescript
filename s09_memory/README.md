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

五个 Effect 构成记忆系统：

```typescript
// 读记忆（无 filename 则读索引）
interface ReadMemoryEffect extends Effect<
  'ReadMemory',
  { filename?: string },
  string
> {}

// 写记忆（带 YAML frontmatter 的 Markdown 文件）
interface WriteMemoryEffect extends Effect<
  'WriteMemory',
  { name: string; type: MemoryType; description: string; body: string },
  string
> {}

// 选择相关记忆（基于当前上下文，真实 LLM 调用）
interface SelectMemoryEffect extends Effect<
  'SelectMemory',
  { context: string; maxItems?: number },
  string[] // 相关文件名列表
> {}

// 每轮结束后抽取新记忆（真实 LLM 调用 → 写文件）
interface ExtractMemoriesEffect extends Effect<
  'ExtractMemories',
  { messages: Message[] },
  number // 抽取并写入的条数
> {}

// 文件数达阈值时合并/去重（真实 LLM 调用 → 删旧写新）
interface ConsolidateMemoriesEffect extends Effect<
  'ConsolidateMemories',
  { threshold?: number },
  { from: number; to: number } | null
> {}
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
| `select_relevant_memories(messages, max=5)` | `SelectMemory` Effect → 真实 LLM 选择，挑不出来就不注入 |
| `extract_memories(messages)` | `ExtractMemories` Effect → 真实 LLM 抽取 → 写入磁盘 |
| `consolidate_memories()` | `ConsolidateMemories` Effect → 数量 ≥ 10 时真实 LLM 合并 |
| 四种类型: user/feedback/project/reference | `MemoryType` 联合类型 |

---

## 解决方案

### 记忆文件格式

```markdown
---
name: user-prefers-tabs
description: 用户偏好使用 Tab 而非空格缩进
type: feedback
---

用户明确表示喜欢 Tab 缩进。

**Why:** 用户说"用空格的代码看着头疼"。
**How to apply:** 在生成代码时始终用 Tab。
```

索引 `MEMORY.md` 由 `_rebuild_index()` 从所有 `*.md`（排除索引自身）重建：

```markdown
- [user-prefers-tabs](user-prefers-tabs.md) — 用户偏好使用 Tab 而非空格缩进
```

### 三条真实 LLM 链路（mock 只替换模型本身）

记忆机制的关键是：**select / extract / consolidate 都是真实的 `callChat(...)` 调用**，
mock 模式只是把「模型」换成结果稳定的 `mockSelector` / `mockExtractor` / `mockConsolidator`，
调用路径、文件读写、索引重建全部是真的。

#### 1. SelectMemory — 选择相关记忆

```typescript
// 1) 把每条记忆的 name + description 编成目录
const catalog = files.map((f, i) => `${i}: ${f.name} — ${f.description}`).join('\n');

// 2) 让模型只看目录就选出相关下标（省 token）
const response = await callChat(mockSelector, [{ role: 'user', content: prompt }], { maxTokens: 200 });
const indices = extractJsonArray(extractText(response).trim(), false); // [0, 3]

// 3) 模型不可用或返回的下标解析不出来时，本轮不注入记忆（只打日志，不猜）
```

#### 2. ExtractMemories — 每轮结束后抽取新记忆

```typescript
// 收集最近 10 条消息 → 连同「已有记忆摘要」一起交给模型去重
const response = await callChat(mockExtractor, [{ role: 'user', content: prompt }], { maxTokens: 800 });
// 模型返回 [{ name, type, description, body }, ...] → 逐条 writeMemoryFile（真实写入磁盘 + 重建索引）
```

#### 3. ConsolidateMemories — 达阈值时合并（Dream）

```typescript
const CONSOLIDATE_THRESHOLD = 10;
if (files.length < CONSOLIDATE_THRESHOLD) return null;
// 模型返回合并后的 JSON 数组 → 校验出可用条目 → 先写新文件，再删没被取代的旧文件
```

### 会话启动流程

```typescript
function* agentLoop(perform: PerformFn<S09Effect>) {
  // 1. 读取记忆索引，注入 system prompt（system 在整轮内固定）
  const memoryIndex = yield* perform({ type: 'ReadMemory', input: {} });
  const systemPrompt =
    baseSystemPrompt() +
    (memoryIndex ? `\n\n记忆目录：\n${memoryIndex}` : '') +
    '……当记忆与当前用户请求冲突时，以当前用户请求为准。';

  // 2. 用真实 LLM 选择相关记忆 → 读取内容 → 注入当前用户轮次
  const selected = yield* perform({ type: 'SelectMemory', input: { context, maxItems: 5 } });
  // …拼成 <relevant_memories>…</relevant_memories> 前缀注入

  // 3. 正常对话循环（模型可自行调用 write_memory / read_memory / select_memory）

  // 4. 一轮结束（end_turn）：抽取新记忆 + 达阈值则合并
  yield* perform({ type: 'ExtractMemories', input: { messages: preCompress } });
  yield* perform({ type: 'ConsolidateMemories', input: {} });
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
SelectMemory（真实 LLM 调用）
    │  选出相关文件名 → 读取正文 → 注入当前用户轮次
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
    │  end_turn
    ▼
ExtractMemories（真实 LLM 调用）
    │  从最近对话抽取 {name,type,description,body} → 写入磁盘
    ▼
ConsolidateMemories（文件数 ≥ 10 时，真实 LLM 调用）
    │  合并重复/淘汰过时 → 删旧写新
    ▼
下次会话：ReadMemory 读到索引 → SelectMemory 选中相关 → 注入上下文 → 用 Tab ✓
```

---

## 运行

```bash
npm run s09
```

默认 `AGENT_MODE=mock` 离线运行：mock 模型依次产出
`write_memory → select_memory → 收尾`，随后真实地执行
`extract（10 条）→ consolidate（11 → 3 条）`，最终在 `.memory/` 下
留下 `MEMORY.md` 与合并后的记忆文件。

用独立工作区运行并观察写入磁盘：

```bash
AGENT_WORKSPACE=$(mktemp -d) npm run s09
```

---

## 本章小结

**Memory Effect 是压缩之外的一层：它把不能被压缩掉的信息保存到文件系统，跨压缩、跨会话持久存在。**
其中 select / extract / consolidate 三条链路都以**真实 LLM 调用**为机制，mock 只替换模型本身，
因此离线教学与真实运行共享同一条实现。
