# s06: Subagent — 效应作用域隔离

[s05](../s05_todo_write/) → [s06] → [s07](../s07_skill_loading/) → s08 → ... → s20

---

## 第一性原理

**问题的本质**：上下文污染。

当主 Agent 处理复杂任务时，它的消息历史（`messages[]`）会积累大量中间步骤。如果把一个子任务完全在主 Agent 的上下文里执行，那子任务的每一个工具调用、每一条中间输出都会永远留在历史里。

随着任务增多，历史变长，模型的注意力被分散——它需要在茫茫历史中找到当前任务的相关信息。有用信息被大量无关内容淹没，性能随之下降。

**解法**：为子任务创建一个**隔离的效应域**——独立的消息历史，独立的工具集，独立的循环。子任务完成后，只把最终结论带回主 Agent，中间过程全部丢弃。

---

## 问题

主 Agent 遇到一个需要多步骤才能完成的子任务（如"分析这10个文件，给我一个摘要"）。如果在主上下文里直接做：

```
主 Agent 历史 = [
  用户问题,
  分析文件1的工具调用,
  文件1的内容,          ← 噪声
  分析文件2的工具调用,
  文件2的内容,          ← 噪声
  ... (10个文件的所有中间步骤)
  最终摘要
]
```

全部噪声永久污染主上下文。

---

## 代数效应视角

引入 `Delegate` Effect：

```typescript
interface DelegateEffect extends Effect<
  'Delegate',
  {
    task: string;           // 子任务描述
    maxRounds?: number;     // 最大轮数（防止无限循环）
  },
  string           // 子 Agent 的最终结论
> {}
```

**Delegate Handler = 一个完整的 `runAgent()` 调用**：

```typescript
Delegate: async (effect: DelegateEffect) => {
  // 子 Agent 有全新的消息历史
  const subMessages: Message[] = [{ role: 'user', content: effect.input.task }];

  // 在隔离的效应域里运行
  const result = await runAgent(createSubAgent(subMessages), subHandlers);

  // 只返回最终结论，中间过程不带回
  return result;
},
```

| Python | 代数效应 TypeScript |
|--------|-------------------|
| `spawn_subagent(description)` | `yield* perform({ type: 'Delegate', input: { task } })` |
| `sub_messages = [{"role": "user", "content": description}]` | `subMessages = [{ role: 'user', content: task }]` |
| `while True:` 嵌套循环 | `runAgent(subFactory, subHandlers)` — 复用同一驱动器 |
| `最多 30 轮` 硬编码 | `maxRounds` 参数（默认 10，由主 Agent 传入） |
| 只返回 `extract_text(response)` | `return result` — 最终文本 |

**隔离的含义**：
- **消息历史**：子 Agent 从空开始，主 Agent 历史不可见
- **工具集**：子 Agent 可以有限制的工具（不能再 spawn 子 Agent，防止无限递归）
- **轮数限制**：防止子任务无限运行

---

## 解决方案

### 子 Agent 工厂

```typescript
function createSubAgentFactory(task: string, maxRounds: number) {
  return function* (perform: PerformFn<SubEffect>) {
    const messages: Message[] = [{ role: 'user', content: task }];
    let rounds = 0;

    while (rounds < maxRounds) {
      const response = yield* perform({ type: 'Chat', input: { messages } });
      // ... 工具执行逻辑（与主 Agent 相同，但没有 Delegate 工具）
      rounds++;
      if (response.stop_reason !== 'tool_use') break;
    }

    return extractFinalResult(messages);
  };
}
```

### 主 Agent 只看到结论

```typescript
// 主 Agent Generator
function* agentLoop(perform: PerformFn<S06Effect>) {
  // 委派子任务
  const summary = yield* perform({
    type: 'Delegate',
    input: { task: '分析 package.json，告诉我有哪些依赖', maxRounds: 5 },
  });
  // summary 是子 Agent 的最终结论，子任务的所有中间步骤已丢弃
}
```

---

## 工作原理

```
主 Agent 上下文（保持干净）
┌──────────────────────────────────────────┐
│  用户: "分析依赖，然后给我写一份报告"      │
│                                          │
│  yield Delegate("分析依赖")              │──┐
│                                          │  │
│  ◄── "依赖: tsx@4.x, typescript@5.x"  ◄─│──┘
│                                          │    子 Agent 域（完全隔离）
│  yield BashExec("生成报告...")            │  ┌──────────────────────┐
│  ...                                     │  │  子消息历史:         │
└──────────────────────────────────────────┘  │  [用户任务]          │
                                              │  [读文件工具调用]    │
                                              │  [文件内容]          │
                                              │  [分析结论]   ◄──返回│
                                              └──────────────────────┘
```

---

## 运行

```bash
npm run s06
```

输出示例：
```
[S06] Subagent 启动

[主] Chat → 轮次 1
[主] LLM ← tool_use, 工具: task

--- 子 Agent 启动: "读取 package.json 并列出所有依赖项" ---
  [子] Chat → 轮次 1
  [子] LLM ← tool_use, 工具: read_file
  [子] ReadFile → ./package.json
  [子] Chat → 轮次 2
  [子] LLM ← end_turn
--- 子 Agent 完成 ---
[主] 收到子任务结论: "依赖分析完成：项目使用 tsx 和 typescript 作为开发依赖。..."

[主] Chat → 轮次 2
[主] LLM ← end_turn
```

---

## 本章小结

**Delegate Effect = 在一个新的效应域里运行子 Generator，只把最终输出带回。这是"上下文隔离"的代数效应表达：副作用在子域处理完，主域只看到干净的结论。**
