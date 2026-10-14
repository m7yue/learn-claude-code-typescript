/**
 * 公共工具类型
 * 各章 Effect Union 类型按需从此文件扩展
 */

/** 模拟 LLM 响应中的文本块 */
export interface TextBlock {
  type: 'text';
  text: string;
}

/** 模拟 LLM 响应中的工具调用块 */
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** 工具结果块（喂回给模型） */
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  /** 标记失败结果，便于模型据此决定重试/改道（Anthropic 原生支持）。 */
  is_error?: boolean;
}

/** 模拟 LLM 响应 */
export interface LLMResponse {
  stop_reason: 'tool_use' | 'end_turn' | 'max_tokens';
  content: Array<TextBlock | ToolUseBlock>;
}

/**
 * 消息内容：纯文本，或结构化内容块数组。
 *
 * 结构化块让 real 模式忠实表达 Anthropic 的 tool_use / tool_result 配对：
 * assistant 消息携带 tool_use 块，紧随其后的 user 消息携带对应的 tool_result 块。
 */
export type MessageContent = string | Array<TextBlock | ToolUseBlock | ToolResultBlock>;

/** 通用消息结构（模拟 LLM 对话消息） */
export interface Message {
  role: 'user' | 'assistant';
  content: MessageContent;
}

/** 权限检查结果 */
export type PermissionResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/** 任务状态 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed';

/**
 * 教学版任务记录：面向 s12/s16/s20 的依赖图表达。
 *
 * 与工程层 src/modules/tasks.ts 的 TaskRecord 故意不同：
 *   - id：这里是字符串（依赖图节点标识），工程层是数字（磁盘文件名）
 *   - owner：这里用 null 表示"未认领"，工程层用空串
 *   - blockedBy：这里是必填，工程层是可选扩展
 * 两者的互转见 src/modules/task-adapter.ts。
 */
export interface TaskRecord {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  owner: string | null;
  blockedBy: string[];
}
