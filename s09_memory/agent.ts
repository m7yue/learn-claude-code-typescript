/**
 * s09: Memory — 跨会话的效应持久化
 *
 * 本章新增 5 个 Effect：
 *   ReadMemory          — 读取记忆索引或单个记忆文件（真实文件 I/O）
 *   WriteMemory         — 写入新记忆（附 YAML frontmatter，真实文件 I/O）
 *   SelectMemory        — 用真实 LLM 调用按上下文挑选相关记忆（关键词回退）
 *   ExtractMemories     — 每轮结束后用真实 LLM 调用抽取新记忆并写入磁盘
 *   ConsolidateMemories — 文件数达阈值时用真实 LLM 调用合并/去重记忆
 *
 * 记忆生命周期：
 *   进场 — 读 MEMORY.md 索引注入 system；用 SelectMemory 挑出相关记忆，
 *          前缀注入到当前用户轮次（记忆是背景知识，不是新指令）
 *   出场 — 一轮对话结束：ExtractMemories 用 LLM 抽取新记忆并写入磁盘；
 *          文件数达阈值时 ConsolidateMemories 用 LLM 合并去重
 *
 * 记忆系统架构：
 *   .memory/MEMORY.md      — 索引（始终注入 system；一行一条：name + description）
 *   .memory/{slug}.md      — 单个记忆文件（Markdown + YAML frontmatter，按需加载）
 *   类型: user / feedback / project / reference
 *
 * 关键原则：mock 只替换「模型调用」本身，记忆文件存储、select / extract /
 * consolidate 三条链路都走真实的 callChat(...)；因此 mock / real 两种模式
 * 共用同一条机制，只是模型实现不同。
 *
 * 持久化落点来自 runtime/workspace.ts（工作区相对路径）：
 *   .memory/             — 记忆文件与 MEMORY.md 索引
 */

import { runAgent } from '../runtime/core.ts';
import type { Effect, PerformFn } from '../runtime/core.ts';
import type {
  Message,
  MessageContent,
  TextBlock,
  LLMResponse,
  ToolResultBlock,
} from '../runtime/types.ts';
import { extractText, getToolUseBlocks } from '../runtime/response.ts';
import { callChat } from '../runtime/model.ts';
import { schemasFor } from '../runtime/tool-schemas.ts';
import { baseSystemPrompt } from '../runtime/system-prompt.ts';
import { MEMORY_DIR, MEMORY_INDEX_PATH, WORKSPACE_ROOT } from '../runtime/workspace.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

interface ChatEffect extends Effect<'Chat', { messages: Message[]; systemPrompt?: string }, LLMResponse> {}

interface BashExecEffect extends Effect<'BashExec', { command: string }, string> {}

type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

interface MemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

interface ReadMemoryEffect extends Effect<'ReadMemory', { filename?: string }, string> {} // 无 filename 则读索引

interface WriteMemoryEffect extends Effect<'WriteMemory', MemoryEntry, string> {} // 确认消息

interface SelectMemoryEffect extends Effect<
  'SelectMemory',
  { context: string; maxItems?: number },
  string[]
> {} // 相关记忆文件名列表

// s09 新增：LLM 驱动的抽取与合并
interface ExtractMemoriesEffect extends Effect<
  'ExtractMemories',
  { messages: Message[] },
  number
> {} // 抽取并写入的新记忆条数

interface ConsolidateMemoriesEffect extends Effect<
  'ConsolidateMemories',
  { threshold?: number },
  { from: number; to: number } | null
> {} // 合并前/后的记忆条数；未触发返回 null

type S09Effect =
  | ChatEffect
  | BashExecEffect
  | ReadMemoryEffect
  | WriteMemoryEffect
  | SelectMemoryEffect
  | ExtractMemoriesEffect
  | ConsolidateMemoriesEffect;

// ============================================================
// Part 2: 记忆文件存储（真实文件 I/O）
// ============================================================

const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference'];

