/**
 * s03: Permission — 权限是副作用的守门人
 *
 * 本章新增 1 个 Effect：
 *   RequestPermission — 向用户或规则引擎请求执行许可
 *
 * 三道闸门（全在 Handler 内部，Generator 零感知）：
 *   Gate 1: DenyList  — 硬否列表，无条件拒绝
 *   Gate 2: Rules     — 规则匹配，条件拒绝或升级到 Gate 3
 *   Gate 3: UserApproval — 用户审批（RequestPermission Effect）
 */

import { runAgent } from '../runtime/core.ts';
import type { BaseEffect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolUseBlock } from '../runtime/types.ts';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

// 继承自 s01/s02
interface ChatEffect extends BaseEffect {
  type: 'Chat';
  input: { messages: Message[] };
  output: LLMResponse;
}

interface BashExecEffect extends BaseEffect {
  type: 'BashExec';
  input: { command: string };
  output: string;
}

interface ReadFileEffect extends BaseEffect {
  type: 'ReadFile';
  input: { path: string; limit?: number };
  output: string;
}

interface WriteFileEffect extends BaseEffect {
  type: 'WriteFile';
  input: { path: string; content: string };
  output: string;
}

// s03 新增：权限请求
interface RequestPermissionEffect extends BaseEffect {
  type: 'RequestPermission';
  input: {
    toolName: string;
    args: Record<string, unknown>;
    reason: string;
  };
  output: { allowed: boolean; reason?: string };
}

type S03Effect =
  | ChatEffect
  | BashExecEffect
  | ReadFileEffect
  | WriteFileEffect
  | RequestPermissionEffect;

// ============================================================
// Part 2: Handler 实现
// ============================================================

const WORKDIR = process.cwd();

// Gate 1：硬否列表，任何命令包含以下内容直接拒绝
const DENY_LIST = [
  'rm -rf /',
  'rm -rf ~',
  'sudo',
  'shutdown',
  'reboot',
  'mkfs',
  ':(){ :|:& };:',
];

// Gate 2：规则列表
interface PermissionRule {
  match: (toolName: string, args: Record<string, unknown>) => boolean;
  reason: string;
  autoReject: boolean; // true = 直接拒绝；false = 升级到 Gate 3（用户审批）
}

const PERMISSION_RULES: PermissionRule[] = [
  {
    match: (tool, args) =>
      tool === 'BashExec' && ['rm ', 'mv ', 'chmod ', 'chown '].some(
        d => String(args['command'] ?? '').includes(d)
      ),
    reason: '可能的破坏性命令',
    autoReject: false,
  },
  {
    match: (tool, args) =>
      (tool === 'WriteFile') && !path.resolve(String(args['path'] ?? '')).startsWith(WORKDIR),
    reason: '写入工作区外的路径',
    autoReject: false,
  },
];

function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) throw new Error(`路径越界: ${p}`);
  return resolved;
}

function extractText(response: LLMResponse): string {
  return response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text).join('');
}

function getToolUseBlocks(response: LLMResponse): ToolUseBlock[] {
  return response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

// Mock LLM：先发危险命令，再发安全命令
function mockLLM(messages: Message[]): LLMResponse {
  const round = messages.filter(m => m.role === 'assistant').length;
  if (round === 0) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '我先做一些文件操作。' },
        { type: 'tool_use', id: 'tool_001', name: 'bash', input: { command: 'rm temp.txt' } },
      ],
    };
  }
  if (round === 1) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '再尝试这个危险命令。' },
        { type: 'tool_use', id: 'tool_002', name: 'bash', input: { command: 'rm -rf / --no-preserve-root' } },
      ],
    };
  }
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '操作已完成（部分被拒绝）。' }],
  };
}

// 检查权限管道（三道闸门）
// 注意：这个函数需要 perform 才能发起 RequestPermission Effect
// 所以它是一个 Generator 函数
function* checkPermissionPipeline(
  toolName: string,
  args: Record<string, unknown>,
  perform: PerformFn<S03Effect>
): Generator<S03Effect, { allowed: boolean; reason?: string }, any> {
  // Gate 1: DenyList
  if (toolName === 'BashExec') {
    const command = String(args['command'] ?? '');
    const denied = DENY_LIST.find(d => command.includes(d));
    if (denied) {
      console.log(`[Gate1] ✗ 命中硬否列表: ${denied}`);
      return { allowed: false, reason: `命令在硬否列表中: "${denied}"` };
    }
  }
  console.log(`[Gate1] ✓ 通过硬否列表`);

  // Gate 2: Rules
  const rule = PERMISSION_RULES.find(r => r.match(toolName, args));
  if (rule) {
    console.log(`[Gate2] ⚠ 命中规则: ${rule.reason}`);
    if (rule.autoReject) {
      return { allowed: false, reason: rule.reason };
    }
    // Gate 3: 用户审批（通过 RequestPermission Effect）
    const result = yield* perform({
      type: 'RequestPermission',
      input: { toolName, args, reason: rule.reason },
    });
    return result;
  }
  console.log(`[Gate2] ✓ 无规则命中，直接放行`);
  return { allowed: true };
}

