# s16: Team Protocols — 协议是 Agent 间协作的效应约定

[s15](../s15_agent_teams/) → [s16] → [s17](../s17_autonomous_agents/)

---

## 第一性原理

**问题的本质**：消息传递（s15）解决了通信问题，但多 Agent 还需要一致的工作流程——谁有权做出决策？计划需要谁批准？如何优雅关闭？

协议 = 效应的有序状态机。每一步都有明确的前置条件、执行者和后置结果。

---

## 问题

```typescript
// 没有协议时，每个 Agent 各自为政
agentA.doTask();  // 没有审批流程
agentB.doTask();  // 没有状态追踪
// 结果：不知道谁在做什么，无法审计，无法关联请求和响应
```

---

## 代数效应视角

三个 Effect 构建端到端的协作协议：

```typescript
// 1. 请求计划 → 注册 ProtocolState(pending)
const plan = yield* perform({
  type: 'RequestPlan',
  input: { requestId: 'plan_001', goal: '重构认证模块', context: '...' }
});

// 2. 审查计划 → matchResponse(requestId) 关联，pending → fulfilled
const { approved, feedback } = yield* perform({
  type: 'ReviewPlan',
  input: { plan, reviewerId: 'senior_agent' }
});

// 3. 优雅关闭（需要协议确认）
const { acknowledged } = yield* perform({
  type: 'RequestShutdown',
  input: { agentId: 'main', reason: '任务完成' }
});
```

**关键洞见**：协议 = 强制执行的 Effect 顺序 + 请求-响应关联。`RequestPlan` 产生 `requestId`，`ReviewPlan` 通过 `matchResponse(requestId)` 验证，确保不存在孤立审查。

| Python ProtocolState | 代数效应 TypeScript |
|---------------------|-------------------|
| `ProtocolState(requestId, type, sender, target)` | `pendingRequests` Map + `ProtocolState` 接口 |
| `match_response(requestId, type)` | `matchResponse()` — 关联 + 类型验证 + 标记 fulfilled |
| `plan.status: pending → approved` | `storedPlan.status` 更新 |
| `shutdown_request_id` 生成 | `crypto.randomUUID()` |

---

## 工作原理

### ProtocolState：请求生命周期追踪

```typescript
interface ProtocolState {
  requestId: string;
  type: 'plan' | 'shutdown';
  sender: string;
  target: string;
  status: 'pending' | 'fulfilled';
  createdAt: number;
}

// 活跃协议请求注册表
const pendingRequests = new Map<string, ProtocolState>();
```

`RequestPlan` 写入 `pendingRequests`（status=pending），`ReviewPlan` 通过 `matchResponse` 验证并标记 fulfilled。这确保：
1. 不能审查一个不存在的计划请求
2. 不能重复审查同一计划（status 已 fulfilled）
3. 类型不匹配时拒绝（`plan` 请求不能被 `shutdown` 响应）

### matchResponse：请求-响应关联

```typescript
// 对应 CC 源码 protocol.ts 的 matchResponse()
function matchResponse(requestId: string, expectedType: 'plan' | 'shutdown'): ProtocolState | null {
  const req = pendingRequests.get(requestId);
  if (!req) return null;
  if (req.type !== expectedType) return null;
  if (req.status !== 'pending') return null;
  req.status = 'fulfilled';  // 原子标记
  return req;
}
```

### 协议状态流转

```
RequestPlan(requestId='plan_001') → pendingRequests['plan_001'] = { status: 'pending' }
            ↓
ReviewPlan(requestId='plan_001') → matchResponse → pending → fulfilled
            ↓（仅 approved 时继续）
执行任务（BashExec）
            ↓
RequestShutdown → 生成 shutdown requestId → 立即 fulfilled（无需二次审查）
```

---

## 相对 s15 的变更

| 组件 | 之前 (s15) | 之后 (s16) |
|------|-----------|-----------|
| 协作模式 | 信箱消息传递 | 有状态协议状态机 |
| 请求追踪 | 无 | `ProtocolState` + `pendingRequests` Map |
| 关联机制 | 无 | `requestId` + `matchResponse()` |
| 审批流程 | 无 | `RequestPlan` → `ReviewPlan` 顺序约束 |
| 关闭流程 | 无 | `RequestShutdown` + 宽限期 |
| 新工具函数 | — | `matchResponse` 关联验证 |

---

## 运行

```bash
npm run s16
```

---

## 本章小结

**协议 = Effect 序列约束 + 请求-响应关联。`ProtocolState` 追踪每个请求的生命周期（pending→fulfilled），`matchResponse(requestId, type)` 确保审查不能孤立存在，Generator 的 yield 顺序天然强制"先请求后审查"。协议将 Agent 协作从"自由消息传递"升级为"有状态工作流"。**

---

<details>
<summary>深入 CC 源码</summary>

> 以下基于 CC 源码 `protocol.ts`、`dispatch.ts`、`execute.ts` 的分析。

### 一、execute 门控机制

CC 中计划经审查后不是直接执行，而是先经过 `execute` 门控：

```typescript
// CC 伪代码
if (plan.status === 'approved') {
    executeGate.open(plan.requestId);  // 允许执行
} else {
    throw new ProtocolError('计划未批准，拒绝执行');
}
```

`execute` 门控确保即使 LLM 绕过 `RequestPlan`/`ReviewPlan` 直接发起 bash 等操作，也会被拦截。教学版信任 Generator 的调用顺序，不做门控。

### 二、dispatch 路由

CC 的 `dispatch.ts` 负责将协议消息路由到正确的 Agent：

- `RequestPlan` → 路由到 `planner` Agent 进程
- `ReviewPlan` → 路由到 `reviewer` Agent（可以是人类或另一个 Agent）
- `RequestShutdown` → 路由到 `coordinator`，由 coordinator 决定是否 acknowledged

教学版在 Handler 内直接模拟所有角色，不区分路由。

### 三、requestId 生成策略

CC 的 `requestId` 不由 LLM 生成（LLM 生成容易冲突或被篡改），而是由 Handler 在注册时生成（`uuid4()`），再通过工具结果返回给 LLM。LLM 后续调用时带上该 id。

教学版为演示清晰，允许 LLM 在 input 中传递 `requestId`（如 `plan_001`），Handler 直接使用。真实场景应由 Handler 生成。

### 四、协议消息类型

CC 支持约 15 种协议消息类型，远超教学版的 3 种：

| 类型 | 用途 |
|------|------|
| `request_plan` | 请求执行计划 |
| `review_plan` | 审查计划 |
| `request_shutdown` | 请求关闭 |
| `progress_update` | 进度汇报 |
| `error_report` | 错误上报 |
| `resource_request` | 申请资源（文件、工具） |
| `delegation_complete` | 子任务完成通知 |
| ... | 其余类型省略 |

### 教学版的简化

| 简化项 | 教学版 | CC |
|--------|--------|-----|
| execute 门控 | 无（信任 Generator 顺序） | `execute_gate` 拦截未授权执行 |
| dispatch 路由 | Handler 内模拟 | 真实跨进程消息路由 |
| requestId 生成 | LLM 传入 | Handler 生成，返回给 LLM |
| 协议类型数 | 3 | 约 15 种 |
| 超时处理 | 无 | pending 超过 TTL 自动 rejected |

</details>
