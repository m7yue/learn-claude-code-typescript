/**
 * s06: Subagent — 效应作用域隔离
 *
 * 本章新增 1 个 Effect：
 *   Delegate — 在隔离的效应域里运行子 Agent，只返回最终结论
 *
 * Delegate Handler 内部调用 runAgent()，形成嵌套的效应运行器。
 * 子 Agent 有独立的 messages[]，最多 maxRounds 轮，无法再次 Delegate。
 */

import { runAgent } from '../runtime/core.ts';
import type { BaseEffect, PerformFn, AgentFactory } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolUseBlock } from '../runtime/types.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

interface ChatEffect extends BaseEffect {
  type: 'Chat';
  input: { messages: Message[]; isSubAgent?: boolean };
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

// s06 新增：子 Agent 委派
interface DelegateEffect extends BaseEffect {
  type: 'Delegate';
  input: {
    task: string;
    maxRounds?: number;
  };
  output: string;
}

type S06Effect = ChatEffect | BashExecEffect | ReadFileEffect | DelegateEffect;

// 子 Agent 只能使用基础工具（不含 Delegate，防无限递归）
type SubEffect = ChatEffect | BashExecEffect | ReadFileEffect;

// ============================================================
// Part 2: Handler 实现
// ============================================================

const WORKDIR = process.cwd();
const DEFAULT_MAX_ROUNDS = 10;

function extractText(response: LLMResponse): string {
  return response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text).join('');
}

function getToolUseBlocks(response: LLMResponse): ToolUseBlock[] {
  return response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

// Mock LLM：主 Agent 两轮（委派 + 报告），子 Agent 两轮（读文件 + 总结）
let subRound = 0;

function mockMainLLM(messages: Message[]): LLMResponse {
  const round = messages.filter(m => m.role === 'assistant').length;
  if (round === 0) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '我先委派子 Agent 分析依赖。' },
        {
          type: 'tool_use',
          id: 'main_001',
          name: 'task',
          input: { task: '读取 package.json 并列出所有依赖项' },
        },
      ],
    };
  }
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: `已完成分析。子任务结论: ${messages[messages.length - 1].content}` }],
  };
}

function mockSubLLM(messages: Message[]): LLMResponse {
  const round = messages.filter(m => m.role === 'assistant').length;
  subRound = round;

  if (round === 0) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '我来读取 package.json。' },
        {
          type: 'tool_use',
          id: 'sub_001',
          name: 'read_file',
          input: { path: './package.json' },
        },
      ],
    };
  }
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '依赖分析完成：项目使用 tsx 和 typescript 作为开发依赖。' }],
  };
}

// 子 Agent 专用的基础 Handlers（不含 Delegate）
const subHandlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages } = effect.input;
    const round = messages.filter(m => m.role === 'assistant').length;
    console.log(`  [子] Chat → 轮次 ${round + 1}`);
    await new Promise(r => setTimeout(r, 50));
    const response = mockSubLLM(messages);
    const tools = getToolUseBlocks(response).map(b => b.name).join(', ');
    console.log(`  [子] LLM ← ${response.stop_reason}${tools ? ', 工具: ' + tools : ''}`);
    return response;
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    console.log(`  [子] BashExec → ${effect.input.command}`);
    return `(子 Agent 执行: ${effect.input.command})`;
  },

  ReadFile: async (effect: ReadFileEffect): Promise<string> => {
    console.log(`  [子] ReadFile → ${effect.input.path}`);
    try {
      const resolved = path.resolve(WORKDIR, effect.input.path);
      if (!resolved.startsWith(WORKDIR)) return '[错误] 路径越界';
      const content = fs.readFileSync(resolved, 'utf8');
      const lines = content.split('\n');
      return effect.input.limit ? lines.slice(0, effect.input.limit).join('\n') : content;
    } catch {
      return `[错误] 无法读取: ${effect.input.path}`;
    }
  },
};

