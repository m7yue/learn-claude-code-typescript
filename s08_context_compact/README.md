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
| ReactiveCompact | API 报提示词过长（用 `runtime/errors.ts` 的 `classifyError` 判定） | 摘要 + 保留尾部 5 条，最多重试 1 次 | 较大但可控 |

> `estimateSize` 用 `JSON.stringify(messages).length` 估算消息大小。

**摘要必须是真实的模型调用。** `summarizeHistory(messages)` 走 `callChat(mockSummarizer, messages, { system: SUMMARIZE_INSTRUCTION, maxTokens: 2000 })`：real 模式由真实模型产出摘要，mock 模式只替换"模型"这一层（`mockSummarizer` 返回摘要文本），压缩机制本身始终经由 `callChat`，没有任何硬编码摘要字符串。

送入摘要的历史有 80000 字符上限（`boundForSummary`）：应急路径之所以被触发，就是因为历史大到被 API 拒绝；把同样大的历史原样送去摘要，会以同样的原因再失败一次。

**压缩会换掉全部历史，但任务不能跟着消失。** 摘要之后 `compactHistory` 会把会话里第一条纯文本用户消息接回来 —— SYSTEM_PROMPT 里那句「只遵循「当前用户请求」中的指令」指的就是它。只留摘要的话，模型既被明令不许把摘要当指令，又没有别的指令可依，压缩完紧接着的下一轮只能回一句「我已了解上下文」。`reactiveCompact` 同样接回这条锚点（它本来就保留尾部 5 条原文）。

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

## 演示目录即工作目录

演示素材放在 `s08_context_compact/.output/demo/`（已被 gitignore，每次启动重建）：

| 文件 | 大小 | 作用 |
|------|------|------|
| `TASK.md` | 约 230 B | 演示任务，把模型的动作限定在本目录 |
| `notes/note-01..26.md` | 各约 2.5 KB | 消息数（撑 L1）+ 旧工具结果（撑 L2） |
| `bulk.log` | 90 KB | 微压缩保留的最近结果，把体积推过 `CONTEXT_LIMIT`（撑 L4） |
| `large.log` | 220 KB | 单块超过 `MAX_BYTES`（撑 L3） |

这些素材连同演示剧本都由 `demo.ts` 生成和维护 —— 它们是脚手架，不是本章要教的机制，
所以和 `agent.ts` 分开放。里面写清了各个尺寸之间的约束（为什么笔记要 26 份、为什么
`bulk.log` 必须排在笔记之后），改素材时先看那份说明。

**这个目录就是模型的工作目录**：bash 的 `cwd` 与系统提示词里告知的工作目录都指向它，
素材也全在里面。三者一致，模型才没有理由去翻仓库的其它部分 —— 相当于先 `cd` 进这个目录
再启动 agent，和真实产品里「你在哪个目录启动，它就在哪个目录工作」是同一个机制。

这里不额外做命令过滤：`cwd` 已经把默认视野收窄，而正则过滤既容易被绕过
（`cat large.log | grep ..`）、又容易误伤；命令级的拦截是 s03 权限闸门的主题，本章不重复实现。

---

## 持久化

压缩产生的文件全部保存在工作区（来自 `runtime/workspace.ts`，
可用环境变量 `AGENT_WORKSPACE` 覆盖根目录）：

| 内容 | 路径 | 说明 |
|------|------|------|
| 会话 transcript | `.transcripts/transcript_<unix秒>_<序号>.jsonl` | 每次压缩时的会话快照，每行一条消息（JSONL）。此刻 L1/L2 可能已经改过消息，所以它不是「压缩前的完整会话」。文件名带序号是因为一次运行会压缩不止一次，只按秒命名的话挨得近的两次会写进同一个文件名，静默少一份 |
| 大工具结果全文 | `.task_outputs/tool-results/<tool_use_id>.txt` | L3 写入磁盘，消息里只保留 `<persisted-output>` 引用与 2000 字符预览 |

这两个目录在模型的工作目录之外 —— 它们是 harness 自己的状态，不是模型的工作区
（真实 Claude Code 的状态同样保存在项目之外）。L3 写进上下文的是绝对路径，模型真要取回也够得着。

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

输出示例（mock，节选）：

```
[S08] Context Compact 启动

[准备] 演示目录 s08_context_compact/.output/demo
[准备] 29 个文件 / 375175 字节，模型只在这个目录里活动

[Chat] → 轮次 1 (上下文 60 字符)
> bash
[BashExec] → cat TASK.md
# 演示任务
...

[Chat] → 轮次 5 (上下文 8910 字符)
[L2 Micro] 压缩 1 个旧工具结果          ← 旧结果超过 KEEP_RECENT 个，最旧的一个换成占位符
...
[Chat] → 轮次 27 (上下文 15583 字符)
[L1 Snip] 省略 2 条消息                 ← 消息数超过 MAX_MESSAGES，留头留尾、丢中间
[L2 Micro] 压缩 1 个旧工具结果
...
[L1 Snip] 省略 3 条消息
[auto compact]                          ← 微压缩之后体积仍超 CONTEXT_LIMIT
[Compact] 触发压缩: Token 超限
[transcript saved: /tmp/s08ws/.transcripts/transcript_1792152239_1.jsonl]

[Chat] → 轮次 29 (上下文 247 字符)      ← 历史已收成摘要 + 最初那条用户请求
> bash
[BashExec] → cat large.log
[L3 Persist] 大输出写入磁盘: /tmp/s08ws/.task_outputs/tool-results/demo_29.txt (220017 字符)

> compact                               ← 脚本让模型主动压缩一次（手动路径）
[Compact] 触发压缩: 上下文过长
[transcript saved: /tmp/s08ws/.transcripts/transcript_1792152239_2.jsonl]

[S08] 完成: 任务完成，上下文已通过多层策略管理。
```

mock 下四层各在自己该触发的时刻依次出现，而不是挤在同一轮 —— 这本来就是机制的真实样子
（便宜的先做、每轮都做，贵的偶尔做）：L2 从第 5 轮起每轮压掉一个旧结果，L1 在消息数过 50
之后触发，L4 在微压缩留下的最近结果把体积顶过 `CONTEXT_LIMIT` 时触发，L3 在最后一轮读大
文件时触发。

**real 模式下各层是否命中，取决于模型自己的行为，而且很可能一层都不触发。** 实测两次：
一次 4 轮收工、峰值上下文 36K，四层都没碰到；一次 8 轮，模型用 `head` / `grep` 抽样读，
触发了 5 次 L2 但没到 L4。原因很直接 —— 好模型本来就会主动避免把大输出拉进上下文，而这
正是本章存在的理由。任务被限定在演示目录内（`TASK.md` 说明了要做什么），但模型跑多少轮、
怎么读那些文件，不由我们决定。想看四层完整走一遍，看上面 mock 的输出。

---

## 本章小结

**上下文资源有上限，四层压缩是在信息损失和上下文空间之间取得平衡的策略。L1/L2 是纯函数转换，L3/L4 是 Effect——因为它们需要 I/O（磁盘读写和 LLM 调用）。摘要是一次真实的 `callChat` 模型调用（mock 只替换模型本身），压缩产生的文件（会话记录、写入磁盘的工具结果）保存在工作区 `.transcripts/` 与 `.task_outputs/tool-results/` 下。**