// 解析 `---` 包裹的 YAML frontmatter（扁平 k: v）。
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const parts = text.split('---', 3); // 最多切出 3 段；正文里若再出现 `---`，其后的内容会被丢弃。
  if (parts.length < 3) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of parts[1].trim().split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx >= 0) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      if (key) meta[key] = value;
    }
  }
  return { meta, body: parts[2].trim() };
}

// 把记忆名转成安全的文件名：小写，字母数字与 . _ - 之外的字符一律换成连字符。
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+/, '') || 'memory';
}

// 记忆文件列表（按文件名排序，排除索引）。
interface MemoryFile extends MemoryEntry {
  filename: string;
}

function sortedMemoryFileNames(): string[] {
  if (!fs.existsSync(MEMORY_DIR)) return [];
  return fs
    .readdirSync(MEMORY_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
    .sort();
}

/** 把任意 type 字段规范化为合法记忆类型；无法识别时回退到 'user'。 */
function normalizeType(value: unknown): MemoryType {
  const s = String(value ?? '').trim();
  return (MEMORY_TYPES as readonly string[]).includes(s) ? (s as MemoryType) : 'user';
}

function listMemoryFiles(): MemoryFile[] {
  return sortedMemoryFileNames().map((filename) => {
    const raw = fs.readFileSync(path.join(MEMORY_DIR, filename), 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    return {
      filename,
      name: meta['name'] || filename.replace(/\.md$/, ''),
      description: meta['description'] || '',
      type: normalizeType(meta['type']),
      body,
    };
  });
}

// 从所有记忆文件重建 MEMORY.md 索引。
function rebuildIndex(): void {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const lines: string[] = [];
  for (const filename of sortedMemoryFileNames()) {
    const raw = fs.readFileSync(path.join(MEMORY_DIR, filename), 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const name = meta['name'] || filename.replace(/\.md$/, '');
    const desc = meta['description'] || body.split('\n')[0].slice(0, 80);
    lines.push(`- [${name}](${filename}) — ${desc}`);
  }
  fs.writeFileSync(MEMORY_INDEX_PATH, lines.length ? lines.join('\n') + '\n' : '', 'utf8');
}

// 记忆文件名 → MEMORY_DIR 内的绝对路径；越界（含同前缀的兄弟目录）返回 null。
function memoryFilePath(filename: string): string | null {
  const base = path.resolve(MEMORY_DIR);
  const filePath = path.resolve(base, filename);
  if (filePath !== base && !filePath.startsWith(base + path.sep)) return null;
  return filePath;
}

// 写单个记忆文件并重建索引。
function writeMemoryFile(entry: MemoryEntry): string {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const filename = `${slugify(entry.name)}.md`;
  // slugify 已过滤分隔符，这里再兜一次底：文件名无论如何不能跑出 .memory/。
  const filePath = memoryFilePath(filename);
  if (!filePath) throw new Error(`非法的记忆文件名: ${filename}`);
  const content =
    `---\nname: ${entry.name}\ndescription: ${entry.description}\ntype: ${entry.type}\n---\n\n${entry.body}\n`;
  fs.writeFileSync(filePath, content, 'utf8');
  rebuildIndex();
  return filename;
}

// 读取记忆索引（不存在或为空时返回 ""）。
function readMemoryIndex(): string {
  if (!fs.existsSync(MEMORY_INDEX_PATH)) return '';
  return fs.readFileSync(MEMORY_INDEX_PATH, 'utf8').trim();
}

// 读取单个记忆文件（不存在返回 null）；额外做路径逃逸防护。
function readMemoryFile(filename: string): string | null {
  const filePath = memoryFilePath(filename);
  if (!filePath || !fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

// ============================================================
// Part 2b: 纯辅助函数（消息 → 文本）
// ============================================================

// 只取文本块。
function textOnly(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join(' ');
}

// 取最近 3 条 user 文本拼成 context（截断 2000 字符）。
function recentUserText(messages: Message[]): string {
  const texts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const text = textOnly(msg.content);
    if (text) texts.push(text);
    if (texts.length >= 3) break;
  }
  return texts.reverse().join(' ').slice(0, 2000);
}

// 最近 10 条消息拼成 `role: content` 对话（跳过空文本）。
function recentDialogue(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages.slice(-10)) {
    const text = textOnly(msg.content);
    if (text.trim()) parts.push(`${msg.role}: ${text}`);
  }
  return parts.join('\n');
}

// 从 LLM 返回的文本里提取 JSON 数组；greedy（最长匹配）为 true 时匹配到最后一个 `]`，为 false 时匹配到第一个。
function extractJsonArray(text: string, greedy: boolean): unknown[] | null {
  const match = text.match(greedy ? /\[[\s\S]*\]/ : /\[[\s\S]*?\]/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// 把 LLM 返回的原始项规范化为 MemoryEntry。
// 兼容 s09（name/type/description/body）与 s20（key/content）两种方言。
function coerceEntry(raw: unknown, fallbackName: string): MemoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = String(r['name'] ?? r['key'] ?? fallbackName).trim() || fallbackName;
  const body = String(r['body'] ?? r['content'] ?? '').trim();
  const description =
    String(r['description'] ?? '').trim() || body.split('\n')[0].slice(0, 80);
  if (!body) return null;
  return { name, type: normalizeType(r['type']), description, body };
}

// ============================================================
// Part 3: mock 模型（只替换「模型调用」，不替换机制）
// ============================================================

// 主对话模型：模型驱动的 write_memory → select_memory → 收尾。
function mockLLM(messages: Message[]): LLMResponse {
  const round = messages.filter((m) => m.role === 'assistant').length;
  if (round === 0) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '我来记录用户偏好。' },
        {
          type: 'tool_use',
          id: 'tool_write',
          name: 'write_memory',
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
        { type: 'text', text: '再检索一下相关记忆。' },
        {
          type: 'tool_use',
          id: 'tool_select',
          name: 'select_memory',
          input: { context: 'Tab 缩进 代码风格 用户偏好' },
        },
      ],
    };
  }
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '记忆已保存。下次对话时，我会记住你喜欢 Tab 缩进。' }],
  };
}

