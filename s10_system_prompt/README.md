# s10: System Prompt — 提示词运行时组装

[s09](../s09_memory/) → [s10] → [s11](../s11_error_recovery/) → s12 → ... → s20

---

## 第一性原理

**问题的本质**：不同时刻的 Agent 需要不同的上下文，但硬编码的 system prompt 是静态的。

早期章节的 `SYSTEM` 常量在程序启动时就固定了。但实际运行中：
- 有没有记忆？有多少？→ 记忆片段要不要包含？
- 当前在做什么任务？→ 任务片段要不要包含？
- 哪些工具是激活的？→ 工具片段需要更新

如果把所有可能用到的内容都放进 system prompt，就浪费 token；如果只放固定内容，就缺失上下文。

**解法**：system prompt 在运行时组装，每轮根据当前状态动态生成，并用结果稳定的缓存避免重复工作。

---

## 问题

```typescript
// 静态 system prompt：永远一样，无论当前状态如何
const SYSTEM = `你是一个编码助手。运行环境：类 Unix 系统：bash 工具运行系统 shell。
可用工具：bash、read_file、write_file、todo_write、load_skill...
工作目录：/project
记忆：（空——但不知道何时有记忆）`;
```

---

## 代数效应视角

引入 `AssemblePrompt` Effect：

```typescript
interface AssemblePromptEffect extends Effect<
  'AssemblePrompt',
  { context: PromptContext },
  string // 组装好的 system prompt
> {}

interface PromptContext {
  enabledTools: string[];
  workspace: string;
  memories?: string;    // 有记忆时才包含
  activeTask?: string;  // 有活跃任务时才包含
}
```

**Handler 内部有缓存**：

```typescript
AssemblePrompt: async (effect) => {
  const key = JSON.stringify(effect.input.context, sortedKeys);
  if (key === lastKey) {
    console.log('✓ 缓存命中');
    return lastPrompt;
  }
  const prompt = assemble(effect.input.context);
  lastKey = key;
  lastPrompt = prompt;
  return prompt;
},
```

| Python | 代数效应 TypeScript |
|--------|-------------------|
| `PROMPT_SECTIONS = { 'identity': '...', 'tools': '...' }` | 同名常量，Handler 内部 |
| `assemble_system_prompt(context)` | `AssemblePrompt` Effect 触发 Handler |
| `get_system_prompt(context)` — 带缓存 | Handler 内部的 `lastKey` / `lastPrompt` |
| `update_context(context, messages)` | Generator 内部更新 context 对象 |
| `_last_context_key` / `_last_prompt` | Handler 内部状态（副作用层持有） |

---

## 解决方案

### 提示词片段库

```typescript
const PROMPT_SECTIONS = {
  identity: `你是一个编码助手。直接行动，不要过多解释。运行环境：${ENVIRONMENT_PROMPT}。`,
  tools: (tools: string[]) => `可用工具：${tools.join('、')}`,
  workspace: (ws: string) => `工作目录：${ws}`,
  memory: (mem: string) => `记忆：\n${mem}`,
  task: (task: string) => `当前任务：${task}`,
};
```

### 每轮组装

```typescript
function* agentLoop(perform: PerformFn<S10Effect>) {
  let context: PromptContext = { enabledTools: [...], workspace: '...' };

  while (true) {
    // 每轮组装（或命中缓存）
    const systemPrompt = yield* perform({ type: 'AssemblePrompt', input: { context } });

    const response = yield* perform({ type: 'Chat', input: { messages, systemPrompt } });
    // ...

    // 下一轮可能更新 context（如获得了记忆、启动了新任务）
    context = { ...context, activeTask: '...' };
  }
}
```

---

## 工作原理

```
轮次 1：context = { tools: [...], workspace: '...' }
    │
    AssemblePrompt → 缓存 miss → 组装 [identity, tools, workspace]
    │
    LLM 调用...
    │
轮次 2：context 不变（相同任务）
    │
    AssemblePrompt → 缓存 HIT → 直接返回上次结果
    │
    节省字符串拼接开销；保持 system prompt 稳定本身也有价值——
    将来接服务端 prompt cache 时，前缀不变才可能命中（本章只做本地缓存）
    │
轮次 3：context 若变化（例如填入 memories / activeTask）
    │
    AssemblePrompt → 缓存 miss → 组装 [identity, tools, workspace, memory, task]
    │
    （本章演示里 context 始终只有 tools 与 workspace，这一步不会发生；
      memory / task 片段是备好的能力，见 assemblePrompt 里的条件包含）
```

---

## 运行

```bash
npm run s10
```

---

## 本章小结

**AssemblePrompt Effect 让 system prompt 从静态字符串变为运行时计算的结果，根据当前上下文动态包含或排除片段。缓存确保相同上下文不重复计算，也稳定了 Anthropic API 的 prompt cache。**