// 创建子 Agent 工厂函数
function createSubAgentFactory(task: string, maxRounds: number): AgentFactory<SubEffect, string> {
  return function* (perform: PerformFn<SubEffect>) {
    const messages: Message[] = [{ role: 'user', content: task }];
    let rounds = 0;
    let finalText = '';

    while (rounds < maxRounds) {
      const response = yield* perform({ type: 'Chat', input: { messages, isSubAgent: true } });
      finalText = extractText(response);
      messages.push({ role: 'assistant', content: finalText });
      rounds++;

      if (response.stop_reason !== 'tool_use') break;

      const toolResults: Array<{ tool_use_id: string; content: string }> = [];
      for (const block of getToolUseBlocks(response)) {
        let output: string;
        switch (block.name) {
          case 'bash':
            output = yield* perform({ type: 'BashExec', input: { command: block.input['command'] as string } });
            break;
          case 'read_file':
            output = yield* perform({ type: 'ReadFile', input: { path: block.input['path'] as string } });
            break;
          default:
            output = `[不可用工具] ${block.name}`;
        }
        toolResults.push({ tool_use_id: block.id, content: output });
      }
      messages.push({ role: 'user', content: JSON.stringify(toolResults) });
    }

    if (rounds >= maxRounds) {
      return `[超出轮数限制] 最后结果: ${finalText}`;
    }
    return finalText;
  };
}

const s06Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages } = effect.input;
    const round = messages.filter(m => m.role === 'assistant').length;
    console.log(`\n[主] Chat → 轮次 ${round + 1}`);
    await new Promise(r => setTimeout(r, 50));
    const response = mockMainLLM(messages);
    const tools = getToolUseBlocks(response).map(b => b.name).join(', ');
    console.log(`[主] LLM ← ${response.stop_reason}${tools ? ', 工具: ' + tools : ''}`);
    return response;
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    console.log(`[主] BashExec → ${effect.input.command}`);
    return `(主 Agent 执行: ${effect.input.command})`;
  },

  ReadFile: async (effect: ReadFileEffect): Promise<string> => {
    console.log(`[主] ReadFile → ${effect.input.path}`);
    return `(主 Agent 读取: ${effect.input.path})`;
  },

  // Delegate Handler：在隔离的效应域里运行子 Agent
  Delegate: async (effect: DelegateEffect): Promise<string> => {
    const { task, maxRounds = DEFAULT_MAX_ROUNDS } = effect.input;
    console.log(`\n--- 子 Agent 启动: "${task}" ---`);

    // 创建子 Agent 工厂并在隔离域里运行
    const subFactory = createSubAgentFactory(task, maxRounds);
    const result = await runAgent<SubEffect, string>(subFactory, subHandlers);

    console.log(`--- 子 Agent 完成 ---`);
    console.log(`[主] 收到子任务结论: "${result.slice(0, 60)}..."`);
    return result;
  },
};

// ============================================================
// Part 3: Agent Generator（主 Agent）
// ============================================================

function* agentLoop(perform: PerformFn<S06Effect>) {
  const messages: Message[] = [
    { role: 'user', content: '分析项目的依赖，然后告诉我这个项目用了什么技术栈。' },
  ];

  while (true) {
    const response = yield* perform({ type: 'Chat', input: { messages } });
    messages.push({ role: 'assistant', content: extractText(response) });

    if (response.stop_reason !== 'tool_use') {
      return extractText(response);
    }

    const toolResults: Array<{ tool_use_id: string; content: string }> = [];

    for (const block of getToolUseBlocks(response)) {
      let output: string;

      switch (block.name) {
        case 'bash':
          output = yield* perform({ type: 'BashExec', input: { command: block.input['command'] as string } });
          break;
        case 'read_file':
          output = yield* perform({ type: 'ReadFile', input: { path: block.input['path'] as string } });
          break;
        case 'task':
          // Delegate Effect：委派子任务
          output = yield* perform({
            type: 'Delegate',
            input: {
              task: block.input['task'] as string,
              maxRounds: 10,
            },
          });
          break;
        default:
          output = `[未知工具] ${block.name}`;
      }

      toolResults.push({ tool_use_id: block.id, content: output });
    }

    messages.push({ role: 'user', content: JSON.stringify(toolResults) });
  }
}

// ============================================================
// Part 4: 启动入口
// ============================================================

console.log('[S06] Subagent 启动\n');

const result = await runAgent<S06Effect, string>(agentLoop, s06Handlers);

console.log('\n[S06] 完成:', result.slice(0, 100));
