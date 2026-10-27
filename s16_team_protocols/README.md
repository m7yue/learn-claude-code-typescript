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

四个协议 Effect 构建端到端的协作协议。请求方真实等待响应，审批方校验状态后回发：

```typescript
// 1. Lead 请求计划：发普通 plan_request 提示，等队友把 plan_approval_request 送过来
const plan = yield* perform({
  type: 'RequestPlan',
  input: { goal: '重构认证模块', context: '升级到 OAuth 2.0，保持向后兼容' }
});
// plan.status === 'pending'
// plan.requestId / plan.planText 来自【队友一次真实 Chat 回合】提交的 plan_approval_request

// 2. 队友提交计划（队友循环调用）：
//    注册 ProtocolState(pending)，把完整计划作为 plan_approval_request 发给 Lead，
//    然后阻塞等待同 request_id 的 plan_approval_response
const submitted = yield* perform({
  type: 'SubmitPlan',
  input: { from: 'planner', plan: '1. ...\n2. ...\n3. ...' }
});
// submitted.outcome === 'approved' | 'rejected' | 'shutdown'

// 3. Lead 审批（Lead 循环调用）：
//    校验 request_id 是否为 pending 的 plan_approval，按计划步骤数判定；
//    先回发 plan_approval_response，发送成功后再用 settleResponse 落定
const { approved, feedback } = yield* perform({
  type: 'ReviewPlan',
  input: { requestId: plan.requestId, reviewerId: 'main' }
});

// 4. 优雅关闭：Lead 注册 pending，发送 shutdown_request，等待同 request_id 的 shutdown_response
const { acknowledged } = yield* perform({
  type: 'RequestShutdown',
  input: { agentId: 'planner', reason: '任务完成' }
});
```

**关键洞见**：协议 = 强制执行的 Effect 顺序 + 请求-响应关联。计划审批的 `requestId` 由队友的 `SubmitPlan` 产生，随 `plan_approval_request` 送到 Lead；Lead 的 `review_plan` 先回发 `plan_approval_response`，发送成功后再用 `settleResponse` 双校验并落定；发送失败时请求保持 pending，由等待方超时兜底。`submit_plan` 等到匹配响应才继续。关闭请求则由 Lead 的 `RequestShutdown` 产生 `requestId`。没有任何一步是"调用即成功"。

| Python ProtocolState | 代数效应 TypeScript |
|---------------------|-------------------|
| `ProtocolState(request_id, type, sender, target, status, payload)` | `pendingRequests` Map + `ProtocolState` 接口（`status: pending\|approved\|rejected`） |
| `match_response(response_type, request_id, approve)` | `settleResponse(responseType, requestId, approve)` — 校验 request_id + 响应类型 → 置 approved/rejected |
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
  payload: string;       // 计划文本或 shutdown reason
  createdAt: number;
}

const pendingRequests = new Map<string, ProtocolState>();
```

`SubmitPlan` / `RequestShutdown` 写入 `pendingRequests`（status=pending），响应到达后由 `settleResponse` 校验并落定。这确保：

1. 不能审查/确认一个不存在的请求（未知 `request_id`）
2. 不能重复处理同一请求（status 已非 pending）
3. 类型不匹配时拒绝（`plan_approval` 请求不能被 `shutdown_response` 关联）

### request_id 由 Handler 生成、经消息真实传递

计划审批的 request_id 由**队友侧**的 `SubmitPlan` Handler 生成：

```typescript
// 队友侧 SubmitPlan handler：由 Handler 生成 request_id（不由 LLM 决定）
const requestId = newRequestId('plan');          // 例如 plan_182681_1
pendingRequests.set(requestId, {
  type: 'plan_approval', sender: 'planner', target: 'main', status: 'pending', payload: plan, ...
});
await BUS.send('planner', 'main', plan, 'plan_approval_request', { request_id: requestId });
// ↑ 追加写 .mailboxes/s16/main.jsonl

