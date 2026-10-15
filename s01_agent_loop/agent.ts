/**
 * s01: Agent Loop — 一个驱动器就够了
 *
 * 本章引入两个 Effect：
 *   Chat     — 与 LLM 对话（获取响应 + stop_reason）
 *   BashExec — 执行 bash 命令
 *
 * 核心对照：
 *   模型 stop_reason == "tool_use"  →  Generator done === false（还有效应要处理）
 *   模型 stop_reason != "tool_use"  →  Generator done === true（任务完成）
 *   不断重复的对话轮次              →  runAgent() 内部驱动循环
 */

import { runAgent } from '../runtime/core.ts';
import type { Effect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolResultBlock } from '../runtime/types.ts';
import { extractText, getToolUseBlocks, messageText } from '../runtime/response.ts';
import { callChat } from '../runtime/model.ts';
import { schemasFor } from '../runtime/tool-schemas.ts';
import { buildSystemPrompt } from '../runtime/system-prompt.ts';
import { WORKSPACE_ROOT } from '../runtime/workspace.ts';
import { spawnSync } from 'node:child_process';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

interface ChatEffect extends Effect<'Chat', { messages: Message[] }, LLMResponse> {}

interface BashExecEffect extends Effect<'BashExec', { command: string }, string> {}

type S01Effect = ChatEffect | BashExecEffect;

// ============================================================
// Part 2: Handler 实现（所有副作用在此）
// ============================================================

// 真实模式下注入 system prompt，引导模型使用工具完成任务。
// mock 模式不读取该字段，故零配置运行行为不变。
const SYSTEM_PROMPT = buildSystemPrompt('使用 bash 工具解决任务。直接行动，不要多解释。');

// 工作区根目录（可用 AGENT_WORKSPACE 覆盖）。
const WORKDIR = WORKSPACE_ROOT;

// Mock LLM：用脚本模拟两轮对话
// 第1轮：调用 bash 工具（等价于 stop_reason == "tool_use"）
// 第2轮：给出最终答案（等价于 stop_reason == "end_turn"）
function mockLLM(messages: Message[]): LLMResponse {
  const round = messages.filter(m => m.role === 'assistant').length;

  if (round === 0) {
    // 第1轮：模型决定调用 bash 工具
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '我来帮你列出当前目录的文件。' },
        {
          type: 'tool_use',
          id: 'tool_001',
          name: 'bash',
          input: { command: 'ls -la' },
        },
      ],
    };
  }

  // 第2轮：模型看到工具结果，给出最终回答（把真实输出原样带回，不编造）
  const last = messages[messages.length - 1];
  return {
    stop_reason: 'end_turn',
    content: [
      { type: 'text', text: `当前目录包含：\n${last ? messageText(last.content) : '(没有拿到工具输出)'}` },
    ],
  };
}

const s01Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages } = effect.input;
    console.log(`[Chat] → 发送 ${messages.length} 条消息...`);
    await new Promise(r => setTimeout(r, 100)); // 模拟网络延迟
    const response = await callChat(mockLLM, messages, {
      tools: schemasFor('bash'),
      system: SYSTEM_PROMPT,
    });
    console.log(`[LLM]  ← stop_reason: ${response.stop_reason}`);
    return response;
  },

  // 真实执行：mock 只替代模型调用，命令本身交给系统 shell
  BashExec: async (effect: BashExecEffect): Promise<string> => {
    const { command } = effect.input;
    console.log(`[BashExec] → ${command}`);
    const r = spawnSync(command, {
      shell: true,
      cwd: WORKDIR,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (r.error) return `Error: ${r.error.message}`;
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    // 预览压成一行，避免多行输出把日志撑开
    console.log(`[BashExec] ← ${output.slice(0, 60).replace(/\n/g, ' ')}`);
    return output ? output.slice(0, 50_000) : '(no output)';
  },
};

// ============================================================
// Part 3: Agent Generator（业务逻辑，零副作用）
// ============================================================

function* agentLoop(perform: PerformFn<S01Effect>) {
  const messages: Message[] = [
    { role: 'user', content: '帮我列出当前目录的所有文件。' },
  ];

  while (true) {
    // 声明：我需要和 LLM 对话
    const response = yield* perform({ type: 'Chat', input: { messages } });

    // 将模型回答追加到对话历史
    messages.push({ role: 'assistant', content: response.content });

    // 模型说"我做完了" → 退出
    if (response.stop_reason !== 'tool_use') {
      const finalText = extractText(response);
      return finalText;
    }

    // 执行所有工具调用，收集结果
    const toolResults: ToolResultBlock[] = [];
    for (const block of getToolUseBlocks(response)) {
      try {
        // 声明：我需要执行 bash 命令
        const output = yield* perform({
          type: 'BashExec',
          input: { command: block.input['command'] as string },
        });
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

    // 将工具结果喂回对话
    messages.push({
      role: 'user',
      content: toolResults,
    });
  }
}

// ============================================================
// Part 4: 启动入口
// ============================================================

console.log('[S01] Agent Loop 启动\n');

const result = await runAgent<S01Effect, string>(agentLoop, s01Handlers);

console.log('\n[S01] 完成:', result);
