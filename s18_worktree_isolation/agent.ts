/**
 * s18: Git Worktree Isolation — Worktree 是代码变更的效应沙箱
 *
 * 本章新增 3 个 Effect：
 *   CreateWorktree — 创建独立工作树（隔离的文件系统视图）
 *   RemoveWorktree — 清理工作树
 *   BindWorktree   — 将任务绑定到特定工作树（路径注入）
 *
 * 核心思想：Worktree = 文件系统层面的效应作用域隔离
 * 就像 s06 的 Delegate 隔离了消息上下文，Worktree 隔离了文件系统变更。
 * 每个任务或分支可以在独立目录中进行，互不干扰。
 */

import { runAgent } from '../runtime/core.ts';
import type { BaseEffect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolUseBlock } from '../runtime/types.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

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
  input: { command: string; cwd?: string };
  output: string;
}

interface WorktreeInfo {
  id: string;
  branch: string;
  path: string;
  taskId?: string;
}

// s18 新增：Worktree 管理
interface CreateWorktreeEffect extends BaseEffect {
  type: 'CreateWorktree';
  input: { worktreeId: string; branch: string };
  output: WorktreeInfo;
}

interface RemoveWorktreeEffect extends BaseEffect {
  type: 'RemoveWorktree';
  input: { worktreeId: string };
  output: { removed: boolean };
}

interface BindWorktreeEffect extends BaseEffect {
  type: 'BindWorktree';
  input: { worktreeId: string; taskId: string };
  output: WorktreeInfo;
}

type S18Effect = ChatEffect | BashExecEffect | CreateWorktreeEffect | RemoveWorktreeEffect | BindWorktreeEffect;

// ============================================================
// Part 2: Handler 实现（Worktree 管理，使用临时目录模拟）
// ============================================================

const WORKTREE_BASE = path.join(os.tmpdir(), 'learn-claude-code-typescript', 's18', 'worktrees');
const EVENTS_LOG = path.join(os.tmpdir(), 'learn-claude-code-typescript', 's18', 'events.jsonl');
const worktrees = new Map<string, WorktreeInfo>();

// Worktree 事件日志：追加到 events.jsonl
type WorktreeEventType = 'create' | 'remove' | 'keep' | 'bind';
function logWorktreeEvent(type: WorktreeEventType, worktreeId: string, extra?: Record<string, string>): void {
  const entry = JSON.stringify({ ts: new Date().toISOString(), type, worktreeId, ...extra });
  fs.appendFileSync(EVENTS_LOG, entry + '\n', 'utf8');
}

function extractText(response: LLMResponse): string {
  return response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text).join('');
}

function getToolUseBlocks(response: LLMResponse): ToolUseBlock[] {
  return response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

// Mock LLM：创建两个 worktree → 绑定任务 → 在各自目录工作 → 清理
const mockResponses = [
  // 轮1：创建两个 worktree
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '创建独立工作树。' },
      { type: 'tool_use' as const, id: 'm1', name: 'create_worktree', input: { worktreeId: 'wt_feature_a', branch: 'feature/auth-refactor' } },
      { type: 'tool_use' as const, id: 'm2', name: 'create_worktree', input: { worktreeId: 'wt_feature_b', branch: 'feature/api-v2' } },
    ],
  },
  // 轮2：绑定任务到工作树
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '绑定任务到工作树。' },
      { type: 'tool_use' as const, id: 'm3', name: 'bind_worktree', input: { worktreeId: 'wt_feature_a', taskId: 'task_auth_001' } },
    ],
  },
  // 轮3：在工作树目录中执行操作
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '在隔离环境中执行变更。' },
      { type: 'tool_use' as const, id: 'm4', name: 'bash', input: { command: 'echo "auth refactor" > auth.patch', worktreeId: 'wt_feature_a' } },
    ],
  },
  // 轮4：清理工作树
  {
    stop_reason: 'tool_use' as const,
    content: [
      { type: 'text' as const, text: '清理已完成的工作树。' },
      { type: 'tool_use' as const, id: 'm5', name: 'remove_worktree', input: { worktreeId: 'wt_feature_a' } },
      { type: 'tool_use' as const, id: 'm6', name: 'remove_worktree', input: { worktreeId: 'wt_feature_b' } },
    ],
  },
  // 轮5：结束
  {
    stop_reason: 'end_turn' as const,
    content: [{ type: 'text' as const, text: 'Worktree 隔离演示完成：创建→绑定→执行→清理。' }],
  },
];

let roundIndex = 0;
function mockLLM(_messages: Message[]): LLMResponse {
  return mockResponses[Math.min(roundIndex++, mockResponses.length - 1)] as LLMResponse;
}

