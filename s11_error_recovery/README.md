# s11: Error Recovery — 错误是效应的另一种输出

[s10](../s10_system_prompt/) → [s11] → [s12](../s12_task_system/) → ... → s20

---

## 第一性原理

**问题的本质**：LLM API 并不稳定，会因为过载、限速、输出被截断等原因失败。但 Agent 的任务不能因为一次 API 失败就中断。

错误有三种根本类型：
- **临时性过载**（429/529）— 等一会儿就好，指数退避
- **输出截断**（max_tokens）— 内容超出限制，需要升级配额或续接
- **输入过长**（prompt_too_long）— 上下文太大，需要压缩后重试

每一种都有确定的恢复策略，关键是让恢复逻辑留在业务层（Generator），而不是在基础设施层（Handler）。

---

## 问题

```python
# Python 版：恢复逻辑混入了主循环
while True:
    try:
        response = client.messages.create(...)
    except RateLimitError:
        time.sleep(retry_delay)  # 副作用内嵌业务逻辑
        continue
```

恢复策略（等多久？切换什么模型？）是业务决策，不应该在 API 调用层做出。

---

## 代数效应视角

引入 `RetryWithBackoff` 和 `SwitchModel` Effect：

```typescript
// 恢复决策在 Generator（业务层）
} catch (error) {
  if (error instanceof RateLimitError) {
    // 声明"要退避"，不关心具体等多久
    yield* perform({ type: 'RetryWithBackoff', input: { attempt, errorType: '429' } });
    // 自动继续循环重试
  } else if (error instanceof MaxTokensError) {
    // 声明"要升级 token 限制"
    maxTokens = ESCALATED_MAX_TOKENS;
    // 继续用新配置重试
  }
}

// 实际等待逻辑在 Handler（基础设施层）
RetryWithBackoff: async (effect) => {
  const delay = calculateBackoff(effect.input.attempt);
  await sleep(delay);
}
```

**关键洞见**：`catch` 块内的 `yield* perform()` = Generator 可以在错误恢复过程中继续声明效应，实现纯函数式的错误处理。

| Python RecoveryState | 代数效应 TypeScript |
|---------------------|-------------------|
| `RecoveryState.RATE_LIMITED` | Generator `catch` 块中 `yield* perform(RetryWithBackoff)` |
| `RecoveryState.MAX_TOKENS` | `maxTokens = ESCALATED_MAX_TOKENS` + 继续循环 |
| `RecoveryState.PROMPT_TOO_LONG` | 压缩 messages + 继续循环 |

---

## 三条恢复路径

### Path 1: max_tokens 超限

```
LLM → MaxTokensError
  ↓
  first time: maxTokens = 64000（升级）
  after that: 续接（append partial + "Resume directly"）
  ↓
  重新调用 LLM（新配置）
```

### Path 2: prompt 过长

```
LLM → PromptTooLongError
  ↓
  保留最近 5 条消息，丢弃中间历史
  ↓
  重新调用 LLM（压缩后的上下文）
```

### Path 3: 429/529 过载

```
LLM → RateLimitError / OverloadedError
  ↓
  yield* perform(RetryWithBackoff)  ← 等待指数退避
  ↓
  连续 529 → yield* perform(SwitchModel)  ← 切换备用模型
  ↓
  重新调用 LLM
```

---

## 运行时架构注意事项

`runAgent()` 中 `agent.throw(error)` 返回值的处理至关重要：

```typescript
catch (error) {
  const { value, done } = agent.throw(error);
  if (done) return value as TReturn;
  // 必须处理 Generator 在 catch 块中 yield 的新 effect
  // 不能等到下一轮 agent.next()，那会跳过这个 effect
  lastResult = await handler(value as E);
}
```

这是代数效应系统支持"在错误恢复中继续声明效应"的关键实现细节。

---

## 运行

```bash
npm run s11
```

---

## 本章小结

**错误恢复路径 = Generator 在 catch 块内继续 yield 效应。RetryWithBackoff 和 SwitchModel 将等待时长和模型选择从业务逻辑中分离，让 Agent 的恢复策略成为可测试的纯函数声明。**
