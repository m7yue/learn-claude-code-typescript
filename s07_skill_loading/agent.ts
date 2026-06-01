/**
 * s07: Skill Loading — 知识按需加载
 *
 * 本章新增 2 个 Effect：
 *   ListSkills — 列出所有可用技能（名称 + 单行描述）
 *   LoadSkill  — 加载指定技能的完整内容
 *
 * 双层架构：
 *   Layer 1（轻量，始终存在）: 技能名称 + 描述 → 注入 system prompt
 *   Layer 2（按需，较重）:    技能完整内容 → 工具调用时返回
 */

import { runAgent } from '../runtime/core.ts';
import type { BaseEffect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolUseBlock } from '../runtime/types.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// s07 新增：技能管理
interface ListSkillsEffect extends BaseEffect {
  type: 'ListSkills';
  input: Record<string, never>;
  output: Array<{ name: string; description: string }>;
}

interface LoadSkillEffect extends BaseEffect {
  type: 'LoadSkill';
  input: { name: string };
  output: string; // 技能的完整 Markdown 内容
}

type S07Effect = ChatEffect | BashExecEffect | ListSkillsEffect | LoadSkillEffect;

// ============================================================
// Part 2: Handler 实现
// ============================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.join(__dirname, 'skills');

// 解析 SKILL.md 的 YAML frontmatter（正则提取，避免引入额外依赖）
function parseSkillMd(content: string): { name: string; description: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { name: 'unknown', description: '' };
  const frontmatter = match[1];
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  // description 有两种格式：单行 "description: xxx" 或多行块 "description: |\n  line1\n  line2"
  const descBlockMatch = frontmatter.match(/^description:\s*\|\n((?:[ \t]+.+\n?)+)/m);
  if (descBlockMatch) {
    const lines = descBlockMatch[1].split('\n').map(l => l.trim()).filter(Boolean);
    return { name: nameMatch?.[1]?.trim() ?? 'unknown', description: lines.join(' ') };
  }
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch?.[1]?.trim() ?? 'unknown',
    description: descMatch?.[1]?.trim() ?? '',
  };
}

// 降级备用注册表（当 skills/ 目录不存在时）
const SKILL_REGISTRY_FALLBACK: Record<string, { description: string; content: string }> = {
  'code-review': {
    description: '对代码进行全面的质量审查，包括逻辑错误、安全漏洞、性能问题',
    content: '# Code Review Skill\n\n（降级模式，请创建 skills/ 目录）',
  },
};

function extractText(response: LLMResponse): string {
  return response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text).join('');
}

function getToolUseBlocks(response: LLMResponse): ToolUseBlock[] {
  return response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

function mockLLM(messages: Message[], skillDir: string): LLMResponse {
  const round = messages.filter(m => m.role === 'assistant').length;

  if (round === 0) {
    // 第1轮：列出可用技能
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '我先看看有哪些可用的技能。' },
        { type: 'tool_use', id: 'tool_001', name: 'list_skills', input: {} },
      ],
    };
  }
  if (round === 1) {
    // 第2轮：加载需要的技能
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '我需要用到代码审查技能，先加载它。' },
        { type: 'tool_use', id: 'tool_002', name: 'load_skill', input: { name: 'code-review' } },
      ],
    };
  }
  if (round === 2) {
    // 第3轮：使用加载的技能知识执行任务
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '已加载代码审查技能，现在执行审查。' },
        { type: 'tool_use', id: 'tool_003', name: 'bash', input: { command: 'echo "审查完成"' } },
      ],
    };
  }
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '代码审查完成，发现3个建议改进点，无严重问题。' }],
  };
}

const s07Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages, systemPrompt } = effect.input;
    const round = messages.filter(m => m.role === 'assistant').length;
    console.log(`\n[Chat] → 轮次 ${round + 1}`);
    if (round === 0 && systemPrompt) {
      console.log(`[System] 包含技能目录 (${systemPrompt.length} 字符)`);
    }
    await new Promise(r => setTimeout(r, 50));
    const response = mockLLM(messages, systemPrompt ?? '');
    const tools = getToolUseBlocks(response).map(b => b.name).join(', ');
    console.log(`[LLM]  ← ${response.stop_reason}${tools ? ', 工具: ' + tools : ''}`);
    return response;
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    console.log(`[BashExec] → ${effect.input.command}`);
    return `(执行: ${effect.input.command})`;
  },

  ListSkills: async (_effect: ListSkillsEffect) => {
    // 从 skills/ 目录扫描，解析各子目录的 SKILL.md frontmatter
    if (!fs.existsSync(SKILLS_DIR)) {
      // 降级：使用内置注册表
      const skills = Object.entries(SKILL_REGISTRY_FALLBACK).map(([name, { description }]) => ({ name, description }));
      console.log(`[ListSkills] (降级) 发现 ${skills.length} 个技能`);
      return skills;
    }
    const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    const skills: Array<{ name: string; description: string }> = [];
    for (const dir of dirs) {
      const skillPath = path.join(SKILLS_DIR, dir, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      const content = fs.readFileSync(skillPath, 'utf8');
      const { name, description } = parseSkillMd(content);
      skills.push({ name, description });
    }
    console.log(`[ListSkills] 发现 ${skills.length} 个技能:`);
    skills.forEach(s => console.log(`  - ${s.name}: ${s.description.slice(0, 50)}...`));
    return skills;
  },

  LoadSkill: async (effect: LoadSkillEffect): Promise<string> => {
    const { name } = effect.input;
    const skillPath = path.join(SKILLS_DIR, name, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      const content = fs.readFileSync(skillPath, 'utf8');
      console.log(`[LoadSkill] 加载技能: ${name} (${content.length} 字符，来自文件)`);
      return content;
    }
    // 降级：使用内置注册表
    const fallback = SKILL_REGISTRY_FALLBACK[name];
    if (fallback) {
      console.log(`[LoadSkill] (降级) 加载技能: ${name}`);
      return fallback.content;
    }
    return `[错误] 未找到技能: ${name}`;
  },
};

// ============================================================
// Part 3: Agent Generator
// ============================================================

function* agentLoop(perform: PerformFn<S07Effect>) {
  // Layer 1：先获取技能目录，注入 system prompt
  const skills = yield* perform({ type: 'ListSkills', input: {} });
  const skillDirectory = skills
    .map(s => `- ${s.name}: ${s.description}`)
    .join('\n');

  const systemPrompt = `你是一个编码助手。

可用技能（使用 load_skill 加载完整内容）：
${skillDirectory}

在执行专业任务前，先加载相关技能获取具体指导。`;

  const messages: Message[] = [
    { role: 'user', content: '帮我做一次代码审查，重点检查安全问题。' },
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
        case 'list_skills':
          // Layer 1：获取技能目录（轻量）
          const list = yield* perform({ type: 'ListSkills', input: {} });
          output = list.map(s => `${s.name}: ${s.description}`).join('\n');
          break;
        case 'load_skill':
          // Layer 2：加载完整技能内容（按需）
          output = yield* perform({ type: 'LoadSkill', input: { name: block.input['name'] as string } });
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

console.log('[S07] Skill Loading 启动\n');

const result = await runAgent<S07Effect, string>(agentLoop, s07Handlers);

console.log('\n[S07] 完成:', result);
