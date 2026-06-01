/**
 * 公共工具类型
 * 各章 Effect Union 类型按需从此文件扩展
 */

/** 通用消息结构（模拟 LLM 对话消息） */
export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

/** 模拟 LLM 响应中的工具调用块 */
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** 模拟 LLM 响应中的文本块 */
export interface TextBlock {
  type: 'text';
  text: string;
}

/** 模拟 LLM 响应 */
export interface LLMResponse {
  stop_reason: 'tool_use' | 'end_turn' | 'max_tokens';
  content: Array<TextBlock | ToolUseBlock>;
}

/** 模拟工具结果消息 */
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

/** 权限检查结果 */
export type PermissionResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/** 任务状态 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed';

/** 任务记录 */
export interface TaskRecord {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  owner: string | null;
  blockedBy: string[];
}