const s03Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages } = effect.input;
    console.log(`\n[Chat] → 发送 ${messages.length} 条消息...`);
    await new Promise(r => setTimeout(r, 50));
    const response = mockLLM(messages);
    const tools = getToolUseBlocks(response).map(b => b.name).join(', ');
    console.log(`[LLM]  ← stop_reason: ${response.stop_reason}${tools ? ', 工具: ' + tools : ''}`);
    return response;
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    const { command } = effect.input;
    console.log(`[BashExec] → ${command}`);
    // 教学演示：模拟执行
    return `(执行结果: ${command})`;
  },

  ReadFile: async (effect: ReadFileEffect): Promise<string> => {
    try {
      const safe = safePath(effect.input.path);
      const content = fs.readFileSync(safe, 'utf8');
      return effect.input.limit ? content.split('\n').slice(0, effect.input.limit).join('\n') : content;
    } catch {
      return `[错误] 无法读取: ${effect.input.path}`;
    }
  },

  WriteFile: async (effect: WriteFileEffect): Promise<string> => {
    try {
      const safe = safePath(effect.input.path);
      fs.mkdirSync(path.dirname(safe), { recursive: true });
      fs.writeFileSync(safe, effect.input.content, 'utf8');
      return `已写入 ${effect.input.path}`;
    } catch (e: unknown) {
      return `[错误] ${e instanceof Error ? e.message : String(e)}`;
    }
  },

  // Gate 3 实现：在生产环境询问用户，在测试环境自动同意
  RequestPermission: async (effect: RequestPermissionEffect): Promise<{ allowed: boolean; reason?: string }> => {
    const { toolName, reason } = effect.input;
    console.log(`[Permission] → 询问用户: 是否允许执行 ${toolName}? (原因: ${reason})`);
    // 教学演示：自动同意（真实实现可用 readline 等待用户输入）
    const allowed = true;
    console.log(`[Permission] ← 用户: ${allowed ? '同意（mock）' : '拒绝（mock）'}`);
    return { allowed, reason: allowed ? undefined : '用户拒绝' };
  },
};

// ============================================================
// Part 3: Agent Generator（业务逻辑 — 与 s02 完全一致）
// ============================================================

function* agentLoop(perform: PerformFn<S03Effect>) {
  const messages: Message[] = [
    { role: 'user', content: '清理临时文件，然后列出目录结构。' },
  ];

  while (true) {
    const response = yield* perform({ type: 'Chat', input: { messages } });
    messages.push({ role: 'assistant', content: extractText(response) });

    if (response.stop_reason !== 'tool_use') {
      return extractText(response);
    }

    const toolResults: Array<{ tool_use_id: string; content: string }> = [];

    for (const block of getToolUseBlocks(response)) {
      // 权限检查：在 yield Effect 之前，先走三道闸门
      // 注意：checkPermissionPipeline 本身是 Generator，可以在内部 yield RequestPermission
      const perm = yield* checkPermissionPipeline(
        block.name === 'bash' ? 'BashExec' : block.name,
        block.input as Record<string, unknown>,
        perform
      );

      let output: string;
      if (!perm.allowed) {
        output = `[拒绝] ${perm.reason}`;
        console.log(`[拒绝] ${block.name}: ${perm.reason}`);
      } else {
        switch (block.name) {
          case 'bash':
            output = yield* perform({ type: 'BashExec', input: { command: block.input['command'] as string } });
            break;
          case 'read_file':
            output = yield* perform({ type: 'ReadFile', input: { path: block.input['path'] as string } });
            break;
          case 'write_file':
            output = yield* perform({
              type: 'WriteFile',
              input: { path: block.input['path'] as string, content: block.input['content'] as string },
            });
            break;
          default:
            output = `[未知工具] ${block.name}`;
        }
      }

      toolResults.push({ tool_use_id: block.id, content: output });
    }

    messages.push({ role: 'user', content: JSON.stringify(toolResults) });
  }
}

// ============================================================
// Part 4: 启动入口
// ============================================================

console.log('[S03] Permission 启动\n');

const result = await runAgent<S03Effect, string>(agentLoop, s03Handlers);

console.log('\n[S03] 完成:', result);
