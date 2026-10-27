/**
 * s20 的知识类工具 —— 记忆(s09) / 技能(s07) / 待办(s05)。
 * 都是小体量的教学实现，放在一个模块里避免主文件继续膨胀。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { MEMORY_DIR, MEMORY_INDEX_PATH } from '../runtime/workspace.ts';
import { sanitizeFilePart } from './util.ts';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

/** 按文件名读单条记忆（s09 方言）；不传文件名时按关键词检索索引（s20 方言）。 */
export function readMemoryFile(query?: string, filename?: string): string {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  if (filename) {
    const file = path.join(MEMORY_DIR, `${sanitizeFilePart(filename)}.md`);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `（没有名为 "${filename}" 的记忆）`;
  }
  if (!fs.existsSync(MEMORY_INDEX_PATH)) return '（无历史记忆）';
  const content = fs.readFileSync(MEMORY_INDEX_PATH, 'utf8');
  if (!query) return content.slice(0, 2000);
  const lines = content.split('\n').filter((l) => l.toLowerCase().includes(query.toLowerCase()));
  return lines.length ? lines.join('\n') : `（未找到与 "${query}" 相关的记忆）`;
}

export function writeMemory(key: string, content: string): string {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const file = path.join(MEMORY_DIR, `${sanitizeFilePart(key)}.md`);
  fs.writeFileSync(file, content, 'utf8');
  fs.appendFileSync(MEMORY_INDEX_PATH, `- ${key}: ${content.slice(0, 120)}\n`, 'utf8');
  return `Saved memory '${key}' → ${file}`;
}

const SKILLS: Record<string, string> = {
  'worktree-isolation': '# Worktree Isolation\n\n每个任务在独立 git worktree 中执行，main 分支保持可发布。',
  'context-compact': '# Context Compact\n\n四层压缩：budget → snip → micro → summarize。',
};

export function loadSkill(name: string): string {
  const body = SKILLS[name];
  if (!body) return `Skill '${name}' not found. Available: ${Object.keys(SKILLS).join(', ')}`;
  return body;
}

export function runTodoWrite(todos: TodoItem[]): string {
  const lines = todos.map((t) => `  [${t.status}] ${t.content}`).join('\n');
  return `Updated ${todos.length} todos:\n${lines}`;
}