// Lead 侧 RequestPlan：从 plan_approval_request 的 metadata 里读取同一个 request_id，
// 通过工具结果交给模型，再由模型调用 review_plan
const requestId = String(msg.metadata['request_id']);
```

关闭请求的 `request_id` 则由 Lead 的 `RequestShutdown` Handler 生成。

计划请求本身也有一个父 `request_id`：`RequestPlan` 发 `plan_request` 时带上它，队友的 `SubmitPlan` 把它回填到 `plan_approval_request.metadata.parent_request_id`；`RequestPlan` 只接受与本次父请求匹配的计划，迟到的旧计划会被拒绝，避免把上一次的提交当成当前请求的计划。

### settleResponse：请求-响应关联（双校验）

```typescript
function settleResponse(responseType: string, requestId: string, approve: boolean): void {
  const state = pendingRequests.get(requestId);
  if (!state) { log('unknown request_id'); return; }               // 孤立响应 → 拒绝
  if (responseType !== expectedResponseType(state.type)) {
    log('type mismatch'); return;                                  // 类型不匹配 → 拒绝
  }
  if (state.status !== 'pending') {
    log('already ..., ignoring duplicate'); return;                // 重复响应 → 忽略
  }
  state.status = approve ? 'approved' : 'rejected';                // 通过 → 落定
}
```

未知、错类型、重复的响应都会被**记录并拒绝**，不会被静默接受。调用方以 `pendingRequests` 里的状态为准，不直接采用重复响应的内容。

### 协议状态流转

```
Lead: request_plan(goal)
  → BUS.send(plan_request, 普通提示) ──→ planner 信箱

Planner: 读信箱 → 真实 Chat 回合生成计划 → submit_plan(plan)
  → SubmitPlan 注册 pendingRequests[req_id] =
      { type: 'plan_approval', sender: planner, target: main, payload: plan }
  → BUS.send(plan_approval_request, body=plan, metadata={request_id}) ──→ Lead 信箱
  → SubmitPlan 最多等一段时间，直到收到同 request_id 的 plan_approval_response

Lead: request_plan 命中 plan_approval_request → 返回 pending Plan
  （request_plan 已消费该消息；下一步直接调用 review_plan）
  → review_plan(request_id, reviewerId=main)
  → ReviewPlan 校验 pending → 按 pending.payload 的步骤数判定
  → BUS.send(plan_approval_response, body=feedback, metadata={request_id, approve}) ──→ planner 信箱
  → settleResponse('plan_approval_response', req_id, approved)
  （发送失败则保持 pending，由等待方超时兜底）

Planner: SubmitPlan 收到响应 → 按已落定状态继续/停止

Lead: request_shutdown(agentId) → pending … 等待 shutdown_response
  → planner 读信箱 → BUS.send(shutdown_response, metadata={request_id}) → 停止子循环
  → Lead 命中响应 → settleResponse → status: pending → approved
