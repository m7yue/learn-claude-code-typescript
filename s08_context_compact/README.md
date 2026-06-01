# s08: Context Compact — 上下文是有界资源

[s07](../s07_skill_loading/) → [s08] → [s09](../s09_memory/) → s10 → ... → s20

---

## 第一性原理

**问题的本质**：对话历史是有界的，但任务是无界的。

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
// 主动压缩：LLM 或 Agent 主动要求压缩上下文
interface CompactEffect extends BaseEffect {
  type: 'Compact';
  input: { messages: Message[]; reason: string };
  output: Message[]; // 压缩后的消息列表
}

// 大输出持久化：将大内容写磁盘，返回路径引用
interface PersistOutputEffect extends BaseEffect {
  type: 'PersistOutput';
  input: { toolUseId: string; content: string };
  output: string; // "[已持久化到 /tmp/...]"
}
```

**四层压缩是 Handler 内部策略，Generator 只关心"消息列表是否合理"：**

| 层级 | 触发条件 | 策略 | 信息损失 |
|------|---------|------|---------|
| L1 SnipCompact | 消息数 > N | 保留头3 + 尾部，中间标记省略 | 中等 |
| L2 MicroCompact | 旧工具结果存在 | 替换为占位符 | 较小 |
| L3 PersistOutput | 单输出 > 阈值 | 落盘，消息里放路径 | 极小 |
| L4 AutoCompact | Token 超限 | LLM 生成历史摘要 | 较大但可控 |

| Python | 代数效应 TypeScript |
|--------|-------------------|
| `snip_compact(messages)` 函数 | L1 纯函数，在 Generator 里调用 |
| `micro_compact(messages)` 函数 | L2 纯函数，在 Generator 里调用 |
| `persist_large_output(...)` | `PersistOutput` Effect |
| `compact_history(messages)` | `Compact` Effect → L4 AutoCompact Handler |
| `reactive_compact()` 应急压缩 | Handler 捕获 prompt_too_long 错误 |

---

## 解决方案

### 压缩管道（每轮执行）

```typescript
function* agentLoop(perform: PerformFn<S08Effect>) {
  let messages: Message[] = [...];

  while (true) {
    // L1: 消息数过多 → Snip（纯函数，不需要 Effect）
    messages = snipCompact(messages);
    // L2: 旧工具结果 → 占位符（纯函数）
    messages = microCompact(messages);
    // L4: Token 超限 → LLM 生成摘要（需要 Effect，因为调用 LLM）
    if (estimateSize(messages) > CONTEXT_LIMIT) {
      messages = yield* perform({ type: 'Compact', input: { messages, reason: 'Token 超限' } });
    }

    const response = yield* perform({ type: 'Chat', input: { messages } });
    // ...

    // L3: 工具大输出 → 落盘
    if (rawOutput.length > PERSIST_THRESHOLD) {
      output = yield* perform({ type: 'PersistOutput', input: { toolUseId, content: rawOutput } });
    }
  }
}
```

---

## 工作原理

```
每轮循环开始
    │
    ▼
L1 snipCompact ─────────────────────────────────────► messages (消息数减少)
    │
    ▼
L2 microCompact ────────────────────────────────────► messages (旧结果变占位符)
    │
    ▼
estimateSize > limit?
  ├─ Yes → L4 Compact Effect → LLM 摘要 → messages (极度压缩)
  └─ No  → 继续
    │
    ▼
Chat（LLM 调用）
    │
    ▼
工具执行后：output.length > threshold?
  ├─ Yes → L3 PersistOutput → 落盘 → messages 里只有路径引用
  └─ No  → output 直接放入 messages
```

---

## 运行

```bash
npm run s08
```

---

## 本章小结

**上下文是有界资源，四层压缩是在信息损失和上下文空间之间取得平衡的策略。L1/L2 是纯函数转换，L3/L4 是 Effect——因为它们需要 I/O（磁盘读写和 LLM 调用）。**
