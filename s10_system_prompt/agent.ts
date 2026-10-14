/**
 * s10: System Prompt — 提示词运行时组装
 *
 * 本章新增 1 个 Effect：
 *   AssemblePrompt — 根据当前上下文动态组装 system prompt，带缓存
 *
 * 核心设计：
 *   - System prompt 分段存储（PROMPT_SECTIONS）
 *   - 每轮根据状态（memories, tools, workspace）按需选择片段
 *   - 相同上下文命中缓存，避免重复组装
 */

import { runAgent } from '../runtime/core.ts';
import type { Effect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolResultBlock } from '../runtime/types.ts';
import { extractText, getToolUseBlocks } from '../runtime/response.ts';
import { callChat } from '../runtime/model.ts';
import { schemasFor } from '../runtime/tool-schemas.ts';
import { ENVIRONMENT_PROMPT } from '../runtime/system-prompt.ts';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

interface ChatEffect extends Effect<'Chat', { messages: Message[]; systemPrompt: string }, LLMResponse> {}

interface BashExecEffect extends Effect<'BashExec', { command: string }, string> {}

// s10 新增：运行时提示词组装
interface PromptContext {
  enabledTools: string[];
  workspace: string;
  memories?: string;
  activeTask?: string;
}

interface AssemblePromptEffect extends Effect<'AssemblePrompt', { context: PromptContext }, string> {} // 组装好的 system prompt

type S10Effect = ChatEffect | BashExecEffect | AssemblePromptEffect;

// ============================================================
// Part 2: Handler 实现
// ============================================================

// 提示词片段库：每个片段要么是「静态字符串」，要么是「按上下文生成文本的函数」。
// 这里用宽松的联合类型存储，assemblePrompt 再按各自的调用形态取值。
const PROMPT_SECTIONS: Record<string, string | ((...args: string[]) => string)> = {
  identity: `你是一个编码助手。直接行动，不要过多解释。运行环境：${ENVIRONMENT_PROMPT}。`,
  tools: (tools: string[]) => `可用工具：${tools.join('、')}`,
  workspace: (ws: string) => `工作目录：${ws}`,
  memory: (mem: string) => `记忆：\n${mem}`,
  task: (task: string) => `当前任务：${task}`,
} as any;

// 组装函数
function assemblePrompt(context: PromptContext): string {
  const sections: string[] = [];
  sections.push(PROMPT_SECTIONS['identity'] as string);
  sections.push((PROMPT_SECTIONS['tools'] as unknown as (a: string[]) => string)(context.enabledTools));
  sections.push((PROMPT_SECTIONS['workspace'] as unknown as (s: string) => string)(context.workspace));
  if (context.memories) {
    sections.push((PROMPT_SECTIONS['memory'] as unknown as (s: string) => string)(context.memories));
  }
  if (context.activeTask) {
    sections.push((PROMPT_SECTIONS['task'] as unknown as (s: string) => string)(context.activeTask));
  }
  return sections.join('\n\n');
}

// 缓存：key = JSON.stringify(context)
let lastContextKey = '';
let lastPrompt = '';
let cacheHits = 0;

function mockLLM(messages: Message[]): LLMResponse {
  const round = messages.filter(m => m.role === 'assistant').length;
  if (round === 0) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '执行任务。' },
        { type: 'tool_use', id: 'tool_001', name: 'bash', input: { command: 'ls' } },
      ],
    };
  }
  if (round === 1) {
    // 第2轮相同上下文，应该命中缓存
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '继续执行。' },
        { type: 'tool_use', id: 'tool_002', name: 'bash', input: { command: 'pwd' } },
      ],
    };
  }
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '任务完成，提示词缓存命中2次。' }],
  };
}

const s10Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages, systemPrompt } = effect.input;
    const round = messages.filter(m => m.role === 'assistant').length;
    console.log(`\n[Chat] → 轮次 ${round + 1} (system: ${systemPrompt.length} 字符)`);
    await new Promise(r => setTimeout(r, 50));
    const response = await callChat(mockLLM, messages, { tools: schemasFor('bash'), system: systemPrompt });
    const tools = getToolUseBlocks(response).map(b => b.name).join(', ');
    console.log(`[LLM]  ← ${response.stop_reason}${tools ? ', 工具: ' + tools : ''}`);
    return response;
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    console.log(`[BashExec] → ${effect.input.command}`);
    return `(执行: ${effect.input.command})`;
  },

  AssemblePrompt: async (effect: AssemblePromptEffect): Promise<string> => {
    const contextKey = JSON.stringify(effect.input.context, Object.keys(effect.input.context).sort());

    if (contextKey === lastContextKey) {
      cacheHits++;
      console.log(`[AssemblePrompt] ✓ 缓存命中 (共 ${cacheHits} 次)`);
      return lastPrompt;
    }

    const prompt = assemblePrompt(effect.input.context);
    const sections = ['identity', 'tools', 'workspace'];
    if (effect.input.context.memories) sections.push('memory');
    if (effect.input.context.activeTask) sections.push('task');
    console.log(`[AssemblePrompt] 重新组装: [${sections.join(', ')}]`);

    lastContextKey = contextKey;
    lastPrompt = prompt;
    return prompt;
  },
};

// ============================================================
// Part 3: Agent Generator
// ============================================================

function* agentLoop(perform: PerformFn<S10Effect>) {
  const messages: Message[] = [
    { role: 'user', content: '帮我列出当前目录，然后输出工作路径。' },
  ];

  // 初始上下文
  let context: PromptContext = {
    enabledTools: ['bash', 'read_file', 'write_file'],
    workspace: process.cwd(),
  };

  while (true) {
    // 每轮组装（或从缓存获取）system prompt
    const systemPrompt = yield* perform({ type: 'AssemblePrompt', input: { context } });

    const response = yield* perform({ type: 'Chat', input: { messages, systemPrompt } });
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

    // 下一轮：更新上下文（如果有变化，下次 AssemblePrompt 会重新生成）
    // 例如：完成某个任务后，activeTask 可能变化
    context = { ...context };
  }
}

// ============================================================
// Part 4: 启动入口
// ============================================================

console.log('[S10] System Prompt 启动\n');

const result = await runAgent<S10Effect, string>(agentLoop, s10Handlers);

console.log('\n[S10] 完成:', result);
