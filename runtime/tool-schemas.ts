/**
 * 工具注册表 —— 全仓工具元数据的单一真源。
 *
 * 只在 real 模式下使用：把工具能力（name / description / input_schema）告诉真实模型，
 * 让它能发起 tool_use。mock 模式完全不读这个文件，因此不影响零配置运行。
 *
 * 章节（sXX/agent.ts）与工程层（src/）都从这里取 schema：
 *   - 章节：schemasFor('bash', ...)   → callChat 的 tools
 *   - 工程层：specFor(name) → ToolDefinition.parameters
 *
 * 命名统一采用「动词优先」的章节拼写（create_task / check_inbox / todo_write ...）。
 * 参数以各章 mockLLM 发出的 tool_use.input 与 switch 实际读取的 key 为准。
 */

import type { ToolSchema } from "./model.ts";

function schema(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
): ToolSchema {
  return {
    name,
    description,
    input_schema: { type: "object", properties, required },
  };
}

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });
const bool = (description: string) => ({ type: "boolean", description });
const arr = (
  description: string,
  items: Record<string, unknown> = { type: "string" },
) => ({ type: "array", description, items });

export const TOOL_SPECS: Record<string, ToolSchema> = {
  bash: schema(
    "bash",
    "在工作区内执行一个安全 shell 命令；可选后台执行或在指定 worktree 中执行。",
    {
      command: str("要执行的命令"),
      run_in_background: bool("（可选）在后台线程执行，立即返回任务 id"),
      worktreeId: str("（可选）在哪个 worktree 中执行"),
    },
    ["command"],
  ),
  read_file: schema(
    "read_file",
    "读取工作区内文件内容。",
    { path: str("文件路径"), limit: int("（可选）最多读取的行数") },
    ["path"],
  ),
  write_file: schema(
    "write_file",
    "写入文件内容（覆盖）。",
    { path: str("文件路径"), content: str("文件内容") },
    ["path", "content"],
  ),
  edit_file: schema(
    "edit_file",
    "用精确匹配替换文件中的一段文本。",
    { path: str("文件路径"), old_text: str("待替换文本"), new_text: str("替换为") },
    ["path", "old_text", "new_text"],
  ),
  glob: schema("glob", "按 glob 模式查找文件。", { pattern: str("glob 模式") }, ["pattern"]),
  todo_write: schema(
    "todo_write",
    "写入/更新待办列表（覆盖式）。",
    {
      todos: arr("待办项列表", {
        type: "object",
        properties: {
          content: { type: "string" },
          status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          activeForm: { type: "string" },
        },
        required: ["content", "status", "activeForm"],
      }),
    },
    ["todos"],
  ),
  todo_read: schema("todo_read", "读取当前待办列表。"),
  task: schema("task", "把子任务委派给子代理。", { task: str("子任务描述") }, ["task"]),
  list_skills: schema("list_skills", "列出可用技能。"),
  load_skill: schema("load_skill", "按名称加载技能内容。", { name: str("技能名称") }, ["name"]),
  compact: schema(
    "compact",
    "主动压缩上下文并保留摘要。",
    { reason: str("压缩原因") },
    ["reason"],
  ),
  // read_memory / write_memory 同时服务 s09 与 s20 两套方言：无公共 key，
  // 因此取超集且 required 为空——对真实模型是宽松 schema（见设计文档「歧义与处理」）。
  read_memory: schema(
    "read_memory",
    "读取记忆：按文件名读取（s09）或按查询关键词检索（s20）。",
    { filename: str("（s09）记忆文件名"), query: str("（s20）查询关键词") },
  ),
  write_memory: schema(
    "write_memory",
    "写入一条记忆：s09 用 name/type/description/body，s20 用 key/content。",
    {
      name: str("（s09）记忆名称"),
      type: str("（s09）记忆类型"),
      description: str("（s09）记忆描述"),
      body: str("（s09）记忆正文"),
      key: str("（s20）记忆键"),
      content: str("（s20）记忆内容"),
    },
  ),
  select_memory: schema(
    "select_memory",
    "按上下文筛选相关记忆。",
    { context: str("查询上下文") },
    ["context"],
  ),
  create_task: schema(
    "create_task",
    "创建一个任务。",
    {
      subject: str("任务标题"),
      description: str("任务描述"),
      blockedBy: arr("依赖的任务 ID 列表"),
    },
    ["subject"],
  ),
  list_tasks: schema("list_tasks", "列出所有任务。"),
  claim_task: schema(
    "claim_task",
    "认领任务。",
    { taskId: str("任务 ID"), owner: str("（可选）认领者") },
    ["taskId"],
  ),
  complete_task: schema("complete_task", "完成任务。", { taskId: str("任务 ID") }, ["taskId"]),
  spawn_background: schema(
    "spawn_background",
    "启动一个后台任务。",
    {
      taskId: str("后台任务标识"),
      description: str("任务描述"),
      durationMs: int("（可选）模拟耗时（毫秒）"),
    },
    ["taskId", "description"],
  ),
  collect_notifications: schema("collect_notifications", "收集已完成的后台任务通知。"),
  wait_background: schema(
    "wait_background",
    "等待后台任务完成。",
    { taskId: str("后台任务标识") },
    ["taskId"],
  ),
  schedule_cron: schema(
    "schedule_cron",
    "注册定时任务（5 字段 cron）。",
    {
      cronId: str("任务标识"),
      cron: str("cron 表达式，如 */5 * * * *"),
      prompt: str("触发时注入的描述"),
      recurring: bool("是否重复触发"),
      durable: bool("是否持久化到磁盘"),
    },
    ["cronId", "cron", "prompt"],
  ),
  list_crons: schema("list_crons", "列出所有已注册的定时任务。"),
  cancel_cron: schema("cancel_cron", "取消定时任务。", { cronId: str("任务标识") }, ["cronId"]),
  spawn_teammate: schema(
    "spawn_teammate",
    "创建一个常驻队友。",
    { agentId: str("队友标识"), role: str("队友角色") },
    ["agentId", "role"],
  ),
  send_message: schema(
    "send_message",
    "给队友发送消息。",
    { to: str("收件人"), body: str("消息内容"), from: str("（可选）发件人") },
    ["to", "body"],
  ),
  check_inbox: schema(
    "check_inbox",
    "读取并清空收件箱。",
    { agentId: str("要读取的收件箱标识") },
    ["agentId"],
  ),
  request_plan: schema(
    "request_plan",
    "请求计划审批。",
    {
      goal: str("计划目标"),
      requestId: str("（可选）请求 ID"),
      context: str("（可选）背景说明"),
    },
    ["goal"],
  ),
  review_plan: schema(
    "review_plan",
    "审批计划。",
    { requestId: str("请求 ID"), reviewerId: str("审批者标识") },
    ["requestId", "reviewerId"],
  ),
  request_shutdown: schema(
    "request_shutdown",
    "请求关闭队友。",
    { agentId: str("队友标识"), reason: str("（可选）关闭原因") },
    ["agentId"],
  ),
  idle_poll: schema(
    "idle_poll",
    "空闲轮询，等待新工作。",
    { pollIntervalMs: int("轮询间隔（毫秒）"), reason: str("（可选）轮询原因") },
    ["pollIntervalMs"],
  ),
  scan_unclaimed: schema("scan_unclaimed", "扫描未被认领的任务。"),
  auto_claim: schema("auto_claim", "自动认领一个任务。", { owner: str("认领者标识") }, ["owner"]),
  create_worktree: schema(
    "create_worktree",
    "创建 git worktree 隔离环境。",
    { worktreeId: str("worktree 标识"), branch: str("分支名") },
    ["worktreeId", "branch"],
  ),
  remove_worktree: schema(
    "remove_worktree",
    "移除 worktree。",
    { worktreeId: str("worktree 标识") },
    ["worktreeId"],
  ),
  bind_worktree: schema(
    "bind_worktree",
    "把任务绑定到 worktree。",
    { worktreeId: str("worktree 标识"), taskId: str("任务 ID") },
    ["worktreeId", "taskId"],
  ),
  keep_worktree: schema(
    "keep_worktree",
    "保留 worktree 供人工审查（不删除）。",
    { worktreeId: str("worktree 标识") },
    ["worktreeId"],
  ),
  submit_plan: schema(
    "submit_plan",
    "队友向 Lead 提交计划，等待审批（计划审批闸门）。",
    { plan: str("计划内容") },
    ["plan"],
  ),
  mcp_connect: schema(
    "mcp_connect",
    "连接一个 MCP server 并发现其工具。",
    { serverId: str("server 标识"), serverUrl: str("（可选）server 地址") },
    ["serverId"],
  ),
  assemble_tool_pool: schema("assemble_tool_pool", "重新组装本地 + MCP 工具池。"),
  // 以下 4 个为工程层 src/harness 专属：无章节对应物，采用同样的动词优先命名。
  // TaskBoard 使用数字 id，故这里用 integer。
  // get_task 同时服务 s12/s14 章节（字符串 id，如 task_...）与工程层（数字 id）：
  // 与 read_memory 一样取超集且 required 为空，避免真实模型只发一个方言的 key。
  get_task: schema(
    "get_task",
    "获取任务详情：工程层用数字 id，章节用字符串 taskId（如 task_...）。",
    { id: int("（工程层）数字任务 id"), taskId: str("（章节）任务 ID，如 task_...") },
  ),
  update_task: schema(
    "update_task",
    "更新持久任务的状态或负责人。",
    {
      id: int("任务 id"),
      status: str("新状态：pending / in_progress / completed"),
      owner: str("新负责人"),
    },
    ["id"],
  ),
  broadcast: schema("broadcast", "向所有队友广播消息。", { content: str("广播内容") }, ["content"]),
  list_team: schema("list_team", "列出所有队友。"),
};

/** 按名称取出一条 schema；未注册视为编码错误，直接抛出。 */
export function specFor(name: string): ToolSchema {
  const spec = TOOL_SPECS[name];
  if (!spec) {
    throw new Error(`未注册的工具 schema: ${name}（请先在 runtime/tool-schemas.ts 注册）`);
  }
  return spec;
}

/** 按名称取出若干 schema；未注册的名称会立刻抛错而不是被静默丢弃。 */
export function schemasFor(...names: string[]): ToolSchema[] {
  return names.map(specFor);
}