```

如果 `review_plan` 判定拒绝，这一轮协议以 `rejected` 结束；Lead 可以再次 `request_plan`，队友用新的 `parent_request_id` 提交修订计划，产生新的 `request_id` 并重新走审批。演示里第一次提交 2 步被拒，第二次提交 5 步获批。

任何一步响应缺席都会**在限定时间内反复查看，最终超时**：`RequestPlan` 返回 rejected（不注册 pending）；`SubmitPlan` 把仍 pending 的计划请求落为 rejected；`RequestShutdown` 把仍 pending 的关闭请求落为 rejected 并返回 acknowledged=false，而不是伪造成功。如果目标队友已经退出，`RequestPlan` / `RequestShutdown` 会立即返回失败，不会等满超时。

### 真实队友子循环

计划队友不是"调用时就返回预设固定回复"的定时器，而是一个独立的 `generator + runAgent` 子循环（复用 s15 模式）：

- 空闲时 `Idle` 等待 `BUS.waitForMessage`：信箱有新消息立即返回，超时后继续轮询
- 收到 `plan_request` → 注入历史 → 真实 Chat 回合（工具结果会继续送回模型）→ 调用 `submit_plan`（完整计划写进 `plan` 参数；`SubmitPlan` 阻塞等待 Lead 的 `plan_approval_response`）→ 批准后继续；被拒绝则回到空闲，等待下一次 `plan_request` 提交修订计划
- 收到 `shutdown_request` → 回 `shutdown_response`（带同一 request_id）后退出

Mock 只替换**模型调用**：协议状态机、信箱 I/O、request_id 关联全部是真实代码。

---

## 相对 s15 的变更

| 组件 | 之前 (s15) | 之后 (s16) |
|------|-----------|-----------|
| 协作模式 | 信箱消息传递 | 信箱 + 有状态协议状态机 |
| 请求追踪 | 无 | `ProtocolState` + `pendingRequests` Map |
| 关联机制 | 无 | `request_id` + `settleResponse(responseType, requestId, approve)` 双校验 |
| 协议工具 | 无 | Lead：`request_plan` / `review_plan` / `request_shutdown`；队友：`submit_plan` |
| 审批流程 | 无 | 队友 `submit_plan` 提交 → Lead `review_plan` 审批（真实判定，不是恒批准；演示里首次 2 步被拒，补充到 5 步后批准） |
| 关闭流程 | 无 | `request_shutdown` 注册 pending → 等 `shutdown_response`（不预兑现） |
| 计划内容 | 无 | 由队友 Chat 回合产出，经 `plan_approval_request` 送到 Lead，Lead 审批后回 `plan_approval_response` |
| 队友生命周期 | 最多 10 轮后退出 | 空闲轮询信箱，收到协议消息再工作/退出；工作轮仍有 10 轮上限 |
| 信箱目录 | `.mailboxes/s15/*.jsonl` | `.mailboxes/s16/*.jsonl`（启动只清空本章目录） |
| 真实模式等待 | 无协议等待（收尾 join 90s） | 按模式区分：mock 15s；real 空闲 10min、协议响应 5min |

---

## 运行

```bash
# mock 模式（显式设置，避免 .env 里的 AGENT_MODE=real 影响；只替换模型调用，协议/信箱全是真实代码）
AGENT_MODE=mock npx tsx s16_team_protocols/agent.ts
# 真实模型（--real，或 .env 里 AGENT_MODE=real）
npx tsx s16_team_protocols/agent.ts --real
```

说明：本章的信箱落在 `.mailboxes/s16/`，启动时只清空这个子目录。real 模式下队友空闲等待默认 10 分钟、协议响应默认 5 分钟，可用 `S16_IDLE_TIMEOUT_MS` / `S16_RESPONSE_TIMEOUT_MS` 覆盖；单轮输出默认 4096 tokens，可用 `S16_MAX_TOKENS` 调整。lead 的 `check_inbox` 默认先等活跃队友最多 500ms，可用 `waitMs` 覆盖。lead 结束后，宿主会通知仍在空闲等待的队友停止，最多再等 `S16_CLEANUP_WAIT_MS`（mock 1 秒 / real 3 秒）；如果队友正在一次模型请求里，进程可能还要等它完成。队友异常时会向 lead 的信箱写一条 `[teammate error]` result，并把该队友记入失败集合，最终退出码为 1；如果目标已经退出，`request_plan` / `request_shutdown` 会立即返回失败，不会等满超时。

Mock 输出末尾：

```
[Protocol] 协议请求汇总:
  plan_xxx: type=plan_approval planner→main [rejected]
  plan_yyy: type=plan_approval planner→main [approved]
  shutdown_zzz: type=shutdown main→planner [approved]

[S16] 协议演示结果: 协议流程演示完成：请求计划 → 队友提交 → Lead 拒绝 → 重新提交 → Lead 审批 → 执行 → 关闭确认。
[S16] 完成
```

---

## 本章小结

**协议 = Effect 序列约束 + 请求-响应关联。`ProtocolState` 追踪每个请求的生命周期（pending→approved/rejected），`settleResponse(responseType, requestId, approve)` 同时校验响应类型与请求 ID，确保审查不能孤立存在。计划内容由队友的真实 Chat 回合产出，经 `plan_approval_request` 送到 Lead；Lead 的 `review_plan` 先回发 `plan_approval_response`，发送成功后再落定；`submit_plan` 等到匹配响应才继续。拒绝也是一次完整的落定：演示里第一次 2 步计划被拒，Lead 重新请求后队友提交 5 步计划才获批。关闭请求在收到匹配响应前始终保持 pending——协议把 Agent 协作从"自由消息传递"升级为"有状态工作流"。**

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

教学版的 `request_plan` / `request_shutdown` 把目标写为队友的 mailbox id（本仓 `spawn_teammate` schema 只有 `agentId/role`，无独立 target 字段），消息经真实 `.mailboxes/s16/*.jsonl` 投递，由队友子循环读取。

### 三、requestId 生成策略

CC 的 `requestId` 不由 LLM 生成（LLM 生成容易冲突或被篡改），而是由 Handler 在注册时生成（`uuid4()`），再通过消息元数据传给对端；对端调用响应工具时带上该 id。

教学版与之一致：计划审批的 id 由队友的 `SubmitPlan` Handler 用 `newRequestId()` 生成，写入 `metadata.request_id` 随 `plan_approval_request` 发给 Lead；Lead 的 `ReviewPlan` 用该 id 回发 `plan_approval_response`。关闭请求的 id 由 Lead 的 `RequestShutdown` Handler 生成。

### 四、协议消息类型

CC 支持约 15 种协议消息类型，远超教学版的 4 种协议消息（`plan_approval_request` / `plan_approval_response` / `shutdown_request` / `shutdown_response`；`plan_request` 只是普通提示消息）：

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
| requestId 生成 | 队友 `SubmitPlan` / Lead `RequestShutdown` 的 Handler 生成 | Handler 生成，返回给 LLM |
| 协议类型数 | 4 | 约 15 种 |
| 超时处理 | 在限定时间内反复查看直到超时 → rejected / acknowledged=false | 待处理超过时限自动 rejected |

</details>
