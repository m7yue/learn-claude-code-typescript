/**
 * s02: Tool Use — 工具分发 = 类型路由
 *
 * 本章新增 4 个 Effect（在 s01 基础上扩展）：
 *   ReadFile   — 读取文件内容
 *   WriteFile  — 写入文件
 *   EditFile   — 替换文件片段
 *   GlobSearch — 文件通配搜索
 *
 * 核心原理：Effect.type 字符串 = 路由键。
 * runAgent() 的 handlers[effect.type] 自动完成分发，不需要任何 if/else。
 */

import { runAgent } from '../runtime/core.ts';
import type { BaseEffect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolUseBlock } from '../runtime/types.ts';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

// 继承自 s01
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

// s02 新增：文件操作工具
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

interface EditFileEffect extends BaseEffect {
  type: 'EditFile';
  input: { path: string; old_text: string; new_text: string };
  output: string;
}

interface GlobSearchEffect extends BaseEffect {
  type: 'GlobSearch';
  input: { pattern: string };
  output: string;
}

// s02 的 Effect Union：s01 的两个 + s02 新增的四个
type S02Effect =
  | ChatEffect
  | BashExecEffect
  | ReadFileEffect
  | WriteFileEffect
  | EditFileEffect
  | GlobSearchEffect;

// ============================================================
// Part 2: Handler 实现
// ============================================================

const WORKDIR = process.cwd();

// 安全路径校验：防止目录遍历攻击
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`[安全] 路径越界: ${p}`);
  }
  return resolved;
}

// Mock LLM：模拟三轮对话（读文件 → 写文件 → 结束）
function mockLLM(messages: Message[]): LLMResponse {
  const round = messages.filter(m => m.role === 'assistant').length;

  if (round === 0) {
    // 第1轮：同时调用两个工具（模型可以一次调用多个工具）
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '我来读取文件并写入输出。' },
        {
          type: 'tool_use',
          id: 'tool_001',
          name: 'read_file',
          input: { path: './package.json', limit: 5 },
        },
        {
          type: 'tool_use',
          id: 'tool_002',
          name: 'glob',
          input: { pattern: '*.ts' },
        },
      ],
    };
  }

  if (round === 1) {
    // 第2轮：写文件
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '已读取，现在写入摘要。' },
        {
          type: 'tool_use',
          id: 'tool_003',
          name: 'write_file',
          input: { path: '/tmp/s02_output.txt', content: '摘要: 项目包含多个 TypeScript 文件' },
        },
      ],
    };
  }

  // 第3轮：完成
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '已读取 package.json 并写入摘要到 /tmp/s02_output.txt' }],
  };
}

function extractText(response: LLMResponse): string {
  return response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('');
}

