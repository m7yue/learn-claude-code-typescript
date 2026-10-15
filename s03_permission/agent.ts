/**
 * s03: Permission — 权限是副作用的守门人
 *
 * 本章新增 1 个 Effect：
 *   RequestPermission — 向用户或规则引擎请求执行许可
 *
 * 三道检查关（都在 Handler 内部完成，Generator 完全不需要知道）：
 *   Gate 1: DenyList  — 禁止清单，命中就无条件拒绝
 *   Gate 2: Rules     — 按规则匹配，命中就拒绝，或交给 Gate 3 处理
 *   Gate 3: UserApproval — 请用户审批（RequestPermission Effect）
 */

import { runAgent } from '../runtime/core.ts';
import type { Effect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolResultBlock } from '../runtime/types.ts';
import { extractText, getToolUseBlocks } from '../runtime/response.ts';
import { callChat } from '../runtime/model.ts';
import { schemasFor } from '../runtime/tool-schemas.ts';
import { buildSystemPrompt } from '../runtime/system-prompt.ts';
import { WORKSPACE_ROOT } from '../runtime/workspace.ts';
import { spawnSync } from 'node:child_process';
import * as readline from 'node:readline/promises';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

// 继承自 s01/s02
interface ChatEffect extends Effect<'Chat', { messages: Message[] }, LLMResponse> {}

interface BashExecEffect extends Effect<'BashExec', { command: string }, string> {}

interface ReadFileEffect extends Effect<'ReadFile', { path: string; limit?: number }, string> {}

interface WriteFileEffect extends Effect<'WriteFile', { path: string; content: string }, string> {}

// s03 新增：权限请求
interface RequestPermissionEffect extends Effect<'RequestPermission', { toolName: string; args: Record<string, unknown>; reason: string }, { allowed: boolean; reason?: string }> {}

type S03Effect =
  | ChatEffect
  | BashExecEffect
  | ReadFileEffect
  | WriteFileEffect
  | RequestPermissionEffect;

// ============================================================
// Part 2: Handler 实现
// ============================================================

// 工作区根目录（可用 AGENT_WORKSPACE 覆盖）。
const WORKDIR = WORKSPACE_ROOT;

// 演示用的临时文件：放在章节目录下的 .output/（与 s02/s20 的演示产物同规矩，已被 gitignore）。
// 每次启动时重建，让「清理临时文件」有真实目标，也把模型的操作范围钉在这一次演示里。
const DEMO_DIR = 's03_permission/.output';
const DEMO_TMP_FILE = `${DEMO_DIR}/tmp.txt`;

// Gate 1：禁止清单，命令里只要包含其中一项就直接拒绝
const DENY_LIST = [
  'rm -rf /',
  'rm -rf ~',
  'sudo',
  'shutdown',
  'reboot',
  'mkfs',
  ':(){ :|:& };:',
];

// Gate 2：规则列表。match 收到的是模型给的工具名（bash / read_file / write_file），
// 与规则表里写的名字必须一致，中间不做任何改名。
interface PermissionRule {
  match: (toolName: string, args: Record<string, unknown>) => boolean;
  reason: string;
  autoReject: boolean; // true = 直接拒绝；false = 升级到 Gate 3（用户审批）
}

const PERMISSION_RULES: PermissionRule[] = [
  {
    match: (tool, args) =>
      tool === 'bash' && ['rm ', 'mv ', 'chmod ', 'chown '].some(
        d => String(args['command'] ?? '').includes(d)
      ),
    reason: '可能的破坏性命令',
    autoReject: false,
  },
  {
    // 用相对路径判断是否越界：`/工作区-xxx` 这类同前缀兄弟目录也会被判为「工作区外」。
    match: (tool, args) => {
      if (tool !== 'write_file') return false;
      const resolved = path.resolve(WORKDIR, String(args['path'] ?? ''));
      const rel = path.relative(WORKDIR, resolved);
      return rel.startsWith('..') || path.isAbsolute(rel);
    },
    reason: '写入工作区外的路径',
    autoReject: false,
  },
];

