# s16: Team Protocols — 协议是 Agent 间协作的效应约定

[s15](../s15_agent_teams/) → [s16] → [s17](../s17_autonomous_agents/)

---

## 第一性原理

**问题的本质**：消息传递（s15）解决了通信问题，但多 Agent 还需要一致的工作流程——谁有权做出决策？计划需要谁批准？如何优雅关闭？

协议 = 效应的有序状态机。每一步都有明确的前置条件、执行者和后置结果。请求与响应必须能被**精确关联**（`request_id`），否则无法区分"谁在回复哪一个请求"。

---

## 问题

```typescript
// 没有协议时，每个 Agent 各自为政
agentA.doTask();  // 没有审批流程
agentB.doTask();  // 没有状态追踪
// 结果：不知道谁在做什么，无法审计，无法关联请求和响应
```

更隐蔽的坏做法：把计划写死在 Handler 里、审查函数恒返回批准、关闭请求一调用就装作已确认。这些"假协议"没有任何状态机，无法拒绝非法响应。

---

## 代数效应视角

三个协议 Effect 构建端到端的协作协议。注意它们都是**真实等待响应**的：

```typescript
// 1. 请求计划：注册 ProtocolState(pending)，通过信箱发给队友，
//    然后有界轮询自己的信箱，直到收到同 request_id 的 plan_approval_response
const plan = yield* perform({
  type: 'RequestPlan',
  input: { goal: '重构认证模块', context: '升级到 OAuth 2.0，保持向后兼容' }
});
// plan.steps 来自【队友一次真实 Chat 回合】写回的消息，而非 Handler 硬编码

// 2. 审查计划（由审查队友的循环调用）：
//    校验 request_id 是否为 pending 的 plan_approval，做真实判定，回发响应
const { approved, feedback } = yield* perform({
  type: 'ReviewPlan',
  input: { requestId: plan.requestId, reviewerId: 'reviewer', planText: '...' }
});

// 3. 优雅关闭：注册 pending，发送 shutdown_request，等待同 request_id 的 shutdown_response
const { acknowledged } = yield* perform({
  type: 'RequestShutdown',
  input: { agentId: 'reviewer', reason: '任务完成' }
});
```

**关键洞见**：协议 = 强制执行的 Effect 顺序 + 请求-响应关联。`RequestPlan` 产生 `requestId`，响应经信箱回流，`matchResponse(requestId, type)` 双校验后才把状态从 `pending` 落为 `approved` / `rejected`。没有任何一步是"调用即成功"。

| Python ProtocolState | 代数效应 TypeScript |
|---------------------|-------------------|
| `ProtocolState(request_id, type, sender, target, status, payload)` | `pendingRequests` Map + `ProtocolState` 接口（`status: pending\|approved\|rejected`） |
| `match_response(response_type, request_id, approve)` | `matchResponse()` — 校验 request_id + 响应类型 → 置 approved/rejected |
| `pending_requests: dict[str, ProtocolState]` | `pendingRequests: Map<string, ProtocolState>` |
| `BUS.send(..., metadata={request_id})` | `SendMessage` Effect 携带 `metadata.request_id`（真实 JSONL 信箱） |
| Teammate idle loop | `teammateLoop` generator + `Idle` Effect 真轮询信箱 |

---

## 工作原理

### ProtocolState：请求生命周期追踪

```typescript
interface ProtocolState {
  requestId: string;
  type: 'plan_approval' | 'shutdown';
  sender: string;
  target: string;
  status: 'pending' | 'approved' | 'rejected';
  payload: string;       // plan goal 或 shutdown reason
  createdAt: number;
}

const pendingRequests = new Map<string, ProtocolState>();
```

`RequestPlan` / `RequestShutdown` 写入 `pendingRequests`（status=pending），响应到达后由 `matchResponse` 校验并落定。这确保：

1. 不能审查/确认一个不存在的请求（未知 `request_id`）
2. 不能重复处理同一请求（status 已非 pending）
3. 类型不匹配时拒绝（`plan_approval` 请求不能被 `shutdown_response` 关联）

