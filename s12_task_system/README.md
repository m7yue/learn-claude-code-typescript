# s12: Task System — 任务图是持久化效应状态

[s11](../s11_error_recovery/) → [s12] → [s13](../s13_background_tasks/) → ... → s20

---

## 第一性原理

**问题的本质**：Agent 的工作不是单一的、线性的。实际项目包含多个相互依赖的任务，需要追踪状态、协调顺序、在重启后恢复进度。

内存中的变量在进程重启后消失。要让任务系统可靠，任务状态必须持久化——每个任务就是一个文件。

---

## 问题

```python
# 没有任务系统时，Agent 的"计划"只存在于消息历史
messages = [
  {"role": "user", "content": "做步骤1，然后步骤2，然后步骤3"}
]
# 问题：进程崩溃后重启，不知道做到哪一步了
```

---

## 代数效应视角

五个任务 Effect：三个构成写状态机，两个是只读查询。

```
CreateTask  → pending（已创建，等待认领）
    ↓
ClaimTask   → in_progress（已认领，正在执行；依赖未完成则拒绝）
    ↓
CompleteTask → completed（已完成，触发下游解锁）

ListTasks / GetTask → 只读，直接从磁盘读出当前任务图
```

`blockedBy` 字段形成依赖图（有向无环图），`CompleteTask` 自动计算被解锁的下游任务：

```typescript
interface CreateTaskEffect extends Effect<
  'CreateTask',
  {
    subject: string;
    description: string;
    blockedBy?: string[];  // 依赖 task ID 列表
  },
  TaskRecord
> {}

// claim/complete 会「拒绝」非法操作，因此返回可读结果而不是抛异常：
type ClaimResult = { ok: true; task: TaskRecord } | { ok: false; error: string };
```

| Python Task dataclass | 代数效应 TypeScript |
|----------------------|-------------------|
| `Task(subject, description, blockedBy=[])` | `CreateTask` Effect |
| `task.status = 'in_progress'` | `ClaimTask` Effect（Handler 真实读写文件 + 依赖检查）|
| `task.status = 'completed'` | `CompleteTask` Effect（Handler 计算解锁列表）|
| `list_tasks()` / `get_task(id)` | `ListTasks` / `GetTask` Effect（Handler 扫描 `.tasks/`）|
| `.tasks/{id}.json` 文件 | Handler 内部的 `fs.readFileSync` / `fs.writeFileSync` |

---

## 解决方案

### 任务文件结构

任务写在**工作区**（`process.cwd()`，可用 `AGENT_WORKSPACE` 覆盖）下的 `.tasks/`，
路径由 `runtime/workspace.ts` 的 `TASKS_DIR` 提供：

```
<workspace>/.tasks/
  task_1700000001_1234.json  ← 每个任务一个文件
  task_1700000001_5678.json
```

```json
{
  "id": "task_1700000001_1234",
  "subject": "初始化项目",
  "description": "安装依赖，配置环境",
  "status": "completed",
  "owner": "agent",
  "blockedBy": []
}
```

启动时**不清理**任务目录，只统计已有任务；因此进程重启后任务图会从磁盘恢复：

```
任务目录: <workspace>/.tasks
已有任务: 3 个（重启后从磁盘恢复）
```

### 依赖解锁

`complete` 先写入磁盘，再扫描全部任务，找出「依赖该任务、且此刻所有依赖都已完成」的待处理下游：

```typescript
function completeTask(taskId: string): CompleteResult {
  const task = loadTask(taskId)!;      // 从磁盘读
  if (task.status !== 'in_progress') return { ok: false, error: ... };
  task.status = 'completed';
  saveTask(task);                      // 真实写文件
  const unblocked = listTasks().filter(t =>
    t.status === 'pending' &&
    t.blockedBy.length > 0 &&
    canStart(t.id)                     // blockedBy 全部存在且 completed
  );
  return { ok: true, task, unblocked };
}
```

---

## 工作原理

mock 只替代「模型调用」；文件读写和依赖检查都是真实代码。脚本化模型先从
`create_task` 的 tool_result 里学到运行时生成的 ID，再用这些真实 ID 构造依赖图：

```
轮0: CreateTask(初始化项目)=A, CreateTask(实现核心功能)=B   → A,B pending
轮1: CreateTask(编写测试, blockedBy=[A,B])=C               → C pending 且被阻塞
轮2: ListTasks                                             → 显示三个节点与依赖
轮3: GetTask(C)                                            → 读出 C 的完整 JSON
轮4: ClaimTask(C)  → 拒绝: "Blocked by: A, B"             ← 依赖检查生效
轮5: ClaimTask(A), ClaimTask(B)                            → A,B in_progress
轮6: CompleteTask(A), CompleteTask(B)                      → 完成 B 时 C 被解锁
轮7: ClaimTask(C)  → 成功                                  → C in_progress
轮8: CompleteTask(C)                                       → C completed
```

第二次在同一个 `AGENT_WORKSPACE` 运行时，`.tasks/` 不会被清空：
启动日志会显示上一轮遗留的任务，证明任务图确实从磁盘恢复。

---

## 运行

```bash
# 默认 mock，离线运行（在 <workspace>/.tasks/ 下留下真实任务文件）
npm run s12

# 用独立工作区隔离副作用
AGENT_WORKSPACE=/tmp/s12-demo npm run s12
```

---

## 本章小结

**任务图 = 持久化到文件系统的效应状态。CreateTask/ClaimTask/CompleteTask 三个 Effect 构成完整状态机，ListTasks/GetTask 提供只读视图；blockedBy 形成依赖图，Handler 负责真实读写文件和计算解锁/阻塞关系，Generator 只做业务决策。进程重启即从 `.tasks/` 恢复，不依赖任何内存状态。**