/** 安全路径校验：把参数解析为工作区内的绝对路径，越界（含同前缀兄弟目录）即抛错。 */
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const rel = path.relative(WORKDIR, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`路径越界: ${p}`);
  return resolved;
}

// Mock LLM：先发会被规则拦下、交给用户审批的命令，再发命中禁止清单的命令
function mockLLM(messages: Message[]): LLMResponse {
  const round = messages.filter(m => m.role === 'assistant').length;
  if (round === 0) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '我先清理这个临时文件。' },
        { type: 'tool_use', id: 'tool_001', name: 'bash', input: { command: `rm ${DEMO_TMP_FILE}` } },
      ],
    };
  }
  if (round === 1) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '再尝试这个危险命令。' },
        { type: 'tool_use', id: 'tool_002', name: 'bash', input: { command: 'rm -rf / --no-preserve-root' } },
      ],
    };
  }
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '操作已完成（部分被拒绝）。' }],
  };
}

// 权限检查流程（依次过三道检查关）
// 注意：这个函数需要 perform 才能发起 RequestPermission Effect，所以它是一个 Generator 函数
// toolName 用的是模型给的工具名（bash / write_file）
function* checkPermissionPipeline(
  toolName: string,
  args: Record<string, unknown>,
  perform: PerformFn<S03Effect>
): Generator<S03Effect, { allowed: boolean; reason?: string }, any> {
  // Gate 1: DenyList（只针对 bash）
  if (toolName === 'bash') {
    const command = String(args['command'] ?? '');
    const denied = DENY_LIST.find(d => command.includes(d));
    if (denied) {
      console.log(`[Gate1] ✗ 命中禁止清单: ${denied}`);
      return { allowed: false, reason: `命令在禁止清单中: "${denied}"` };
    }
  }
  console.log(`[Gate1] ✓ 未命中禁止清单`);

  // Gate 2: Rules
  const rule = PERMISSION_RULES.find(r => r.match(toolName, args));
  if (rule) {
    console.log(`[Gate2] ⚠ 命中规则: ${rule.reason}`);
    if (rule.autoReject) {
      return { allowed: false, reason: rule.reason };
    }
    // Gate 3: 用户审批（通过 RequestPermission Effect）
    const result = yield* perform({
      type: 'RequestPermission',
      input: { toolName, args, reason: rule.reason },
    });
    return result;
  }
  console.log(`[Gate2] ✓ 无规则命中，直接允许执行`);
  return { allowed: true };
}

// real 模式注入的 system prompt，引导模型使用工具完成任务。
// mock 模式不读取该字段，故零配置运行行为不变。
const SYSTEM_PROMPT = buildSystemPrompt(
  '使用 bash、read_file、write_file 工具解决任务。所有破坏性操作都需要用户批准。只处理任务指定的文件与目录，不要扫描或清理其他位置。'
);