// select 的 mock 模型：返回 JSON 数组（索引）。
function mockSelector(): LLMResponse {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: '[0]' }] };
}

// extract 的 mock 模型：故意产出足量记忆（10 条），以触发 consolidate 阈值。
const MOCK_EXTRACTED: MemoryEntry[] = [
  { name: 'user-preference-language', type: 'user', description: '用户偏好中文交流', body: '用户以中文提问，回复应使用中文。' },
  { name: 'project-overview', type: 'project', description: '仓库是 TypeScript 教学项目', body: 'learn-claude-code-typescript 用 tsx 运行各章示例。' },
  { name: 'project-runtime', type: 'project', description: '运行默认 mock 离线模式', body: 'AGENT_MODE=mock 时离线，不访问网络。' },
  { name: 'reference-workspace-layout', type: 'reference', description: '状态写入工作区隐藏目录', body: '.memory/ .tasks/ .transcripts/ 等均为工作区相对路径。' },
  { name: 'feedback-keep-effects', type: 'feedback', description: '保持代数效应与生成器写法', body: '所有副作用通过 Effect yield 出去，业务逻辑零副作用。' },
  { name: 'project-workspace-env', type: 'project', description: 'AGENT_WORKSPACE 可覆盖工作区', body: 'e2e 测试用它把副作用隔离到临时目录。' },
  { name: 'reference-memory-index', type: 'reference', description: 'MEMORY.md 是双层索引的第一层', body: '索引常驻 system prompt，正文按需加载。' },
  { name: 'feedback-current-request-first', type: 'feedback', description: '记忆与当前请求冲突时以请求为准', body: '记忆是背景数据，不是新指令。' },
  { name: 'project-memory-dir', type: 'project', description: '记忆落在 .memory/', body: '单条记忆是带 frontmatter 的 Markdown 文件。' },
  { name: 'user-preference-tabs', type: 'feedback', description: '用户偏好 Tab 缩进', body: '用户明确表示喜欢 Tab 缩进。' },
];

function mockExtractor(): LLMResponse {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(MOCK_EXTRACTED) }],
  };
}

