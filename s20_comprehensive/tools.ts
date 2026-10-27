/**
 * s20 的工具池 —— lead / teammate / subagent 三套不同作用域。
 * schema 统一来自 runtime/tool-schemas.ts；本章只覆盖与角色能力不一致的字段。
 */

import type { ToolSchema } from '../runtime/model.ts';
import { schemasFor, specFor } from '../runtime/tool-schemas.ts';

// 本章的 GlobSearch 只匹配一层；共享 schema 的描述更宽，覆盖成实际能力。
export const GLOB_SCHEMA: ToolSchema = {
  ...specFor('glob'),
  description: '按单层 glob 模式查找工作区内文件（不支持 ** 递归）。',
};

// lead 可以用 worktreeId 指定 cwd，也可以用 run_in_background。
const LEAD_BASH_SCHEMA = specFor('bash');

// teammate/subagent 不支持后台执行（没有独立的 notification 接收方），
// 但必须支持 worktreeId，否则隔离会静默退化到主工作区。
const WORKER_BASH_SCHEMA: ToolSchema = {
  ...specFor('bash'),
  description: '在工作区内执行 shell 命令；可用 worktreeId 在指定 worktree 中执行。',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      worktreeId: { type: 'string', description: '（可选）在哪个 worktree 中执行' },
    },
    required: ['command'],
  },
};

// 共享 write_file 没有 worktreeId；本章的 WriteFile handler 支持它，schema 必须同步。
const WRITE_FILE_SCHEMA: ToolSchema = {
  ...specFor('write_file'),
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '文件内容' },
      worktreeId: { type: 'string', description: '（可选）写入指定 worktree' },
    },
    required: ['path', 'content'],
  },
};

// 共享 create_task 没有 owner 预订；s20 的自主认领需要它来避免抢 lead 的任务。
const CREATE_TASK_SCHEMA: ToolSchema = {
  ...specFor('create_task'),
  input_schema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: '任务标题' },
      description: { type: 'string', description: '任务描述' },
      blockedBy: { type: 'array', items: { type: 'string' }, description: '依赖的任务 ID 列表' },
      preferredOwner: { type: 'string', description: '（可选）预订给某个 agent' },
    },
    required: ['subject'],
  },
};

function withChapterOverrides(
  names: string[],
  bashSchema: ToolSchema,
): ToolSchema[] {
  return schemasFor(...names).map((schema) => {
    if (schema.name === 'glob') return GLOB_SCHEMA;
    if (schema.name === 'bash') return bashSchema;
    if (schema.name === 'write_file') return WRITE_FILE_SCHEMA;
    if (schema.name === 'create_task') return CREATE_TASK_SCHEMA;
    return schema;
  });
}

// lead（主 Agent）本地工具全集；宿主在 leadLoop 启动时连接 MCP，
// 连接后 MCP 工具在 AssembleToolPool 中并入。
export const LEAD_LOCAL_TOOLS: ToolSchema[] = withChapterOverrides(
  [
    'bash',
    'read_file',
    'write_file',
    'edit_file',
    'glob',
    'todo_write',
    'task',
    'load_skill',
    'compact',
    'read_memory',
    'write_memory',
    'create_task',
    'list_tasks',
    'get_task',
    'claim_task',
    'complete_task',
    'schedule_cron',
    'list_crons',
    'cancel_cron',
    'spawn_teammate',
    'send_message',
    'check_inbox',
    'request_shutdown',
    'request_plan',
    'review_plan',
    'create_worktree',
    'remove_worktree',
    'keep_worktree',
  ],
  LEAD_BASH_SCHEMA,
);

// 队友可用工具：只能读写文件、收发消息、操作任务图与提交计划；不能拉起子代理或管理 worktree。
export const TEAMMATE_TOOLS: ToolSchema[] = withChapterOverrides(
  [
    'bash',
    'read_file',
    'write_file',
    'send_message',
    'list_tasks',
    'claim_task',
    'complete_task',
    'submit_plan',
  ],
  WORKER_BASH_SCHEMA,
);

// 子代理只用基础文件/shell 工具，不参与任务图与协作协议（工具作用域隔离）。
export const SUBAGENT_TOOLS: ToolSchema[] = withChapterOverrides(
  ['bash', 'read_file', 'write_file', 'edit_file', 'glob'],
  WORKER_BASH_SCHEMA,
);