const s03Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages } = effect.input;
    console.log(`\n[Chat] → 发送 ${messages.length} 条消息...`);
    await new Promise(r => setTimeout(r, 50));
    const response = await callChat(mockLLM, messages, {
      tools: schemasFor('bash', 'read_file', 'write_file'),
      system: SYSTEM_PROMPT,
    });
    const tools = getToolUseBlocks(response).map(b => b.name).join(', ');
    console.log(`[LLM]  ← stop_reason: ${response.stop_reason}${tools ? ', 工具: ' + tools : ''}`);
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
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    return out ? out.slice(0, 50_000) : '(no output)';
  },

  ReadFile: async (effect: ReadFileEffect): Promise<string> => {
    try {
      const safe = safePath(effect.input.path);
      const content = fs.readFileSync(safe, 'utf8');
      return effect.input.limit ? content.split('\n').slice(0, effect.input.limit).join('\n') : content;
    } catch {
      return `[错误] 无法读取: ${effect.input.path}`;
    }
  },

  WriteFile: async (effect: WriteFileEffect): Promise<string> => {
    try {
      const safe = safePath(effect.input.path);
      fs.mkdirSync(path.dirname(safe), { recursive: true });
      fs.writeFileSync(safe, effect.input.content, 'utf8');
      return `已写入 ${effect.input.path}`;
    } catch (e: unknown) {
      return `[错误] ${e instanceof Error ? e.message : String(e)}`;
    }
  },

  // Gate 3 实现：终端里问用户；非交互环境（e2e 子进程、管道）不阻塞，自动同意
  RequestPermission: async (effect: RequestPermissionEffect): Promise<{ allowed: boolean; reason?: string }> => {
    const { toolName, args, reason } = effect.input;
    const detail = String(args['command'] ?? args['path'] ?? toolName);
    console.log(`[Permission] → 询问用户: 是否允许执行 ${toolName}? (原因: ${reason})`);

    if (!process.stdin.isTTY) {
      console.log('[Permission] ← 非交互环境，自动同意');
      return { allowed: true };
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      // 空回车按拒绝：本章的失败默认拒绝
      const answer = (await rl.question(`  允许执行 \`${detail}\` 吗？[y/N] `)).trim().toLowerCase();
      const allowed = answer === 'y' || answer === 'yes';
      console.log(`[Permission] ← 用户: ${allowed ? '同意' : '拒绝'}`);
      return allowed ? { allowed: true } : { allowed: false, reason: '用户拒绝' };
    } catch {
      // 输入被中断等情况同样按失败默认拒绝处理
      console.log('[Permission] ← 未取得批准');
      return { allowed: false, reason: '未获得用户批准' };
    } finally {
      rl.close();
    }
  },
};

// ============================================================
// Part 3: Agent Generator（业务逻辑 — 与 s02 相同，只在执行工具前多走一道权限检查）
// ============================================================

function* agentLoop(perform: PerformFn<S03Effect>) {
  const messages: Message[] = [
    { role: 'user', content: `清理临时文件 ${DEMO_TMP_FILE}，然后列出 ${DEMO_DIR} 目录。` },
  ];

  while (true) {
    const response = yield* perform({ type: 'Chat', input: { messages } });
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      return extractText(response);
    }

    const toolResults: ToolResultBlock[] = [];

    for (const block of getToolUseBlocks(response)) {
      try {
        // 权限检查：在 yield Effect 之前，先走三道闸门
        // 注意：checkPermissionPipeline 本身是 Generator，可以在内部 yield RequestPermission
        const perm = yield* checkPermissionPipeline(
          block.name,
          block.input as Record<string, unknown>,
          perform
        );

        let output: string;
        if (!perm.allowed) {
          output = `[拒绝] ${perm.reason}`;
          console.log(`[拒绝] ${block.name}: ${perm.reason}`);
        } else {
          switch (block.name) {
            case 'bash':
              output = yield* perform({ type: 'BashExec', input: { command: block.input['command'] as string } });
              break;
            case 'read_file':
              output = yield* perform({ type: 'ReadFile', input: { path: block.input['path'] as string } });
              break;
            case 'write_file':
              output = yield* perform({
                type: 'WriteFile',
                input: { path: block.input['path'] as string, content: block.input['content'] as string },
              });
              break;
            default:
              output = `[未知工具] ${block.name}`;
          }
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

console.log('[S03] Permission 启动\n');

// 先建好演示用的临时文件，让「清理」这一步真的有事可做（每次运行都重建）。
const demoTmpPath = safePath(DEMO_TMP_FILE);
fs.mkdirSync(path.dirname(demoTmpPath), { recursive: true });
fs.writeFileSync(demoTmpPath, '演示用的临时文件，可以删。\n', 'utf8');
console.log(`[准备] 已建好演示临时文件: ${DEMO_TMP_FILE}\n`);

const result = await runAgent<S03Effect, string>(agentLoop, s03Handlers);

console.log('\n[S03] 完成:', result);