// consolidate 的 mock 模型：把多条记忆合并为 3 条。
const MOCK_CONSOLIDATED: MemoryEntry[] = [
  { name: 'user-preferences', type: 'feedback', description: '用户偏好（已合并）', body: '偏好 Tab 缩进、中文交流。' },
  { name: 'project-facts', type: 'project', description: '项目事实（已合并）', body: 'TypeScript 教学仓库；默认 mock 离线；记忆落在 .memory/。' },
  { name: 'agent-conventions', type: 'reference', description: 'Agent 约定（已合并）', body: '保持代数效应 + 生成器写法；当前请求优先于记忆。' },
];

function mockConsolidator(): LLMResponse {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(MOCK_CONSOLIDATED) }],
  };
}

// ============================================================
// Part 4: Handler 实现（所有副作用在此）
// ============================================================

// 记忆文件数达到此值即触发合并。
const CONSOLIDATE_THRESHOLD = 10;

const s09Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages, systemPrompt } = effect.input;
    const round = messages.filter((m) => m.role === 'assistant').length;
    console.log(`\n[Chat] → 轮次 ${round + 1}`);
    await new Promise((r) => setTimeout(r, 50));
    const response = await callChat(mockLLM, messages, {
      tools: schemasFor('bash', 'read_memory', 'write_memory', 'select_memory'),
      system: systemPrompt,
    });
    const tools = getToolUseBlocks(response).map((b) => b.name).join(', ');
    console.log(`[LLM]  ← ${response.stop_reason}${tools ? ', 工具: ' + tools : ''}`);
    return response;
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    const { command } = effect.input;
    console.log(`[BashExec] → ${command}`);
    const r = spawnSync(command, {
      shell: true,
      cwd: WORKSPACE_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    return out ? out.slice(0, 50_000) : '(no output)';
  },

  ReadMemory: async (effect: ReadMemoryEffect): Promise<string> => {
    if (effect.input.filename) {
      const content = readMemoryFile(effect.input.filename);
      if (content === null) {
        console.log(`[ReadMemory] 未找到: ${effect.input.filename}`);
        return '';
      }
      console.log(`[ReadMemory] 读取: ${effect.input.filename}`);
      return content;
    }
    const index = readMemoryIndex();
    console.log(`[ReadMemory] 读取索引 (${index.length} 字符)`);
    return index;
  },

  WriteMemory: async (effect: WriteMemoryEffect): Promise<string> => {
    const filename = writeMemoryFile(effect.input);
    console.log(`[WriteMemory] 保存: ${filename}`);
    return `记忆已保存: ${filename}`;
  },

  // s09 核心：真实 LLM 调用挑选相关记忆；解析失败/无结果时关键词回退。
  SelectMemory: async (effect: SelectMemoryEffect): Promise<string[]> => {
    const { context, maxItems = 5 } = effect.input;
    const files = listMemoryFiles();
    if (files.length === 0) return [];

    const recent = context.trim();
    if (!recent) return [];

    const catalog = files.map((f, i) => `${i}: ${f.name} — ${f.description}`).join('\n');
    const prompt =
      'Given the recent conversation and the memory catalog below, ' +
      'select the indices of memories that are clearly relevant. ' +
      'Return ONLY a JSON array of integers, e.g. [0, 3]. ' +
      'If none are relevant, return [].\n\n' +
      `Recent conversation:\n${recent}\n\n` +
      `Memory catalog:\n${catalog}`;

    try {
      const response = await callChat(mockSelector, [{ role: 'user', content: prompt }], {
        maxTokens: 200,
      });
      const indices = extractJsonArray(extractText(response).trim(), false);
      if (indices) {
        const selected: string[] = [];
        for (const idx of indices) {
          if (typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 && idx < files.length) {
            selected.push(files[idx].filename);
            if (selected.length >= maxItems) break;
          }
        }
        console.log(`[SelectMemory] LLM 选中 ${selected.length} 个相关记忆`);
        return selected;
      }
    } catch {
      // 落到关键词回退
    }

    // 回退：对 name + description 做关键词匹配。
    const keywords = recent
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);
    const selected: string[] = [];
    for (const f of files) {
      const hay = `${f.name} ${f.description}`.toLowerCase();
      if (keywords.some((kw) => hay.includes(kw))) {
        selected.push(f.filename);
        if (selected.length >= maxItems) break;
      }
    }
    console.log(`[SelectMemory] 关键词回退选中 ${selected.length} 个相关记忆`);
    return selected;
  },

  // s09 核心：每轮结束后用真实 LLM 调用抽取新记忆并写入文件。
  ExtractMemories: async (effect: ExtractMemoriesEffect): Promise<number> => {
    const dialogue = recentDialogue(effect.input.messages);
    if (!dialogue.trim()) return 0;

    const existing = listMemoryFiles();
    const existingDesc = existing.length
      ? existing.map((m) => `- ${m.name}: ${m.description}`).join('\n')
      : '(none)';

    const prompt =
      'Extract user preferences, constraints, or project facts from this dialogue.\n' +
      'Return a JSON array. Each item: {name, type, description, body}.\n' +
      "- name: short kebab-case identifier (e.g. 'user-preference-tabs')\n" +
      "- type: one of 'user' (user preference), 'feedback' (guidance), " +
      "'project' (project fact), 'reference' (external pointer)\n" +
      '- description: one-line summary for index lookup\n' +
      '- body: full detail in markdown\n' +
      'If nothing new or already covered by existing memories, return [].\n\n' +
      `Existing memories:\n${existingDesc}\n\n` +
      `Dialogue:\n${dialogue.slice(0, 4000)}`;

    try {
      const response = await callChat(mockExtractor, [{ role: 'user', content: prompt }], {
        maxTokens: 800,
      });
      const items = extractJsonArray(extractText(response).trim(), true);
      if (!items || items.length === 0) return 0;

      let count = 0;
      for (const raw of items) {
        const entry = coerceEntry(raw, `memory-${Date.now()}`);
        if (entry) {
          writeMemoryFile(entry);
          count += 1;
        }
      }
      if (count) console.log(`\n[Memory: extracted ${count} new memories]`);
      return count;
    } catch {
      return 0;
    }
  },

  // s09 核心：文件数 ≥ 阈值时用真实 LLM 调用合并/去重。
  ConsolidateMemories: async (effect: ConsolidateMemoriesEffect): Promise<{ from: number; to: number } | null> => {
    const threshold = effect.input.threshold ?? CONSOLIDATE_THRESHOLD;
    const files = listMemoryFiles();
    if (files.length < threshold) return null;

    const catalog = files
      .map((f) => `## ${f.filename}\nname: ${f.name}\ndescription: ${f.description}\n${f.body}`)
      .join('\n\n');

    const prompt =
      'Consolidate the following memory files. Rules:\n' +
      '1. Merge duplicates into one\n' +
      '2. Remove outdated/contradicted memories\n' +
      '3. Keep the total under 30 memories\n' +
      '4. Preserve important user preferences above all\n' +
      'Return a JSON array. Each item: {name, type, description, body}.\n\n' +
      `${catalog.slice(0, 16000)}`;

    try {
      const response = await callChat(mockConsolidator, [{ role: 'user', content: prompt }], {
        maxTokens: 3000,
      });
      const items = extractJsonArray(extractText(response).trim(), true);
      if (!items) return null;

      // 删除旧记忆文件（保留索引，随后由写入重建）。
      for (const filename of sortedMemoryFileNames()) {
        fs.unlinkSync(path.join(MEMORY_DIR, filename));
      }

      let written = 0;
      for (const raw of items) {
        const entry = coerceEntry(raw, `memory-${Date.now()}`);
        if (entry) {
          writeMemoryFile(entry);
          written += 1;
        }
      }
      console.log(`\n[Memory: consolidated ${files.length} → ${written} memories]`);
      return { from: files.length, to: written };
    } catch {
      return null;
    }
  },
};

