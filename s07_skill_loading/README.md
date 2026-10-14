# s07: Skill Loading — 知识按需加载

[s06](../s06_subagent/) → [s07] → [s08](../s08_context_compact/) → s09 → ... → s20

---

## 第一性原理

**问题的本质**：知识加载有成本，不该一次性全部加载。

LLM 的每个 token 都有代价——上下文长度决定推理速度和费用。如果把所有可能用到的知识（代码审查指南、MCP 构建文档、PDF 导出说明...）全部放进 system prompt，你就在为"也许用不到的知识"支付固定成本。

**最优策略**：只把"知识目录"（名称+描述）放进 system prompt，让模型在需要时按需加载完整内容。

---

## 问题

随着 Agent 能力增加，知识库也在增长。如果：

```typescript
const SYSTEM = `
你是编码助手。

代码审查指南：
[2000 个 token 的完整指南...]

MCP 构建文档：
[1500 个 token 的完整文档...]

PDF 导出说明：
[800 个 token 的说明...]
`;
```

即使当前任务只需要代码审查，你也在为所有知识支付 4300 个 token 的固定成本。

---

## 代数效应视角

**双层知识加载**是本章的核心模式：

```
Layer 1（轻量，始终存在）
  ListSkills Effect → 返回：[{ name, description }, ...]
  注入 system prompt：每个技能 ~20 token

Layer 2（按需，较重）
  LoadSkill Effect → 返回：完整 SKILL.md 内容
  仅在模型决定"我需要这个技能"时触发
```

| Python | 代数效应 TypeScript |
|--------|-------------------|
| `_scan_skills()` 扫描目录，`_parse_frontmatter()` 解析元数据 | `ListSkills` Handler 实现同样逻辑 |
| `SKILL_REGISTRY = { name: { description, content } }` | Handler 内部的注册表 |
| `load_skill(name)` 工具返回完整内容 | `LoadSkill` Effect → Handler 返回完整 Markdown |
| 安全校验：只接受注册的技能名，不接受文件路径 | Handler 做同样的校验（只接受已注册的技能名） |

---

## 解决方案

### 两个 Effect

```typescript
interface ListSkillsEffect extends Effect<
  'ListSkills',
  Record<string, never>,
  Array<{ name: string; description: string }>
> {}

interface LoadSkillEffect extends Effect<
  'LoadSkill',
  { name: string },
  string // 完整 Markdown 内容
> {}
```

### Agent 启动时的知识目录注入

```typescript
function* agentLoop(perform: PerformFn<S07Effect>) {
  // Layer 1：一次性获取所有技能目录
  const skills = yield* perform({ type: 'ListSkills', input: {} });
  const skillDir = skills.map(s => `- ${s.name}: ${s.description}`).join('\n');

  const systemPrompt =
    baseSystemPrompt() + "\n\n" + `可用技能：\n${skillDir}\n\n当某个技能适用时，用 load_skill 读取完整说明。`;

  // Layer 2 在循环里按需触发
  while (true) {
    const response = yield* perform({ type: 'Chat', input: { messages, systemPrompt } });
    // 当 LLM 调用 load_skill 时，才真正加载完整内容
    if (block.name === 'load_skill') {
      output = yield* perform({ type: 'LoadSkill', input: { name: block.input.name } });
    }
  }
}
```

---

## 工作原理

```
Agent 启动
    │
    ▼
ListSkills → [{ name: 'code-review', description: '代码质量审查...' }, ...]
    │
    ▼
注入 system prompt（~60 token，不含完整内容）
    │
    ▼
┌─────────────────────────────────────────────┐
│  主循环                                      │
│                                             │
│  LLM: "我需要代码审查指南"                   │
│  → 调用 load_skill("code-review")           │
│                                             │
│  LoadSkill Effect → Handler 返回完整内容     │
│  (~2000 token，只在需要时才出现)             │
│                                             │
│  LLM 获得完整知识，执行任务                   │
└─────────────────────────────────────────────┘
```

---

## 运行

```bash
npm run s07
```

输出示例：
```
[S07] Skill Loading 启动

[ListSkills] 发现 3 个技能:
  - agent-builder: 设计和构建 AI Agent 系统...
  - code-review: 对代码进行全面的质量审查...
  - mcp-builder: 构建 MCP（Model Context Protocol）服务器...

[Chat] → 轮次 1
[System] 包含技能目录 (642 字符)
[LLM]  ← tool_use, 工具: list_skills
...
[LoadSkill] 加载技能: code-review (568 字符，来自文件)
...
```

---

## 本章小结

**ListSkills + LoadSkill 构成双层知识加载：目录（轻量）始终在 system prompt 里，完整内容（较重）按需通过 Effect 注入。这是"知识即效应"的典型应用。**
