/**
 * s09: Memory — 跨会话的效应持久化
 *
 * 本章新增 3 个 Effect：
 *   ReadMemory    — 读取记忆索引或单个记忆文件
 *   WriteMemory   — 写入新记忆（附 YAML frontmatter）
 *   SelectMemory  — 基于当前对话选择相关记忆
 *
 * 记忆系统架构：
 *   .memory/MEMORY.md      — 索引（始终注入 system）
 *   .memory/{name}.md      — 单个记忆文件（按需加载）
 *   类型: user / feedback / project / reference
 */

import { runAgent } from '../runtime/core.ts';
import type { BaseEffect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolUseBlock } from '../runtime/types.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

interface ChatEffect extends BaseEffect {
  type: 'Chat';
  input: { messages: Message[]; systemPrompt?: string };
  output: LLMResponse;
}

interface BashExecEffect extends BaseEffect {
  type: 'BashExec';
  input: { command: string };
  output: string;
}

// s09 新增：记忆管理
type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

interface MemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

interface ReadMemoryEffect extends BaseEffect {
  type: 'ReadMemory';
  input: { filename?: string }; // 无 filename 则读索引
  output: string;
}

interface WriteMemoryEffect extends BaseEffect {
  type: 'WriteMemory';
  input: MemoryEntry;
  output: string; // 确认消息
}

interface SelectMemoryEffect extends BaseEffect {
  type: 'SelectMemory';
  input: { context: string; maxItems?: number };
  output: string[]; // 相关记忆文件名列表
}

type S09Effect = ChatEffect | BashExecEffect | ReadMemoryEffect | WriteMemoryEffect | SelectMemoryEffect;

// ============================================================
// Part 2: Handler 实现
// ============================================================

const MEMORY_DIR = path.join(os.tmpdir(), 'learn-claude-code-typescript', 's09', 'memory');
const MEMORY_INDEX = path.join(MEMORY_DIR, 'MEMORY.md');

function ensureMemoryDir() {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

function rebuildIndex() {
  const files = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
  const lines = files.map(f => {
    try {
      const content = fs.readFileSync(path.join(MEMORY_DIR, f), 'utf8');
      const match = content.match(/description:\s*(.+)/);
      const desc = match ? match[1].trim() : '（无描述）';
      return `- [${f.replace('.md', '')}](${f}) — ${desc}`;
    } catch { return `- ${f}`; }
  });
  fs.writeFileSync(MEMORY_INDEX, lines.join('\n'), 'utf8');
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
        { type: 'text', text: '我来记录用户偏好。' },
        {
          type: 'tool_use', id: 'tool_001', name: 'write_memory',
          input: {
            name: 'user-prefers-tabs',
            type: 'feedback',
            description: '用户偏好使用 Tab 而非空格缩进',
            body: '用户明确表示喜欢 Tab 缩进。\n\n**Why:** 用户说"用空格的代码看着头疼"。\n**How to apply:** 在生成代码时始终用 Tab。',
          },
        },
      ],
    };
  }
  if (round === 1) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '再读一下当前的记忆列表。' },
        { type: 'tool_use', id: 'tool_002', name: 'read_memory', input: {} },
      ],
    };
  }
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '记忆已保存。下次对话时，我会记住你喜欢 Tab 缩进。' }],
  };
}

const s09Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages, systemPrompt } = effect.input;
    const round = messages.filter(m => m.role === 'assistant').length;
    console.log(`\n[Chat] → 轮次 ${round + 1}`);
    if (systemPrompt?.includes('MEMORY')) console.log(`[System] 包含记忆索引`);
    await new Promise(r => setTimeout(r, 50));
    const response = mockLLM(messages);
    const tools = getToolUseBlocks(response).map(b => b.name).join(', ');
    console.log(`[LLM]  ← ${response.stop_reason}${tools ? ', 工具: ' + tools : ''}`);
    return response;
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    return `(执行: ${effect.input.command})`;
  },

  ReadMemory: async (effect: ReadMemoryEffect): Promise<string> => {
    ensureMemoryDir();
    if (effect.input.filename) {
      const filePath = path.join(MEMORY_DIR, effect.input.filename);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        console.log(`[ReadMemory] 读取: ${effect.input.filename}`);
        return content;
      } catch { return `[错误] 未找到记忆: ${effect.input.filename}`; }
    }
    // 读索引
    try {
      const index = fs.readFileSync(MEMORY_INDEX, 'utf8');
      console.log(`[ReadMemory] 读取索引 (${index.length} 字符)`);
      return index || '（记忆库为空）';
    } catch { return '（记忆库为空）'; }
  },

  WriteMemory: async (effect: WriteMemoryEffect): Promise<string> => {
    ensureMemoryDir();
    const { name, type, description, body } = effect.input;
    const filename = `${name}.md`;
    const content = `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n\n${body}`;
    fs.writeFileSync(path.join(MEMORY_DIR, filename), content, 'utf8');
    rebuildIndex();
    console.log(`[WriteMemory] 保存: ${filename}`);
    return `记忆已保存: ${filename}`;
  },

  SelectMemory: async (effect: SelectMemoryEffect): Promise<string[]> => {
    ensureMemoryDir();
    const { context, maxItems = 5 } = effect.input;
    const files = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
    // 简单关键词匹配（真实实现用 LLM 选择）
    const keywords = context.toLowerCase().split(/\s+/);
    const scored = files.map(f => {
      const content = fs.readFileSync(path.join(MEMORY_DIR, f), 'utf8').toLowerCase();
      const score = keywords.filter(k => content.includes(k)).length;
      return { file: f, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    const selected = scored.slice(0, maxItems).map(x => x.file);
    console.log(`[SelectMemory] 选中 ${selected.length} 个相关记忆`);
    return selected;
  },
};

// ============================================================
// Part 3: Agent Generator
// ============================================================

function* agentLoop(perform: PerformFn<S09Effect>) {
  // 启动时：读取记忆索引，注入 system prompt
  const memoryIndex = yield* perform({ type: 'ReadMemory', input: {} });
  const systemPrompt = `你是编码助手。

MEMORY（用户偏好与项目记忆）：
${memoryIndex || '（无记忆）'}

当用户表达偏好或提供重要信息时，用 write_memory 工具保存记忆。`;

  const messages: Message[] = [
    { role: 'user', content: '记住我喜欢用 Tab 缩进，以后生成代码都用 Tab。' },
  ];

  while (true) {
    const response = yield* perform({ type: 'Chat', input: { messages, systemPrompt } });
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
        case 'read_memory':
          output = yield* perform({ type: 'ReadMemory', input: { filename: block.input['filename'] as string | undefined } });
          break;
        case 'write_memory':
          output = yield* perform({
            type: 'WriteMemory',
            input: block.input as unknown as MemoryEntry,
          });
          break;
        case 'select_memory':
          const selected = yield* perform({
            type: 'SelectMemory',
            input: { context: block.input['context'] as string },
          });
          output = selected.join('\n');
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

console.log('[S09] Memory 启动\n');
console.log(`记忆目录: ${MEMORY_DIR}\n`);

const result = await runAgent<S09Effect, string>(agentLoop, s09Handlers);

console.log('\n[S09] 完成:', result);
