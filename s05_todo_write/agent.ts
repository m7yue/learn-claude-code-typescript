/**
 * s05: TodoWrite — 计划本身是效应
 *
 * 本章新增 2 个 Effect：
 *   TodoWrite — 创建/更新任务计划列表
 *   TodoRead  — 读取当前任务列表
 *
 * 唠叨提醒机制：Generator 内部计数，连续 3 轮未调用 todo_write 则注入提醒消息。
 */

import { runAgent } from '../runtime/core.ts';
import type { Effect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolResultBlock } from '../runtime/types.ts';
import { extractText, getToolUseBlocks } from '../runtime/response.ts';
import { callChat } from '../runtime/model.ts';
import { schemasFor } from '../runtime/tool-schemas.ts';
import { buildSystemPrompt } from '../runtime/system-prompt.ts';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

interface ChatEffect extends Effect<'Chat', { messages: Message[] }, LLMResponse> {}

interface BashExecEffect extends Effect<'BashExec', { command: string }, string> {}

// s05 新增：计划管理
interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

interface TodoWriteEffect extends Effect<'TodoWrite', { todos: TodoItem[] }, string> {}

interface TodoReadEffect extends Effect<'TodoRead', Record<string, never>, string> {}

type S05Effect = ChatEffect | BashExecEffect | TodoWriteEffect | TodoReadEffect;

// ============================================================
// Part 2: Handler 实现
// ============================================================

// Handler 内部状态（副作用层的持久状态）
let currentTodos: TodoItem[] = [];

function formatTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return '（无任务）';
  const icons = { pending: '○', in_progress: '◑', completed: '●' };
  return todos
    .map(t => {
      // 进行中的项额外显示 activeForm（进行时描述），对应真实 Claude Code 的进度提示
      const suffix = t.status === 'in_progress' ? `（${t.activeForm}）` : '';
      return `  ${icons[t.status]} [${t.status}] ${t.content}${suffix}`;
    })
    .join('\n');
}

// Mock LLM：第1轮先写计划，第2-4轮执行任务，第5轮完成
function mockLLM(messages: Message[]): LLMResponse {
  const round = messages.filter(m => m.role === 'assistant').length;

  if (round === 0) {
    // 第1轮：先写计划
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '好的，我先规划一下任务。' },
        {
          type: 'tool_use',
          id: 'tool_001',
          name: 'todo_write',
          input: {
            todos: [
              { content: '列出目录结构', status: 'in_progress', activeForm: '列出目录结构中' },
              { content: '读取配置文件', status: 'pending', activeForm: '读取配置文件中' },
              { content: '生成报告', status: 'pending', activeForm: '生成报告中' },
            ],
          },
        },
      ],
    };
  }

  if (round === 1) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '执行第一个任务。' },
        { type: 'tool_use', id: 'tool_002', name: 'bash', input: { command: 'ls -la' } },
      ],
    };
  }

  if (round === 2) {
    // 第3轮：更新计划，标记第一个完成
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '第一个任务完成，更新计划。' },
        {
          type: 'tool_use',
          id: 'tool_003',
          name: 'todo_write',
          input: {
            todos: [
              { content: '列出目录结构', status: 'completed', activeForm: '列出目录结构中' },
              { content: '读取配置文件', status: 'in_progress', activeForm: '读取配置文件中' },
              { content: '生成报告', status: 'pending', activeForm: '生成报告中' },
            ],
          },
        },
      ],
    };
  }

  if (round === 3) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '读取配置文件。' },
        { type: 'tool_use', id: 'tool_004', name: 'bash', input: { command: 'cat package.json' } },
      ],
    };
  }

  // 注意：第4、5轮故意不调用 todo_write，触发唠叨提醒
  if (round === 4) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '继续执行。' },
        { type: 'tool_use', id: 'tool_005', name: 'bash', input: { command: 'echo "processing"' } },
      ],
    };
  }

  if (round === 5) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '还有一步。' },
        { type: 'tool_use', id: 'tool_006', name: 'bash', input: { command: 'echo "step 3"' } },
      ],
    };
  }

  // 收到唠叨提醒后，终于更新计划
  if (round === 6) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '好吧，更新一下计划。' },
        {
          type: 'tool_use',
          id: 'tool_007',
          name: 'todo_write',
          input: {
            todos: [
              { content: '列出目录结构', status: 'completed', activeForm: '列出目录结构中' },
              { content: '读取配置文件', status: 'completed', activeForm: '读取配置文件中' },
              { content: '生成报告', status: 'completed', activeForm: '生成报告中' },
            ],
          },
        },
      ],
    };
  }

  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '所有任务已完成！' }],
  };
}