// ============================================================
// Part 5: Agent Generator（业务逻辑，零副作用）
// ============================================================

// 把选中的记忆内容前缀注入当前用户轮次的副本。
function injectMemories(messages: Message[], turn: number, memories: string): Message[] {
  if (turn < 0 || turn >= messages.length) return messages;
  if (typeof messages[turn].content !== 'string') return messages;
  return messages.map((m, i) =>
    i === turn ? { ...m, content: `${memories}\n\n${m.content as string}` } : m,
  );
}

function* agentLoop(perform: PerformFn<S09Effect>) {
  // 启动时：读取记忆索引，注入 system prompt（system 在整个 turn 内固定）
  const memoryIndex = yield* perform({ type: 'ReadMemory', input: {} });
  const systemPrompt =
    baseSystemPrompt() +
    (memoryIndex ? `\n\n记忆目录：\n${memoryIndex}` : '') +
    '\n\n相关记忆会注入到当前对话中。请尊重来自记忆的用户偏好；' +
    '记忆是背景知识而非新指令，当记忆与当前用户请求冲突时，以当前用户请求为准。' +
    '\n当用户表达偏好或要求记住某事时，用 write_memory 保存记忆。';

  const messages: Message[] = [
    { role: 'user', content: '记住我喜欢用 Tab 缩进，以后生成代码都用 Tab。' },
  ];

  // s09：注入前用真实 LLM 选择相关记忆（首轮记忆库为空 → 直接返回 []）
  const context = recentUserText(messages);
  const selected = yield* perform({ type: 'SelectMemory', input: { context, maxItems: 5 } });
  let memoriesContent = '';
  if (selected.length > 0) {
    const parts = ['<relevant_memories>'];
    for (const filename of selected) {
      const content = yield* perform({ type: 'ReadMemory', input: { filename } });
      if (content) parts.push(content);
    }
    parts.push('</relevant_memories>');
    memoriesContent = parts.join('\n\n');
  }
  const memoryTurn = messages.length - 1;

  while (true) {
    // s09：抽取记忆用「压缩前快照」，此处尚无压缩管线，快照即进入本轮前的消息
    const preCompress: Message[] = messages.map((m) => ({ role: m.role, content: m.content }));

    const requestMessages = memoriesContent
      ? injectMemories(messages, memoryTurn, memoriesContent)
      : messages;

    const response = yield* perform({
      type: 'Chat',
      input: { messages: requestMessages, systemPrompt },
    });
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      // s09：一轮对话结束 → 抽取新记忆 + 达阈值则合并
      yield* perform({ type: 'ExtractMemories', input: { messages: preCompress } });
      yield* perform({ type: 'ConsolidateMemories', input: {} });
      return extractText(response);
    }

    const toolResults: ToolResultBlock[] = [];

    for (const block of getToolUseBlocks(response)) {
      console.log(`> ${block.name}`);
      try {
        let output: string;
        switch (block.name) {
          case 'bash':
            output = yield* perform({
              type: 'BashExec',
              input: { command: block.input['command'] as string },
            });
            break;
          case 'read_memory':
            output = yield* perform({
              type: 'ReadMemory',
              input: { filename: block.input['filename'] as string | undefined },
            });
            break;
          case 'write_memory': {
            const entry = coerceEntry(block.input, `memory-${Date.now()}`);
            if (!entry) {
              output = '[错误] write_memory 缺少 body';
              break;
            }
            output = yield* perform({ type: 'WriteMemory', input: entry });
            break;
          }
          case 'select_memory': {
            const selectedFiles = yield* perform({
              type: 'SelectMemory',
              input: { context: String(block.input['context'] ?? ''), maxItems: 5 },
            });
            output = selectedFiles.length ? selectedFiles.join('\n') : '（无相关记忆）';
            break;
          }
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

    messages.push({ role: 'user', content: toolResults });
  }
}

// ============================================================
// Part 6: 启动入口
// ============================================================

console.log('[S09] Memory 启动\n');
console.log(`记忆目录: ${MEMORY_DIR}\n`);

const result = await runAgent<S09Effect, string>(agentLoop, s09Handlers);

console.log(`\n${result}`);
console.log('\n[S09] 完成');
