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
import type { Effect, PerformFn, AgentFactory } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolResultBlock } from '../runtime/types.ts';
import { extractText, getToolUseBlocks, messageText } from '../runtime/response.ts';
import { callChat } from '../runtime/model.ts';
import { schemasFor } from '../runtime/tool-schemas.ts';
import { buildSystemPrompt } from '../runtime/system-prompt.ts';
import { WORKSPACE_ROOT } from '../runtime/workspace.ts';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

interface ChatEffect extends Effect<'Chat', { messages: Message[]; isSubAgent?: boolean }, LLMResponse> {}

interface BashExecEffect extends Effect<'BashExec', { command: string }, string> {}

interface ReadFileEffect extends Effect<'ReadFile', { path: string; limit?: number }, string> {}

// s06 新增：子 Agent 委派
interface DelegateEffect extends Effect<'Delegate', { task: string; maxRounds?: number }, string> {}

type S06Effect = ChatEffect | BashExecEffect | ReadFileEffect | DelegateEffect;

// 子 Agent 只能使用基础工具（不含 Delegate，防无限递归）
type SubEffect = ChatEffect | BashExecEffect | ReadFileEffect;

// ============================================================
// Part 2: Handler 实现
// ============================================================

// 工作区根目录（可用 AGENT_WORKSPACE 覆盖）。
const WORKDIR = WORKSPACE_ROOT;
// 子 Agent 的默认最大轮数；超限则中断并返回已得到的最后一段文本。
const DEFAULT_MAX_ROUNDS = 10;

// Mock LLM：主 Agent 两轮（委派 + 报告），子 Agent 两轮（读文件 + 总结）
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
    content: [{ type: 'text', text: `已完成分析。子任务结论: ${messageText(messages[messages.length - 1].content)}` }],
  };
}

function mockSubLLM(messages: Message[]): LLMResponse {
  const round = messages.filter(m => m.role === 'assistant').length;

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
// real 模式注入的 system prompt，引导模型使用工具完成任务。
// mock 模式不读取该字段，故零配置运行行为不变。
const SUB_SYSTEM_PROMPT = buildSystemPrompt(
  '你是子代理：只有这条任务描述，看不到主 Agent 的历史。用 bash、read_file 完成任务（命令以只读为主），' +
    '最后只返回最终结论本身（结论 + 关键依据，控制在 5 行以内），不要复述中间过程、不要粘贴命令原文或原始输出。',
);

const subHandlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages } = effect.input;
    const round = messages.filter(m => m.role === 'assistant').length;
    console.log(`  [子] Chat → 轮次 ${round + 1}`);
    await new Promise(r => setTimeout(r, 50));
    const response = await callChat(mockSubLLM, messages, {
      tools: schemasFor('bash', 'read_file'),
      system: SUB_SYSTEM_PROMPT,
    });
    const tools = getToolUseBlocks(response).map(b => b.name).join(', ');
    console.log(`  [子] LLM ← ${response.stop_reason}${tools ? ', 工具: ' + tools : ''}`);
    return response;
  },

  // 真实执行：mock 只替代模型调用，命令本身交给系统 shell
  BashExec: async (effect: BashExecEffect): Promise<string> => {
    const { command } = effect.input;
    console.log(`  [子] BashExec → ${command}`);
    const r = spawnSync(command, {
      shell: true,
      cwd: WORKDIR,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (r.error) return `Error: ${r.error.message}`;
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    console.log(`  [子] BashExec ← ${out.slice(0, 60).replace(/\n/g, ' ')}`);
    return out ? out.slice(0, 50_000) : '(no output)';
  },

  ReadFile: async (effect: ReadFileEffect): Promise<string> => {
    console.log(`  [子] ReadFile → ${effect.input.path}`);
    try {
      const resolved = path.resolve(WORKDIR, effect.input.path);
      const rel = path.relative(WORKDIR, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return '[错误] 路径越界';
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
      messages.push({ role: 'assistant', content: response.content });
      rounds++;

      if (response.stop_reason !== 'tool_use') break;

      const toolResults: ToolResultBlock[] = [];
      for (const block of getToolUseBlocks(response)) {
        try {
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
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: output });
        } catch (err) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `[错误] ${err instanceof Error ? err.message : String(err)}`,
            is_error: true,
          });
        }
      }
      messages.push({
        role: 'user',
        content: toolResults,
      });
    }

    if (rounds >= maxRounds) {
      return `[超出轮数限制] 最后结果: ${finalText}`;
    }
    return finalText;
  };
}