const s18Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const round = effect.input.messages.filter(m => m.role === 'assistant').length;
    console.log(`\n[Chat] → 轮次 ${round + 1}`);
    await new Promise(r => setTimeout(r, 30));
    return mockLLM(effect.input.messages);
  },

  BashExec: async (effect: BashExecEffect): Promise<string> => {
    const { command, cwd } = effect.input;
    const workDir = cwd ?? process.cwd();
    console.log(`[BashExec] → ${command} (cwd: ${path.basename(workDir)})`);
    try {
      const result = execSync(command, { cwd: workDir, encoding: 'utf8', timeout: 5000 });
      return result.trim() || '(完成)';
    } catch (e: any) {
      return `(错误: ${e.message})`;
    }
  },

  CreateWorktree: async (effect: CreateWorktreeEffect): Promise<WorktreeInfo> => {
    const { worktreeId, branch } = effect.input;
    const wtPath = path.join(WORKTREE_BASE, worktreeId);
    fs.mkdirSync(wtPath, { recursive: true });
    // 模拟 git worktree（实际项目中会调用 git worktree add）
    fs.writeFileSync(path.join(wtPath, '.worktree'), JSON.stringify({ worktreeId, branch }), 'utf8');
    const info: WorktreeInfo = { id: worktreeId, branch, path: wtPath };
    worktrees.set(worktreeId, info);
    logWorktreeEvent('create', worktreeId, { branch });
    console.log(`[CreateWorktree] ${worktreeId}: ${branch}`);
    console.log(`  路径: ${wtPath}`);
    return info;
  },

  RemoveWorktree: async (effect: RemoveWorktreeEffect): Promise<{ removed: boolean }> => {
    const { worktreeId } = effect.input;
    const info = worktrees.get(worktreeId);
    if (!info) {
      console.log(`[RemoveWorktree] ${worktreeId}: 不存在`);
      return { removed: false };
    }
    try {
      fs.rmSync(info.path, { recursive: true, force: true });
    } catch {}
    worktrees.delete(worktreeId);
    logWorktreeEvent('remove', worktreeId, { branch: info.branch });
    console.log(`[RemoveWorktree] ${worktreeId}: 已删除 (${info.branch})`);
    return { removed: true };
  },

  BindWorktree: async (effect: BindWorktreeEffect): Promise<WorktreeInfo> => {
    const { worktreeId, taskId } = effect.input;
    const info = worktrees.get(worktreeId);
    if (!info) throw new Error(`Worktree 不存在: ${worktreeId}`);
    info.taskId = taskId;
    worktrees.set(worktreeId, info);
    logWorktreeEvent('bind', worktreeId, { taskId });
    console.log(`[BindWorktree] ${worktreeId} ← 任务: ${taskId}`);
    return info;
  },
};

// ============================================================
// Part 3: Agent Generator
// ============================================================

function* agentLoop(perform: PerformFn<S18Effect>) {
  const messages: Message[] = [
    { role: 'user', content: '使用 worktree 隔离并行开发两个功能分支。' },
  ];

  while (true) {
    const response = yield* perform({ type: 'Chat', input: { messages } });
    messages.push({ role: 'assistant', content: extractText(response) });

    if (response.stop_reason !== 'tool_use') {
      return extractText(response);
    }

    const toolResults: Array<{ tool_use_id: string; content: string }> = [];

    for (const block of getToolUseBlocks(response)) {
      let output: string;
      switch (block.name) {
        case 'bash': {
          // 如果指定了 worktreeId，使用对应路径
          const wtId = block.input['worktreeId'] as string | undefined;
          const cwd = wtId ? worktrees.get(wtId)?.path : undefined;
          output = yield* perform({ type: 'BashExec', input: { command: block.input['command'] as string, cwd } });
          break;
        }
        case 'create_worktree': {
          const wt = yield* perform({
            type: 'CreateWorktree',
            input: { worktreeId: block.input['worktreeId'] as string, branch: block.input['branch'] as string },
          });
          output = `Worktree 已创建: ${wt.id} (${wt.branch})`;
          break;
        }
        case 'remove_worktree': {
          const { removed } = yield* perform({
            type: 'RemoveWorktree',
            input: { worktreeId: block.input['worktreeId'] as string },
          });
          output = removed ? `已删除: ${block.input['worktreeId']}` : `不存在: ${block.input['worktreeId']}`;
          break;
        }
        case 'bind_worktree': {
          const wt = yield* perform({
            type: 'BindWorktree',
            input: { worktreeId: block.input['worktreeId'] as string, taskId: block.input['taskId'] as string },
          });
          output = `已绑定: ${wt.id} ← ${wt.taskId}`;
          break;
        }
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

fs.mkdirSync(WORKTREE_BASE, { recursive: true });
// 清空事件日志（本次演示从零开始）
if (fs.existsSync(EVENTS_LOG)) fs.writeFileSync(EVENTS_LOG, '', 'utf8');
console.log('[S18] Git Worktree Isolation 启动\n');

const result = await runAgent<S18Effect, string>(agentLoop, s18Handlers);

console.log('\n[S18] 完成:', result);

// 显示事件日志
if (fs.existsSync(EVENTS_LOG)) {
  const events = fs.readFileSync(EVENTS_LOG, 'utf8').trim().split('\n').filter(Boolean);
  console.log(`\n[Events] events.jsonl (${events.length} 条):`);
  events.forEach(line => {
    const e = JSON.parse(line);
    console.log(`  ${e.ts.slice(11, 19)} ${e.type.padEnd(6)} ${e.worktreeId}${e.branch ? ' (' + e.branch + ')' : ''}${e.taskId ? ' ← ' + e.taskId : ''}`);
  });
}
