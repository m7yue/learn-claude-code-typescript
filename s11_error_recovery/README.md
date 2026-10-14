# s11: Error Recovery — 错误是效应的另一种输出

[s10](../s10_system_prompt/) → [s11] → [s12](../s12_task_system/) → ... → s20

---

## 第一性原理

**问题的本质**：LLM API 并不稳定，会因为过载、限速、输出被截断等原因失败。但 Agent 的任务不能因为一次 API 失败就中断。

错误有三种根本类型：
- **临时性过载**（429/529）— 等一会儿就好，每次等待时间翻倍再重试
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
  // 按字符串分类（name / message / status），与真实 SDK 抛出的错误类型对齐
  if (classifyError(error) === 'rate_limit') {
    // 声明"要退避"，不关心具体等多久
    yield* perform({ type: 'RetryWithBackoff', input: { attempt, errorType: '429' } });
    // 自动继续循环重试
  }
}

// max_tokens 不是异常，而是响应字段：在成功响应后判断
if (response.stop_reason === 'max_tokens') {
  maxTokens = ESCALATED_MAX_TOKENS; // 升级 token 上限，用新配置重试
}

// 实际等待逻辑在 Handler（基础设施层）
RetryWithBackoff: async (effect) => {
  const delay = retryDelayMs(effect.input.attempt);
  await sleep(delay);
}
```

**关键洞见**：`catch` 块内的 `yield* perform()` = Generator 可以在错误恢复过程中继续声明效应，实现纯函数式的错误处理。

**为什么用字符串分类而不是 `instanceof`**：真实 Anthropic SDK 抛出的是 `RateLimitError` / `InternalServerError` / `APIError` 等原生类型，教学里的自定义异常类永远不会命中。只有 `runtime/errors.ts` 的 `classifyError()`（匹配错误的类型名 + 小写消息）才能同时覆盖 SDK 原生错误与脚本化错误。

| Python RecoveryState | 代数效应 TypeScript |
|---------------------|-------------------|
| `429/529` 临时错误 | `catch` 块中 `yield* perform(RetryWithBackoff)` |
| `stop_reason == "max_tokens"` | `maxTokens = ESCALATED_MAX_TOKENS` + 继续循环 |
| `prompt_too_long` | 压缩 messages + 继续循环 |
| 连续 529 过载 | 连续 `MAX_CONSECUTIVE_529=3` 次后 `yield* perform(SwitchModel)` |

---

## 三条恢复路径

### Path 1: max_tokens 超限

```
LLM → response.stop_reason == "max_tokens"（不是异常！）
  ↓
  first time: maxTokens = 64000（升级，不追加截断输出，重试同一请求）
  after that: 续接（append partial + "Resume directly"，最多 3 次）
  ↓
  重新调用 LLM（新配置）
```

### Path 2: prompt 过长

```
LLM → classifyError(error) == "prompt_too_long"（按消息字符串分类）
  ↓
  保留最近 5 条消息，前面插入一条 "[Reactive compact] ..." 合成 user 消息
  ↓
  重新调用 LLM（压缩后的上下文，仅一次）
```

### Path 3: 429/529 过载

```
LLM → classifyError(error) == "rate_limit" / "overloaded"
  ↓
  yield* perform(RetryWithBackoff)  ← 指数退避 + 随机延时（base 500ms，cap 32s，最多 10 次）
  ↓
  连续 3 次 529 → yield* perform(SwitchModel)  ← 切换到 env FALLBACK_MODEL_ID
                                                  （real 模式未配置则继续重试并打印日志；
                                                   mock 模式给演示默认值以便离线可达）
  ↓
  成功即重置 consecutive529；重新调用 LLM（新模型）
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

默认 `AGENT_MODE=mock` 离线运行，mock 只替换「模型调用」这一步（按调用序号抛出真实形状的错误
或返回真实形状的响应）；错误分类、等待重试、模型切换、max_tokens 处理全部走真实代码路径：

| 调用 | mock 行为 | 触发的恢复路径 |
|------|-----------|---------------|
| 1 | `Error(status=429)` | Path 3a 等待后重试 |
| 2–4 | `Error(status=529)` ×3 | Path 3b 连续 529 → `SwitchModel` |
| 5 | `stop_reason=max_tokens` | Path 1 升级 8000 → 64000 |
| 6 | `Error("prompt is too long ...")` | Path 2 字符串分类 → 应急压缩 |
| 7 | `stop_reason=tool_use` (bash) | 工具执行 |
| 8 | `stop_reason=end_turn` | 完成 |

mock 模式把等待时长按 `MOCK_DELAY_SCALE` 压缩，真实公式（base 500ms、cap 32s）保持不变。

---

## 本章小结

**错误恢复路径 = Generator 在 catch 块内继续 yield 效应。RetryWithBackoff 和 SwitchModel 将等待时长和模型选择从业务逻辑中分离，让 Agent 的恢复策略成为可测试的纯函数声明。**