### request_id 由 Handler 生成、经消息真实传递

```typescript
// RequestPlan handler：由 Handler 生成 request_id（不由 LLM 决定）
const requestId = newRequestId('plan');          // 例如 plan_182681_1
pendingRequests.set(requestId, { type: 'plan_approval', status: 'pending', ... });
await BUS.send('main', 'reviewer', goal, 'plan_request', { request_id: requestId });
// ↑ 追加写 .mailboxes/reviewer.jsonl

// 队友侧：从收到的 inbox 消息里【真实提取】request_id，再用它调用 review_plan
const requestId = findRequestId(messages);       // 解析注入的 <inbox> JSON
```

### matchResponse：请求-响应关联（双校验）

```typescript
function matchResponse(responseType: string, requestId: string, approve: boolean) {
  const state = pendingRequests.get(requestId);
  if (!state) return log('unknown request_id');                    // 孤立响应 → 拒绝
  if (responseType !== expectedResponseType(state.type))
    return log('type mismatch');                                   // 类型不匹配 → 拒绝
  if (state.status !== 'pending')
    return log('already ..., ignoring duplicate');                 // 重复响应 → 忽略
  state.status = approve ? 'approved' : 'rejected';                // 通过 → 落定
}
```

未知、错类型、重复的响应都会被**记录并拒绝**，不会被静默接受（入口处有负向自检演示这三条分支）。

### 协议状态流转

```
Lead: request_plan(goal)
  → pendingRequests[req_id] = { type: 'plan_approval', status: 'pending' }
  → BUS.send(plan_request, metadata={request_id}) ──→ reviewer 信箱

Reviewer: 读信箱 → 真实 Chat 回合生成计划 → review_plan(request_id, reviewerId)
  → 校验 request_id 存在且 pending → 按计划步骤数判定
  → BUS.send(plan_approval_response, metadata={request_id, approve}) ──→ Lead 信箱

Lead: 有界轮询信箱 → 命中同 request_id 的响应 → matchResponse
  → status: pending → approved / rejected   （approved 才继续执行）

Lead: request_shutdown(agentId) → pending … 等待 shutdown_response
  → teammate 读信箱 → BUS.send(shutdown_response, metadata={request_id}) → 停止子循环
  → Lead 命中响应 → matchResponse → status: pending → approved
```

任何一步响应缺席都会**在限定次数内反复查看，最终超时**（`pollForResponse`），返回 rejected / acknowledged=false，而不是伪造成功。

### 真实队友子循环

审查队友不是"调用时就返回预设固定回复"的定时器，而是一个独立的 `generator + runAgent` 子循环（复用 s15 模式）：

- 空闲时 `Idle` 真等待 / 轮询自己的 `.mailboxes/reviewer.jsonl`
- 收到 `plan_request` → 注入历史 → 一次真实 Chat 回合 → 调用 `review_plan` 工具
- 收到 `shutdown_request` → 回 `shutdown_response`（带同一 request_id）后退出

Mock 只替换**模型调用**：协议状态机、信箱 I/O、request_id 关联全部是真实代码。

---

## 相对 s15 的变更

| 组件 | 之前 (s15) | 之后 (s16) |
|------|-----------|-----------|
| 协作模式 | 信箱消息传递 | 信箱 + 有状态协议状态机 |
| 请求追踪 | 无 | `ProtocolState` + `pendingRequests` Map |
| 关联机制 | 无 | `request_id` + `matchResponse(responseType, requestId)` 双校验 |
| 审批流程 | 无 | `request_plan` → 队友 `review_plan` 响应（真实判定，不是恒批准） |
| 关闭流程 | 无 | `request_shutdown` 注册 pending → 等 `shutdown_response`（不预兑现） |
| 计划内容 | 无 | 由队友 Chat 回合产出，经 `plan_approval_response` 消息回流 |
| 队友生命周期 | 最多 10 轮后退出 | 空闲轮询信箱，收到协议消息再工作/退出 |

