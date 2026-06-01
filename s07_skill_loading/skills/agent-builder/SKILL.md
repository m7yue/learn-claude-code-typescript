---
name: agent-builder
description: |
  设计和构建 AI Agent 系统。Use when users:
  (1) ask to "create an agent", "build an assistant", or "design an AI system"
  (2) want to understand agent architecture, agentic patterns, or autonomous AI
  Keywords: agent, assistant, autonomous, workflow, tool use, multi-step, orchestration
---

# Agent Builder Skill

帮助用户设计和实现具有特定功能的 AI Agent，包括工具集选择、上下文管理策略和错误处理。

## 设计流程

### 第一步：明确需求
- Agent 要解决什么问题？
- 需要访问哪些外部系统（文件、API、数据库）？
- 对话轮数预期？需要记忆吗？

### 第二步：确定工具集
根据需求选择最小工具集（避免过度授权）：
- 文件操作：read_file, write_file, edit_file
- 代码执行：bash
- 搜索：glob, grep
- 外部 API：根据需求定制

### 第三步：设计 System Prompt
```
你是 [角色描述]。
可用工具: [工具列表]
工作目录: [路径]
约束: [不能做什么]
```

### 第四步：错误恢复策略
- API 失败：指数退避重试
- 输出截断：升级 max_tokens 或续接
- 上下文过长：压缩历史

## 代数效应实现模板

```typescript
function* agentLoop(perform: PerformFn<MyEffect>) {
  const messages = [{ role: 'user', content: task }];
  while (true) {
    const response = yield* perform({ type: 'Chat', input: { messages } });
    if (response.stop_reason !== 'tool_use') return extractText(response);
    // 处理工具调用...
  }
}
```

## 输出

提供完整的 Agent 实现代码和配置说明。
