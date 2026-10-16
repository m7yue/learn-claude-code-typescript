# s05: TodoWrite — 计划本身是效应

[s04](../s04_hooks/) → [s05] → [s06](../s06_subagent/) → s07 → ... → s20

---

## 第一性原理

**问题的本质**：没有状态的 Agent 是健忘的。

一个 Agent 接到复杂任务，如果没有一个持久的计划，它很容易：
- 做到一半忘了下一步是什么
- 一件事反复做
- 上下文被压缩后，失去任务全貌

**根本原因**：LLM 的注意力是有限的，随着对话变长，早期的任务目标会被"稀释"。

**解法**：给 Agent 一个专用的计划工具，让当前任务状态显式存在于每一轮的上下文里——不靠记忆，靠数据结构。

---

## 问题

Agent 在处理多步骤任务时：

```
第1轮：列出目录 ✓
第2轮：读取配置文件 ✓
第3轮：... 忘了要写入结果吗？还是还有别的步骤？
```

没有明确的计划，Agent 每一步都在"猜"下一步是什么。对话越长，猜错的概率越高。

---

## 代数效应视角

引入两个 Effect：

```typescript
// 写计划（创建/更新任务列表）
interface TodoWriteEffect extends Effect<
  'TodoWrite',
  {
    todos: Array<{
      content: string;
      status: 'pending' | 'in_progress' | 'completed';
      activeForm: string;
    }>;
  },
  string // 确认消息
> {}

// 读计划（获取当前任务列表摘要）
interface TodoReadEffect extends Effect<
  'TodoRead',
  Record<string, never>,
  string // 格式化的任务列表
> {}
```

**唠叨提醒机制（反复催促）**：

这是本章最有趣的设计——如果 Agent 连续多轮没有调用 `TodoWrite`，系统自动注入一条提醒消息。

这个提醒消息本身也是一种效应输出，它不改变任何 Handler，只是在 `Chat` Handler 的消息列表里额外插入一条：

```
"[系统提醒] 你已经 3 轮没有更新任务列表了。如果在处理多步骤任务，请使用 todo_write 规划。"
```

| Python | 代数效应 TypeScript |
|--------|-------------------|
| `CURRENT_TODOS = []` 全局变量 | `TodoWrite` Handler 内部状态 |
| `rounds_since_todo` 计数器 | Generator 内部局部变量 |
| 注入提醒字符串到 messages | 修改 `Chat` 的 input.messages（在 Generator 里） |

---

## 解决方案

### TodoWrite Handler

```typescript
let currentTodos: TodoItem[] = [];

TodoWrite: async (effect: TodoWriteEffect) => {
  currentTodos = effect.input.todos;
  const summary = currentTodos
    .map(t => `[${t.status}] ${t.content}`)
    .join('\n');
  console.log(`[TodoWrite] 更新任务列表:\n${summary}`);
  return `已更新 ${currentTodos.length} 个任务`;
},
```

### 唠叨提醒（Generator 内部计数）

```typescript
function* agentLoop(perform: PerformFn<S05Effect>) {
  let roundsSinceTodo = 0;

  while (true) {
    // 超过3轮没更新计划，注入提醒
    if (roundsSinceTodo >= 3) {
      messages.push({
        role: 'user',
        content: '[系统提醒] 你已经多轮没有更新 todo_write 了。对于多步骤任务，请在开始前规划。',
      });
      roundsSinceTodo = 0;
    }

    const response = yield* perform({ type: 'Chat', input: { messages } });
    // ...

    // 如果模型调用了 todo_write，重置计数
    const calledTodo = toolBlocks.some(b => b.name === 'todo_write');
    roundsSinceTodo = calledTodo ? 0 : roundsSinceTodo + 1;
  }
}
```

---

## 工作原理

```
任务开始
    │
    ▼
┌─────────────────────────────────────────────┐
│           主循环                              │
│                                             │
│  roundsSinceTodo >= 3?                      │
│  └─ Yes → 注入唠叨提醒消息                   │
│                                             │
│  yield Chat → LLM 响应                      │
│                                             │
│  模型是否调用 todo_write?                    │
│  ├─ Yes → yield TodoWrite → roundsSinceTodo=0 │
│  └─ No  → roundsSinceTodo++                │
│                                             │
│  执行其他工具...                              │
└─────────────────────────────────────────────┘
```

---

## 运行

```bash
npm run s05
```

输出示例：
```
[S05] TodoWrite 启动

[Chat] → 发送 1 条消息...
[LLM]  ← stop_reason: tool_use, 工具: todo_write
[TodoWrite] 更新任务列表:
  ◑ [in_progress] 列出目录结构（列出目录结构中）
  ○ [pending] 读取配置文件
  ○ [pending] 生成报告
...
⏰ [系统提醒] 你已经 3 轮没有更新任务列表了。对于多步骤任务，请使用 todo_write 工具保持计划的可见性。
...
```

---

## 本章小结

**TodoWrite Effect 让"当前计划"成为 Agent 上下文的显式组成部分，而不是隐藏在对话历史的某个角落。唠叨提醒机制通过简单的计数器，在 Generator 层强制让计划保持最新。**
