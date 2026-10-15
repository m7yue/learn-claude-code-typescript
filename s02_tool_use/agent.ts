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
import type { Effect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolResultBlock } from '../runtime/types.ts';
import { extractText, getToolUseBlocks } from '../runtime/response.ts';
import { callChat } from '../runtime/model.ts';
import { schemasFor } from '../runtime/tool-schemas.ts';
import { buildSystemPrompt } from '../runtime/system-prompt.ts';
import { WORKSPACE_ROOT } from '../runtime/workspace.ts';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

// 继承自 s01
interface ChatEffect extends Effect<'Chat', { messages: Message[] }, LLMResponse> {}

interface BashExecEffect extends Effect<'BashExec', { command: string }, string> {}

// s02 新增：文件操作工具
interface ReadFileEffect extends Effect<'ReadFile', { path: string; limit?: number }, string> {}

interface WriteFileEffect extends Effect<'WriteFile', { path: string; content: string }, string> {}

interface EditFileEffect extends Effect<'EditFile', { path: string; old_text: string; new_text: string }, string> {}

interface GlobSearchEffect extends Effect<'GlobSearch', { pattern: string }, string> {}

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

// 工作区根目录来自 runtime/workspace.ts（默认 process.cwd()，
// 可被 AGENT_WORKSPACE 覆盖，从而让 e2e 把副作用隔离到临时目录）。
const WORKDIR = WORKSPACE_ROOT;

// 本章演示产物目录（工作区相对路径，已 gitignore）。
const OUTPUT_DIR = './s02_tool_use/.output';
const OUTPUT_FILE = `${OUTPUT_DIR}/s02_output.txt`;

// 安全路径校验：把参数解析到工作区内；越界（含同前缀的兄弟目录）即抛错。
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const rel = path.relative(WORKDIR, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`[安全] 路径越界: ${p}`);
  }
  return resolved;
}

// ---------- 真实 glob：把 pattern 编译为正则，再在工作区内递归匹配 ----------
// glob 语义：`*` 不跨目录，`**` 可跨目录，`?` 匹配单个非分隔符字符。
function globToRegExp(pattern: string): RegExp {
  const escape = (c: string) => c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++; // 吃掉第二个 '*'
        if (pattern[i + 1] === '/') i++; // '**/' 也吞掉斜杠，允许零层目录
        re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += escape(ch);
    }
  }
  return new RegExp(`^${re}$`);
}

// 递归列出工作区内的相对路径（跳过 node_modules/.git，避免遍历开销与越界）。
function walkFiles(root: string, dir: string = root, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(root, full, acc);
    } else if (entry.isFile()) {
      acc.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
  return acc;
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
          input: { pattern: '**/*.ts' },
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
          input: { path: OUTPUT_FILE, content: '摘要: 项目包含多个 TypeScript 文件' },
        },
      ],
    };
  }

  // 第3轮：完成
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: `已读取 package.json 并写入摘要到 ${OUTPUT_FILE}` }],
  };
}

// real 模式注入的 system prompt，引导模型使用工具完成任务。
// mock 模式不读取该字段，故零配置运行行为不变。
const SYSTEM_PROMPT = buildSystemPrompt(
  '使用 bash、read_file、write_file、edit_file、glob 工具解决任务。直接行动，不要多解释。' +
    '本教学演示中 bash 是模拟的：只回显命令文本、不会真正执行，请不要依赖它的输出，文件操作请用文件工具。',
);

const s02Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages } = effect.input;
    console.log(`[Chat] → 发送 ${messages.length} 条消息...`);
    await new Promise(r => setTimeout(r, 50));
    const response = await callChat(mockLLM, messages, {
      tools: schemasFor('bash', 'read_file', 'write_file', 'edit_file', 'glob'),
      system: SYSTEM_PROMPT,
    });
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
    try {
      const matcher = globToRegExp(pattern);
      // 双重保险：只保留仍解析到工作区内的相对路径（不越界）。
      const files = walkFiles(WORKDIR).filter(rel => {
        if (!matcher.test(rel)) return false;
        const resolved = path.resolve(WORKDIR, rel);
        return resolved === WORKDIR || resolved.startsWith(WORKDIR + path.sep);
      });
      console.log(`[GlobSearch] ← ${files.length} 个文件`);
      return files.length > 0 ? files.join('\n') : '(no matches)';
    } catch (e: unknown) {
      return `[错误] glob 失败: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};

// ============================================================
// Part 3: Agent Generator（业务逻辑）
// ============================================================

function* agentLoop(perform: PerformFn<S02Effect>) {
  const messages: Message[] = [
    { role: 'user', content: `读取 package.json 的前5行，然后把摘要写入 ${OUTPUT_FILE}` },
  ];

  while (true) {
    const response = yield* perform({ type: 'Chat', input: { messages } });
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      return extractText(response);
    }

    // 同一轮中可能有多个工具调用，逐一处理
    const toolResults: ToolResultBlock[] = [];

    for (const block of getToolUseBlocks(response)) {
      try {
        let output: string;

        // 根据工具名 yield 对应 Effect
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

console.log('[S02] Tool Use 启动');
console.log(`工作区: ${WORKDIR}`);
console.log(`产物目录: ${OUTPUT_DIR}（已在 .gitignore 忽略）\n`);

const result = await runAgent<S02Effect, string>(agentLoop, s02Handlers);

console.log('\n[S02] 完成:', result);
