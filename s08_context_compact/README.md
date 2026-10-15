# s08: Context Compact — 上下文是有上限的资源

[s07](../s07_skill_loading/) → [s08] → [s09](../s09_memory/) → s10 → ... → s20

---

## 第一性原理

**问题的本质**：对话历史有上限，但任务没有上限。

LLM 的上下文窗口有上限（128K、200K token）。随着对话进行，消息历史不断积累：工具调用、文件内容、中间步骤……最终会超过上限。

**根本矛盾**：要完成长任务，需要长历史；但长历史会超出上下文窗口。

**解法**：多层压缩策略，在信息损失最小的前提下，将历史压缩到可接受范围。

---

## 问题

不加任何管理，50 轮对话后：

```
messages = [
  { role: 'user', content: '用户问题' },
  { role: 'assistant', content: '模型回答' },
  { role: 'user', content: '[工具结果: 5000 字符的文件内容]' },
  ... × 50
]

估算大小: ~200,000 字符 → 超出上下文窗口
```

---

## 代数效应视角

本章新增两个 Effect：

```typescript
// 主动/应急压缩：LLM 或 Agent 主动要求压缩上下文
interface CompactEffect extends Effect<
  'Compact',
  { messages: Message[]; reason: string; reactive?: boolean },
  Message[] // 压缩后的消息列表
> {}

// 大输出持久化：将大内容写磁盘，返回路径引用
interface PersistOutputEffect extends Effect<
  'PersistOutput',
  { toolUseId: string; content: string },
  string // "<persisted-output>…Full output: .task_outputs/tool-results/<id>.txt…"
> {}
```

**四层压缩是 Handler 内部策略，Generator 只关心"消息列表是否合理"。四层按「先做便宜的」排列（budget → snip → micro → auto）：**

| 层级 | 触发条件 | 策略 | 信息损失 |
|------|---------|------|---------|
| L3 ToolResultBudget | 最后一条消息的工具结果总量 > `MAX_BYTES=200000` 时，其中单块 > `PERSIST_THRESHOLD=30000` | 全文写入磁盘 `.task_outputs/tool-results/<id>.txt`，消息里只放路径引用 | 极小 |
| L1 SnipCompact | 消息数 > `MAX_MESSAGES=50` | 保留头 3 + 尾部，中间标记省略（不劈开 tool_use/tool_result 配对） | 中等 |
| L2 MicroCompact | 工具结果块数 > `KEEP_RECENT=3` | 较早、内容 > 120 字符的块替换为占位符 | 较小 |
| L4 AutoCompact | `estimateSize > CONTEXT_LIMIT=50000` | **真实 LLM 调用**（`callChat`）生成历史摘要 | 较大但可控 |
| ReactiveCompact | API 返回 `prompt_too_long` | 摘要 + 保留尾部 5 条，最多重试 1 次 | 较大但可控 |

> `estimateSize` 用 `JSON.stringify(messages).length` 估算消息大小。

**摘要必须是真实的模型调用。** `summarizeHistory(messages)` 走 `callChat(mockSummarizer, messages, { system: SUMMARIZE_INSTRUCTION, maxTokens: 2000 })`：real 模式由真实模型产出摘要，mock 模式只替换"模型"这一层（`mockSummarizer` 返回摘要文本），压缩机制本身始终经由 `callChat`，没有任何硬编码摘要字符串。

| Python | 代数效应 TypeScript |
|--------|-------------------|
| `snip_compact(messages)` 函数 | L1 纯函数，在 Generator 里调用 |
| `micro_compact(messages)` 函数 | L2 纯函数，在 Generator 里调用 |
| `persist_large_output(...)` | `PersistOutput` Effect |
| `compact_history(messages)` | `Compact` Effect → L4 AutoCompact Handler |
| `reactive_compact()` 应急压缩 | Generator 捕获 prompt_too_long → `Compact(reactive)` Effect |

---

## 解决方案

### 压缩管道（每轮执行）

```typescript
function* agentLoop(perform: PerformFn<S08Effect>) {
  let messages: Message[] = [...];

  while (true) {
    // L3: 大工具结果 → 写入磁盘（需要 I/O → Effect），消息里替换为路径引用
    for (const item of planPersists(messages)) {
      const reference = yield* perform({ type: 'PersistOutput', input: item });
      applyPersist(messages, item.toolUseId, reference);
    }
    // L1: 消息数过多 → Snip（纯函数，不需要 Effect）
    messages = snipCompact(messages);
    // L2: 旧工具结果 → 占位符（纯函数）
    messages = microCompact(messages);
    // L4: Token 超限 → 真实 LLM 摘要（需要 Effect，因为调用模型）
    if (estimateSize(messages) > CONTEXT_LIMIT) {
      messages = yield* perform({ type: 'Compact', input: { messages, reason: 'Token 超限' } });
    }

    const response = yield* perform({ type: 'Chat', input: { messages } });
    // ... compact 工具命中时同样触发 Compact Effect（summary 走 callChat）
  }
}
```

---

## 工作原理

```
每轮循环开始
    │
    ▼
L3 ToolResultBudget ─────────────────────────────────► 大结果写入磁盘，messages 里只有路径引用
    │
    ▼
L1 snipCompact ─────────────────────────────────────► messages (消息数减少)
    │
    ▼
L2 microCompact ────────────────────────────────────► messages (旧结果变占位符)
    │
    ▼
estimateSize > limit?
  ├─ Yes → L4 Compact Effect → 真实 LLM 摘要 (callChat) → messages (极度压缩)
  └─ No  → 继续
    │
    ▼
Chat（LLM 调用）
    │
    ├─ 成功 → 追加 assistant；compact 工具命中 → Compact Effect（写 transcript + 摘要）
    └─ prompt_too_long 且未超重试 → Reactive Compact → 摘要 + 保留尾部
```

---

## 持久化

压缩产生的文件全部保存在工作区（来自 `runtime/workspace.ts`，
可用环境变量 `AGENT_WORKSPACE` 覆盖根目录）：

| 内容 | 路径 | 说明 |
|------|------|------|
| 会话 transcript | `.transcripts/transcript_<unix秒>.jsonl` | 压缩前完整会话，每行一条消息（JSONL） |
| 大工具结果全文 | `.task_outputs/tool-results/<tool_use_id>.txt` | L3 写入磁盘，消息里只保留 `<persisted-output>` 引用与 2000 字符预览 |

---

## 运行

```bash
# 默认离线 mock：mock 只替换"模型"本身，压缩/摘要链路仍走 callChat
npm run s08

# 真实模型（需 .env 中的 token / MODEL_ID）
AGENT_MODE=real npm run s08

# 隔离副作用以便检查写入磁盘的文件
AGENT_WORKSPACE=/tmp/s08ws npm run s08
```

演示启动时会先在 `s08_context_compact/.output/` 下建一个约 220KB 的 `large.log`（已被 gitignore）。
第 5 轮的 `cat` 读的就是它——大输出是真的大输出，L3 落盘也是真的。

---

## 本章小结

**上下文资源有上限，四层压缩是在信息损失和上下文空间之间取得平衡的策略。L1/L2 是纯函数转换，L3/L4 是 Effect——因为它们需要 I/O（磁盘读写和 LLM 调用）。摘要是一次真实的 `callChat` 模型调用（mock 只替换模型本身），压缩产生的文件（会话记录、写入磁盘的工具结果）保存在工作区 `.transcripts/` 与 `.task_outputs/tool-results/` 下。**