// real 模式注入的 system prompt，引导模型使用工具完成任务。
// mock 模式不读取该字段，故零配置运行行为不变。
const MAIN_SYSTEM_PROMPT = buildSystemPrompt(
  '探索类、需要多次工具调用才能回答的子任务，用 task 委派给子代理——子代理有独立上下文，只把结论带回来；' +
    '拿到结论后就据此汇总回答，不要再自己重跑一遍探索（最多用一条只读命令做确认），不要把中间过程堆进自己的上下文。' +
    '用 bash 时以只读命令为主（ls、cat、find 等）。最终汇总保持简短，几行以内。',
);

const s06Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages } = effect.input;
    const round = messages.filter(m => m.role === 'assistant').length;
    console.log(`\n[主] Chat → 轮次 ${round + 1}`);
    await new Promise(r => setTimeout(r, 50));
    const response = await callChat(mockMainLLM, messages, {
      tools: schemasFor('bash', 'read_file', 'task'),
      system: MAIN_SYSTEM_PROMPT,
    });
    const tools = getToolUseBlocks(response).map(b => b.name).join(', ');
    console.log(`[主] LLM ← ${response.stop_reason}${tools ? ', 工具: ' + tools : ''}`);
    return response;
  },

  // 真实执行：mock 只替代模型调用，命令本身交给系统 shell
  BashExec: async (effect: BashExecEffect): Promise<string> => {
    const { command } = effect.input;
    console.log(`[主] BashExec → ${command}`);
    const r = spawnSync(command, {
      shell: true,
      cwd: WORKDIR,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (r.error) return `Error: ${r.error.message}`;
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    console.log(`[主] BashExec ← ${out.slice(0, 60).replace(/\n/g, ' ')}`);
    return out ? out.slice(0, 50_000) : '(no output)';
  },

  // 与子 Agent 的 ReadFile 同一套实现：主 Agent 也真读磁盘
  ReadFile: async (effect: ReadFileEffect): Promise<string> => {
    console.log(`[主] ReadFile → ${effect.input.path}`);
    try {
      const resolved = path.resolve(WORKDIR, effect.input.path);
      const rel = path.relative(WORKDIR, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return '[错误] 路径越界';
      const content = fs.readFileSync(resolved, 'utf8');
      const lines = content.split('\n');
      return effect.input.limit ? lines.slice(0, effect.input.limit).join('\n') : content;
    } catch {
      return `[错误] 无法读取: ${effect.input.path}`;
    }
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
    { role: 'user', content: '先摸清这个项目：用了哪些技术、目录怎么组织、怎么跑起来，然后用三五句话给我一份技术栈总结。' },
  ];

  while (true) {
    const response = yield* perform({ type: 'Chat', input: { messages } });
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      return extractText(response);
    }

    const toolResults: ToolResultBlock[] = [];

    for (const block of getToolUseBlocks(response)) {
      try {
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

        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: output });
      } catch (err) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `[错误] ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        });
      }
    }

    messages.push({
      role: 'user',
      content: toolResults,
    });
  }
}

// ============================================================
// Part 4: 启动入口
// ============================================================

console.log('[S06] Subagent 启动\n');

const result = await runAgent<S06Effect, string>(agentLoop, s06Handlers);

console.log('\n[S06] 完成:', result);
