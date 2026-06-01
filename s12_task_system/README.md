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

四个任务 Effect 对应完整的状态机：

```
CreateTask  → pending（已创建，等待认领）
    ↓
ClaimTask   → in_progress（已认领，正在执行）
    ↓
CompleteTask → completed（已完成，触发下游解锁）
```

`blockedBy` 字段形成 DAG（有向无环图），`CompleteTask` 自动计算被解锁的下游任务：

```typescript
interface CreateTaskEffect extends BaseEffect {
  type: 'CreateTask';
  input: {
    subject: string;
    description: string;
    blockedBy?: string[];  // 依赖 task ID 列表
  };
  output: TaskRecord;
}
```

| Python Task dataclass | 代数效应 TypeScript |
|----------------------|-------------------|
| `Task(subject, description, blockedBy=[])` | `CreateTask` Effect |
| `task.status = 'in_progress'` | `ClaimTask` Effect（Handler 持久化写文件）|
| `task.status = 'completed'` | `CompleteTask` Effect（Handler 计算解锁列表）|
| `.tasks/{id}.json` 文件 | Handler 内部的 `fs.writeFileSync` |

---

## 解决方案

### 任务文件结构

```
/tmp/learn-claude-code-typescript/s12/tasks/
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

### 依赖解锁

```typescript
CompleteTask: async (effect) => {
  task.status = 'completed';
  saveTask(task);
  // 自动查找被解锁的下游任务
  const unblocked = allTasks.filter(t =>
    t.status === 'pending' &&
    t.blockedBy.includes(taskId) &&
    canStart(t.id)   // 所有依赖都已完成
  );
  return { task, unblocked };
}
```

---

## 工作原理

```
轮1: CreateTask × 3 → task_001 (pending), task_002 (pending), task_003 (pending)
轮2: ListTasks → 显示所有任务状态
轮3: ClaimTask(task_001) → in_progress
轮4: CompleteTask(task_001) → completed，通知解锁 task_002, task_003
轮5: 任务图持久化完成
```

---

## 运行

```bash
npm run s12
```

---

## 本章小结

**任务图 = 持久化到文件系统的效应状态。CreateTask/ClaimTask/CompleteTask 三个 Effect 构成完整状态机，blockedBy 形成 DAG，Handler 负责写文件和计算解锁关系，Generator 只做业务决策。**