function getToolUseBlocks(response: LLMResponse): ToolUseBlock[] {
  return response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

const s02Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages } = effect.input;
    const toolNames = messages
      .flatMap(m => {
        try { return (JSON.parse(m.content) as Array<{ tool_use_id?: string }>).map(r => r.tool_use_id); }
        catch { return []; }
      })
      .filter(Boolean);
    console.log(`[Chat] → 发送 ${messages.length} 条消息...`);
    await new Promise(r => setTimeout(r, 50));
    const response = mockLLM(messages);
    const toolsInResponse = getToolUseBlocks(response).map(b => b.name).join(', ');
    console.log(`[LLM]  ← stop_reason: ${response.stop_reason}${toolsInResponse ? ', 工具: ' + toolsInResponse : ''}`);
    return response;
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    console.log(`[BashExec] → ${effect.input.command}`);
    return '(bash output)';
  },

  ReadFile: async (effect: ReadFileEffect): Promise<string> => {
    const { path: filePath, limit } = effect.input;
    console.log(`[ReadFile] → ${filePath}`);
    try {
      const safe = safePath(filePath);
      const content = fs.readFileSync(safe, 'utf8');
      const lines = content.split('\n');
      const result = limit ? lines.slice(0, limit).join('\n') : content;
      console.log(`[ReadFile] ← ${result.length} 字符`);
      return result;
    } catch {
      return `[错误] 无法读取文件: ${filePath}`;
    }
  },

  WriteFile: async (effect: WriteFileEffect): Promise<string> => {
    const { path: filePath, content } = effect.input;
    console.log(`[WriteFile] → ${filePath}`);
    try {
      const safe = safePath(filePath);
      fs.mkdirSync(path.dirname(safe), { recursive: true });
      fs.writeFileSync(safe, content, 'utf8');
      console.log(`[WriteFile] ← 写入 ${content.length} 字符`);
      return `已写入 ${filePath}`;
    } catch (e: unknown) {
      return `[错误] 无法写入文件: ${e instanceof Error ? e.message : String(e)}`;
    }
  },

  EditFile: async (effect: EditFileEffect): Promise<string> => {
    const { path: filePath, old_text, new_text } = effect.input;
    console.log(`[EditFile] → ${filePath}`);
    try {
      const safe = safePath(filePath);
      const content = fs.readFileSync(safe, 'utf8');
      if (!content.includes(old_text)) return `[错误] 未找到要替换的文本`;
      const updated = content.replace(old_text, new_text);
      fs.writeFileSync(safe, updated, 'utf8');
      return `已编辑 ${filePath}`;
    } catch (e: unknown) {
      return `[错误] 编辑失败: ${e instanceof Error ? e.message : String(e)}`;
    }
  },

  GlobSearch: async (effect: GlobSearchEffect): Promise<string> => {
    const { pattern } = effect.input;
    console.log(`[GlobSearch] → ${pattern}`);
    // 简单模拟：列出当前目录匹配的文件
    const files = fs.readdirSync(WORKDIR).filter(f => f.endsWith('.ts') || f.endsWith('.json'));
    const result = files.join('\n');
    console.log(`[GlobSearch] ← ${files.length} 个文件`);
    return result;
  },
};

// ============================================================
// Part 3: Agent Generator（业务逻辑）
// ============================================================

function* agentLoop(perform: PerformFn<S02Effect>) {
  const messages: Message[] = [
    { role: 'user', content: '读取 package.json 的前5行，然后把摘要写入 /tmp/s02_output.txt' },
  ];

  while (true) {
    const response = yield* perform({ type: 'Chat', input: { messages } });
    messages.push({ role: 'assistant', content: extractText(response) });

    if (response.stop_reason !== 'tool_use') {
      return extractText(response);
    }

    // 同一轮中可能有多个工具调用，逐一处理
    const toolResults: Array<{ tool_use_id: string; content: string }> = [];

    for (const block of getToolUseBlocks(response)) {
      let output: string;

      // 根据工具名 yield 对应 Effect
      // 等价于 Python: TOOL_HANDLERS[block.name](**block.input)
      switch (block.name) {
        case 'bash':
          output = yield* perform({
            type: 'BashExec',
            input: { command: block.input['command'] as string },
          });
          break;
        case 'read_file':
          output = yield* perform({
            type: 'ReadFile',
            input: {
              path: block.input['path'] as string,
              limit: block.input['limit'] as number | undefined,
            },
          });
          break;
        case 'write_file':
          output = yield* perform({
            type: 'WriteFile',
            input: {
              path: block.input['path'] as string,
              content: block.input['content'] as string,
            },
          });
          break;
        case 'edit_file':
          output = yield* perform({
            type: 'EditFile',
            input: {
              path: block.input['path'] as string,
              old_text: block.input['old_text'] as string,
              new_text: block.input['new_text'] as string,
            },
          });
          break;
        case 'glob':
          output = yield* perform({
            type: 'GlobSearch',
            input: { pattern: block.input['pattern'] as string },
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

console.log('[S02] Tool Use 启动\n');

const result = await runAgent<S02Effect, string>(agentLoop, s02Handlers);

console.log('\n[S02] 完成:', result);
