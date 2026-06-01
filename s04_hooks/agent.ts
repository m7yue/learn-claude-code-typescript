/**
 * s04: Hooks — 效应拦截层
 *
 * 本章新增 1 个 Effect：
 *   FireHook — 在工具执行前后触发钩子链
 *
 * 四个生命周期事件：
 *   UserPromptSubmit — 用户提交后（可注入上下文）
 *   PreToolUse       — 工具执行前（可拦截/权限检查）
 *   PostToolUse      — 工具执行后（可记录/监控）
 *   Stop             — 循环结束时（可汇总统计）
 *
 * s03 的权限逻辑从 Generator 移入 Hook，Generator 保持干净。
 */

import { runAgent } from '../runtime/core.ts';
import type { BaseEffect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolUseBlock } from '../runtime/types.ts';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

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

// s04 新增：钩子触发 Effect
type HookEvent = 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop';

interface FireHookEffect extends BaseEffect {
  type: 'FireHook';
  input: {
    event: HookEvent;
    data: Record<string, unknown>;
  };
  output: { blocked: boolean; reason?: string };
}

type S04Effect =
  | ChatEffect
  | BashExecEffect
  | ReadFileEffect
  | WriteFileEffect
  | FireHookEffect;

// ============================================================
// Part 2: Handler 实现
// ============================================================

const WORKDIR = process.cwd();
const DENY_LIST = ['rm -rf /', 'rm -rf ~', 'sudo', 'shutdown', 'reboot'];

type HookFn = (data: Record<string, unknown>) => { blocked: boolean; reason?: string };

// Hook 注册表
const HOOKS: Record<HookEvent, HookFn[]> = {
  UserPromptSubmit: [
    (data) => {
      console.log(`[Hook:UserPromptSubmit] 注入上下文: 当前时间 ${new Date().toLocaleTimeString()}`);
      return { blocked: false };
    },
  ],
  PreToolUse: [
    // 权限 Hook（s03 的逻辑移入此处）
    (data) => {
      const toolName = String(data['toolName'] ?? '');
      const args = (data['args'] ?? {}) as Record<string, unknown>;
      const command = String(args['command'] ?? '');
      const denied = DENY_LIST.find(d => command.includes(d));
      if (denied) {
        console.log(`[Hook:Permission] ✗ 拒绝 ${toolName}: 命中硬否列表 "${denied}"`);
        return { blocked: true, reason: `命令在硬否列表中: "${denied}"` };
      }
      console.log(`[Hook:Permission] ✓ 放行 ${toolName}`);
      return { blocked: false };
    },
    // 日志 Hook
    (data) => {
      const toolName = String(data['toolName'] ?? '');
      console.log(`[Hook:Log] 即将执行 ${toolName}`);
      return { blocked: false };
    },
  ],
  PostToolUse: [
    (data) => {
      const output = String(data['output'] ?? '');
      const toolName = String(data['toolName'] ?? '');
      console.log(`[Hook:PostToolUse] ${toolName} 输出 ${output.length} 字符`);
      if (output.length > 10000) {
        console.log(`[Hook:PostToolUse] ⚠ 大输出警告，建议持久化`);
      }
      return { blocked: false };
    },
  ],
  Stop: [
    (data) => {
      const rounds = Number(data['rounds'] ?? 0);
      console.log(`\n[Hook:Stop] 循环结束，共 ${rounds} 轮`);
      return { blocked: false };
    },
  ],
};

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

function mockLLM(messages: Message[]): LLMResponse {
  const round = messages.filter(m => m.role === 'assistant').length;
  if (round === 0) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '我来列出文件。' },
        { type: 'tool_use', id: 'tool_001', name: 'bash', input: { command: 'ls -la' } },
      ],
    };
  }
  if (round === 1) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '再试这个危险命令。' },
        { type: 'tool_use', id: 'tool_002', name: 'bash', input: { command: 'rm -rf / --no-preserve-root' } },
      ],
    };
  }
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '操作完成，部分命令被 Hook 拦截。' }],
  };
}

const s04Handlers = {
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
    return `(执行结果: ${command})`;
  },

  ReadFile: async (effect: ReadFileEffect): Promise<string> => {
    try {
      const safe = safePath(effect.input.path);
      const content = fs.readFileSync(safe, 'utf8');
      return effect.input.limit ? content.split('\n').slice(0, effect.input.limit).join('\n') : content;
    } catch { return `[错误] 无法读取: ${effect.input.path}`; }
  },

  WriteFile: async (effect: WriteFileEffect): Promise<string> => {
    try {
      const safe = safePath(effect.input.path);
      fs.mkdirSync(path.dirname(safe), { recursive: true });
      fs.writeFileSync(safe, effect.input.content, 'utf8');
      return `已写入 ${effect.input.path}`;
    } catch (e: unknown) { return `[错误] ${e instanceof Error ? e.message : String(e)}`; }
  },

  // FireHook Handler：遍历 Hook 链，第一个 blocked 生效
  FireHook: async (effect: FireHookEffect): Promise<{ blocked: boolean; reason?: string }> => {
    const { event, data } = effect.input;
    const hooks = HOOKS[event] ?? [];
    for (const hook of hooks) {
      const result = hook(data);
      if (result.blocked) return result;
    }
    return { blocked: false };
  },
};

// ============================================================
// Part 3: Agent Generator（业务逻辑更干净了）
// ============================================================

function* agentLoop(perform: PerformFn<S04Effect>) {
  const messages: Message[] = [
    { role: 'user', content: '列出目录结构，并清理临时文件。' },
  ];

  // UserPromptSubmit Hook
  yield* perform({ type: 'FireHook', input: { event: 'UserPromptSubmit', data: { query: messages[0].content } } });

  let rounds = 0;

  while (true) {
    const response = yield* perform({ type: 'Chat', input: { messages } });
    messages.push({ role: 'assistant', content: extractText(response) });
    rounds++;

    if (response.stop_reason !== 'tool_use') {
      // Stop Hook
      yield* perform({ type: 'FireHook', input: { event: 'Stop', data: { rounds } } });
      return extractText(response);
    }

    const toolResults: Array<{ tool_use_id: string; content: string }> = [];

    for (const block of getToolUseBlocks(response)) {
      const toolName = block.name;
      const args = block.input as Record<string, unknown>;

      // PreToolUse Hook（权限检查 + 日志，Generator 只需一行）
      const preHook = yield* perform({
        type: 'FireHook',
        input: { event: 'PreToolUse', data: { toolName, args } },
      });

      let output: string;
      if (preHook.blocked) {
        output = `[拒绝] ${preHook.reason}`;
      } else {
        switch (toolName) {
          case 'bash':
            output = yield* perform({ type: 'BashExec', input: { command: args['command'] as string } });
            break;
          case 'read_file':
            output = yield* perform({ type: 'ReadFile', input: { path: args['path'] as string } });
            break;
          case 'write_file':
            output = yield* perform({
              type: 'WriteFile',
              input: { path: args['path'] as string, content: args['content'] as string },
            });
            break;
          default:
            output = `[未知工具] ${toolName}`;
        }

        // PostToolUse Hook（日志/监控）
        yield* perform({ type: 'FireHook', input: { event: 'PostToolUse', data: { toolName, output } } });
      }

      toolResults.push({ tool_use_id: block.id, content: output });
    }

    messages.push({ role: 'user', content: JSON.stringify(toolResults) });
  }
}

// ============================================================
// Part 4: 启动入口
// ============================================================

console.log('[S04] Hooks 启动\n');

const result = await runAgent<S04Effect, string>(agentLoop, s04Handlers);

console.log('[S04] 完成:', result);