---

## 运行

```bash
# 默认离线（mock 只替换模型调用；协议/信箱全是真实代码）
AGENT_MODE=mock npx tsx s16_team_protocols/agent.ts
# 真实模型
npx tsx s16_team_protocols/agent.ts --real
```

Mock 输出末尾：

```
[Protocol] 协议请求汇总:
  plan_xxx: type=plan_approval main→reviewer [approved]
  shutdown_xxx: type=shutdown main→reviewer [approved]

[Protocol] 负向自检 (match_response 拒绝孤立/错类型/重复响应):
  [protocol] unknown request_id: req_does_not_exist
  [protocol] type mismatch: expected shutdown_response, got plan_approval_response
  [protocol] shutdown ✗ (req_probe: rejected)
  [protocol] req_probe already rejected, ignoring duplicate
[S16] 完成
```

---

## 本章小结

**协议 = Effect 序列约束 + 请求-响应关联。`ProtocolState` 追踪每个请求的生命周期（pending→approved/rejected），`matchResponse(responseType, requestId)` 同时校验响应类型与请求 ID，确保审查不能孤立存在。计划内容由队友的真实 Chat 回合产出并经信箱回流，关闭请求在收到匹配响应前始终保持 pending——协议把 Agent 协作从"自由消息传递"升级为"有状态工作流"。**

---

<details>
<summary>深入 CC 源码</summary>

> 以下基于 CC 源码 `protocol.ts`、`dispatch.ts`、`execute.ts` 的分析。

### 一、execute 检查关机制

CC 中计划经审查后不是直接执行，而是先经过 `execute` 检查关：

```typescript
// CC 伪代码
if (plan.status === 'approved') {
    executeGate.open(plan.requestId);  // 允许执行
} else {
    throw new ProtocolError('计划未批准，拒绝执行');
}
```

`execute` 检查关确保即使 LLM 绕过 `RequestPlan`/`ReviewPlan` 直接发起 bash 等操作，也会被拦截。教学版信任 Generator 的调用顺序，不做检查关。

### 二、dispatch 路由

CC 的 `dispatch.ts` 负责将协议消息路由到正确的 Agent：

- `RequestPlan` → 路由到 `planner` Agent 进程
- `ReviewPlan` → 路由到 `reviewer` Agent（可以是人类或另一个 Agent）
- `RequestShutdown` → 路由到 `coordinator`，由 coordinator 决定是否 acknowledged

教学版的 `request_plan` / `request_shutdown` 把目标写为队友的 mailbox id（本仓 `spawn_teammate` schema 只有 `agentId/role`，无独立 target 字段），消息经真实 `.mailboxes/*.jsonl` 投递，由队友子循环读取。

### 三、requestId 生成策略

CC 的 `requestId` 不由 LLM 生成（LLM 生成容易冲突或被篡改），而是由 Handler 在注册时生成（`uuid4()`），再通过消息元数据传给对端；对端调用响应工具时带上该 id。

教学版与之一致：`RequestPlan` / `RequestShutdown` 的 Handler 用 `newRequestId()` 生成 id，写入 `metadata.request_id`；队友从收到的 inbox 消息里真实提取该 id 再调用 `review_plan`。

### 四、协议消息类型

CC 支持约 15 种协议消息类型，远超教学版的 4 种（`plan_request` / `plan_approval_response` / `shutdown_request` / `shutdown_response`）：

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
| execute 检查关 | 无（信任 Generator 顺序） | `execute_gate` 拦截未授权执行 |
| dispatch 路由 | 单进程内共享 `pendingRequests` + 真实 mailbox 投递 | 真实跨进程消息路由 |
| requestId 生成 | Handler 生成（与 CC 一致） | Handler 生成，返回给 LLM |
| 协议类型数 | 4 | 约 15 种 |
| 超时处理 | 在限定次数内反复查看直到超时 → rejected / acknowledged=false | 待处理超过时限自动 rejected |

</details>