// real 模式注入的 system prompt，引导模型使用工具完成任务。
// mock 模式不读取该字段，故零配置运行行为不变。
const SYSTEM_PROMPT = buildSystemPrompt(
  '开始任何多步骤任务前，先用 todo_write 规划步骤，并随进度更新状态。' +
    '本教学演示中 bash 是模拟的：只回显命令文本、不会真正执行，请不要依赖它的输出。',
);

const s05Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages } = effect.input;
    console.log(`\n[Chat] → 发送 ${messages.length} 条消息...`);
    await new Promise(r => setTimeout(r, 50));
    const response = await callChat(mockLLM, messages, {
      tools: schemasFor('bash', 'todo_write', 'todo_read'),
      system: SYSTEM_PROMPT,
    });
    const tools = getToolUseBlocks(response).map(b => b.name).join(', ');
    console.log(`[LLM]  ← stop_reason: ${response.stop_reason}${tools ? ', 工具: ' + tools : ''}`);
    return response;
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    console.log(`[BashExec] → ${effect.input.command}`);
    return `(执行结果: ${effect.input.command})`;
  },

  TodoWrite: async (effect: TodoWriteEffect): Promise<string> => {
    currentTodos = effect.input.todos;
    console.log(`[TodoWrite] 更新任务列表:`);
    console.log(formatTodos(currentTodos));
    return `已更新 ${currentTodos.length} 个任务`;
  },

  TodoRead: async (_effect: TodoReadEffect): Promise<string> => {
    return formatTodos(currentTodos);
  },
};

// ============================================================
// Part 3: Agent Generator
// ============================================================

const NAG_THRESHOLD = 3; // 连续几轮没有 todo_write 就触发提醒

function* agentLoop(perform: PerformFn<S05Effect>) {
  const messages: Message[] = [
    { role: 'user', content: '帮我分三步完成：列出目录、读取配置、生成报告。' },
  ];

  let roundsSinceTodo = 0; // 唠叨计数器

  while (true) {
    // 唠叨提醒：连续多轮未更新计划，注入提醒消息
    if (roundsSinceTodo >= NAG_THRESHOLD) {
      const nagMessage = `[系统提醒] 你已经 ${roundsSinceTodo} 轮没有更新任务列表了。` +
        `对于多步骤任务，请使用 todo_write 工具保持计划的可见性。`;
      console.log(`\n⏰ ${nagMessage}`);
      messages.push({ role: 'user', content: nagMessage });
      roundsSinceTodo = 0;
    }

    const response = yield* perform({ type: 'Chat', input: { messages } });
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      return extractText(response);
    }

    const blocks = getToolUseBlocks(response);
    const calledTodo = blocks.some(b => b.name === 'todo_write');

    // 如果本轮调用了 todo_write，重置唠叨计数
    if (calledTodo) {
      roundsSinceTodo = 0;
    } else {
      roundsSinceTodo++;
    }

    const toolResults: ToolResultBlock[] = [];

    for (const block of blocks) {
      try {
        let output: string;

        switch (block.name) {
          case 'bash':
            output = yield* perform({ type: 'BashExec', input: { command: block.input['command'] as string } });
            break;
          case 'todo_write':
            output = yield* perform({
              type: 'TodoWrite',
              input: { todos: block.input['todos'] as TodoItem[] },
            });
            break;
          case 'todo_read':
            output = yield* perform({ type: 'TodoRead', input: {} });
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

console.log('[S05] TodoWrite 启动\n');

const result = await runAgent<S05Effect, string>(agentLoop, s05Handlers);

console.log('\n[S05] 完成:', result);
