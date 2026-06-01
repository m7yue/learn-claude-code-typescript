/**
 * s01: Agent Loop — 一个驱动器就够了
 *
 * 本章引入两个 Effect：
 *   Chat     — 与 LLM 对话（获取响应 + stop_reason）
 *   BashExec — 执行 bash 命令
 *
 * 核心等价关系：
 *   Python stop_reason == "tool_use"  →  Generator done === false（还有效应要处理）
 *   Python stop_reason != "tool_use"  →  Generator done === true（任务完成）
 *   Python while True                 →  runAgent() 内部驱动循环
 */

import { runAgent } from '../runtime/core.ts';
import type { BaseEffect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolUseBlock } from '../runtime/types.ts';

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

type S01Effect = ChatEffect | BashExecEffect;

// ============================================================
// Part 2: Handler 实现（所有副作用在此）
// ============================================================

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
          input: { command: 'echo "file1.ts\nfile2.ts\nREADME.md"' },
        },
      ],
    };
  }

  // 第2轮：模型看到工具结果，给出最终回答
  return {
    stop_reason: 'end_turn',
    content: [
      { type: 'text', text: '当前目录包含：file1.ts, file2.ts, README.md' },
    ],
  };
}

// 提取 LLMResponse 中的文本内容
function extractText(response: LLMResponse): string {
  return response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('');
}

// 提取 LLMResponse 中的工具调用块
function getToolUseBlocks(response: LLMResponse): ToolUseBlock[] {
  return response.content.filter(
    (b): b is ToolUseBlock => b.type === 'tool_use'
  );
}

const s01Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages } = effect.input;
    console.log(`[Chat] → 发送 ${messages.length} 条消息...`);
    await new Promise(r => setTimeout(r, 100)); // 模拟网络延迟
    const response = mockLLM(messages);
    console.log(`[LLM]  ← stop_reason: ${response.stop_reason}`);
    return response;
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    const { command } = effect.input;
    console.log(`[BashExec] → ${command}`);
    // 教学演示：只模拟执行，不真正 fork 进程
    const output = `file1.ts\nfile2.ts\nREADME.md`;
    console.log(`[BashExec] ← ${output.slice(0, 60)}`);
    return output;
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
    // 等价于 Python: response = client.messages.create(...)
    const response = yield* perform({ type: 'Chat', input: { messages } });

    // 将模型回答追加到对话历史
    messages.push({ role: 'assistant', content: extractText(response) });

    // 模型说"我做完了" → 退出
    // 等价于 Python: if response.stop_reason != "tool_use": return
    if (response.stop_reason !== 'tool_use') {
      const finalText = extractText(response);
      return finalText;
    }

    // 执行所有工具调用，收集结果
    const toolResults: Array<{ tool_use_id: string; content: string }> = [];
    for (const block of getToolUseBlocks(response)) {
      // 声明：我需要执行 bash 命令
      // 等价于 Python: output = TOOL_HANDLERS[block.name](**block.input)
      const output = yield* perform({
        type: 'BashExec',
        input: { command: block.input['command'] as string },
      });
      toolResults.push({ tool_use_id: block.id, content: output });
    }

    // 将工具结果喂回对话
    // 等价于 Python: messages.append({"role": "user", "content": results})
    messages.push({
      role: 'user',
      content: JSON.stringify(toolResults),
    });
  }
}

// ============================================================
// Part 4: 启动入口
// ============================================================

console.log('[S01] Agent Loop 启动\n');

const result = await runAgent<S01Effect, string>(agentLoop, s01Handlers);

console.log('\n[S01] 完成:', result);
