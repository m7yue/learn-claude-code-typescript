# s01: Agent Loop — 一个驱动器就够了

[s01] → [s02](../s02_tool_use/) → s03 → s04 → ... → s20

> *"One loop is all you need."* — 一个驱动器 + 一个效应 = 一个 Agent。

---

## 第一性原理

**问题的本质**：大语言模型是一个**函数**。

```
f(context) → next_token*
```

它不主动做任何事情。你给它输入，它给你输出，然后停止。

如果你想让它"执行"某件事，你必须：
1. 拿到它的输出
2. 自己去执行
3. 把结果喂回去
4. 再问一次

这个循环，就是 Agent 的全部本质。

---

## 问题

你向模型提问："帮我列出当前目录的所有文件。"

模型输出：`ls -la`

然后呢？模型停了。它不会自己跑这条命令，也不会看到结果后继续推理。

你手动跑一遍，把输出粘贴回对话，让它接着干。下一条命令出来，你再跑一遍、再贴回去。

**每一个来回，你都在扮演"驱动器"的角色。** 把它自动化，就是这章要做的事。

---

## 代数效应视角

在代数效应系统中，这个"驱动 LLM 并执行工具"的过程被分解为两层：

**声明层（业务逻辑）**：描述"要做什么"
```typescript
function* agentLoop(perform: PerformFn<S01Effect>) {
  // 声明：我需要和 LLM 对话
  const response = yield* perform({ type: 'Chat', input: { messages } });

  // 声明：我需要执行一个 bash 命令
  const output = yield* perform({ type: 'BashExec', input: { command: '...' } });
}
```

**实现层（Handler）**：定义"怎么做"
```typescript
const handlers = {
  Chat: async (effect) => callAnthropicAPI(effect.input.messages),
  BashExec: async (effect) => execSync(effect.input.command).toString(),
};
```

**驱动层（runAgent）**：连接两者
```typescript
await runAgent(agentLoop, handlers);
```

| Python | 代数效应 TypeScript |
|--------|-------------------|
| `client.messages.create(...)` | `yield* perform({ type: 'Chat', ... })` |
| `run_bash(command)` | `yield* perform({ type: 'BashExec', ... })` |
| `while True:` | `runAgent()` 内部的 `while (true)` |
| `stop_reason != "tool_use"` | `generator.done === true` |
| `messages.append(result)` | `generator.next(result)` |

核心洞见：**`stop_reason == "tool_use"` 和 Generator 的 `done === false` 是同一件事的两种表达。** 模型"举手"要工具，等价于 Generator yield 了一个效应还没完成。

---

## 解决方案

### Effect 定义

本章引入两个效应：

```typescript
// 效应1：与 LLM 对话
interface ChatEffect extends BaseEffect {
  type: 'Chat';
  input: { messages: Message[] };
  output: LLMResponse;    // 返回完整响应（含 stop_reason 和工具调用）
}

// 效应2：执行 bash 命令
interface BashExecEffect extends BaseEffect {
  type: 'BashExec';
  input: { command: string };
  output: string;          // 命令输出
}
```

### Agent 业务逻辑

```typescript
function* agentLoop(perform: PerformFn<S01Effect>) {
  while (true) {
    // 声明：与 LLM 对话
    const response = yield* perform({ type: 'Chat', input: { messages } });
    messages.push({ role: 'assistant', content: extractText(response) });

    // LLM 说"我做完了" → 退出（等价于 stop_reason != "tool_use"）
    if (response.stop_reason !== 'tool_use') return;

    // 声明：逐个执行工具
    const toolResults = [];
    for (const block of getToolUseBlocks(response)) {
      const output = yield* perform({ type: 'BashExec', input: { command: block.input.command } });
      toolResults.push({ tool_use_id: block.id, content: output });
    }

    // 将结果喂回对话
    messages.push({ role: 'user', content: JSON.stringify(toolResults) });
  }
}
```

### Handler 实现

```typescript
const handlers = {
  // Mock：模拟 LLM 的响应脚本
  Chat: async (effect) => mockLLMScript(effect.input.messages),

  // 真实：执行 bash 命令
  BashExec: async (effect) => {
    const { command } = effect.input;
    return execSync(command, { encoding: 'utf8' });
  },
};
```

---

## 工作原理

```
用户问题
    │
    ▼
┌─────────────────────────────────────────┐
│           runAgent() 驱动循环            │
│                                         │
│  ┌──────────────────────────────────┐   │
│  │     agentLoop Generator         │   │
│  │                                  │   │
│  │  yield Chat ──────────────────► │──►│ Chat Handler
│  │  ◄── LLMResponse ◄──────────── │◄──│ (mock LLM)
│  │                                  │   │
│  │  stop_reason == 'tool_use'?      │   │
│  │  ├─ No  → return (结束)          │   │
│  │  └─ Yes → continue              │   │
│  │                                  │   │
│  │  yield BashExec ─────────────► │──►│ BashExec Handler
│  │  ◄── string output ◄─────────  │◄──│ (execSync)
│  │                                  │   │
│  │  喂回对话，回到顶部               │   │
│  └──────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

**两个退出信号**：

| 信号 | 含义 | 动作 |
|------|------|------|
| `stop_reason == 'tool_use'` | 模型要执行工具 | 执行 → 喂回 → 继续 |
| `stop_reason != 'tool_use'` | 模型完成任务 | Generator return → runAgent 返回 |

---

## 运行

```bash
npm run s01
```

输出示例：
```
[S01] Agent Loop 启动
[Chat] → 发送 1 条消息...
[LLM]  ← stop_reason: tool_use
[BashExec] → ls -la
[BashExec] ← (文件列表)
[Chat] → 发送 3 条消息...
[LLM]  ← stop_reason: end_turn
[S01] 完成：total 8 ... README.md ...
```

---

## 本章小结

**Agent Loop = 一个 Generator 不断 yield 效应，runAgent() 不断将效应路由到 Handler，直到 Generator done。**

这个结构从 s01 到 s20 保持不变。所有新机制都是新 Effect 类型 + 新 Handler，核心循环永远是同一个 `runAgent()`。
