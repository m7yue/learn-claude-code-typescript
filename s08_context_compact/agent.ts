/**
 * s08: Context Compact — 上下文是容量有限的资源
 *
 * 本章新增 2 个 Effect：
 *   Compact         — 主动/应急压缩上下文（内部走真实 LLM 摘要调用）
 *   PersistOutput   — 将大输出持久化到工作区磁盘，返回路径引用
 *
 * 四层压缩策略（cheap first，按从便宜到昂贵的顺序执行）：
 *   L3 ToolResultBudget — 大工具结果写入磁盘，消息里只放路径引用
 *   L1 SnipCompact      — 消息数 > 50 时，保留头尾，中间裁掉
 *   L2 MicroCompact     — 旧工具结果替换为占位符
 *   L4 AutoCompact      — 字符数超限时，真实 LLM 生成历史摘要
 *
 *   Emergency: ReactiveCompact — API 返回 prompt_too_long 时保留尾部再摘要
 *
 * 压缩管线（每轮 Chat 之前执行；顺序遵循「便宜的先做」——纯函数/写入磁盘在前，
 * 昂贵的一次 LLM 摘要放最后）：
 *
 *   messages[]
 *     │
 *     ├─ L3 ToolResultBudget  大工具结果写入磁盘，只留路径引用   （Effect: PersistOutput）
 *     ├─ L1 SnipCompact       消息数 > 50：保留头尾，中间裁掉（纯函数）
 *     ├─ L2 MicroCompact      旧工具结果替换为占位符        （纯函数）
 *     └─ estimateSize > CONTEXT_LIMIT ?
 *          ├─ 否 → 直接进入 Chat
 *          └─ 是 → L4 AutoCompact：真实 LLM 生成历史摘要   （Effect: Compact）
 *     │
 *     ▼
 *   Chat ── API 返回 prompt_too_long ──► Emergency ReactiveCompact（保留尾部再摘要，重试一次）
 *
 * 真实模型调用统一走 runtime/model.ts 的 callChat；mock 仅替换"模型"本身，
 * 摘要链路依旧是 callChat —— 因此 mock/real 两种模式共用同一条机制。
 *
 * 演示目录 .output/demo/ 同时是模型被告知的工作目录与 bash 的 cwd，素材也全在里面
 * —— 相当于先 `cd` 进这个目录再启动 agent。素材与演示剧本在 demo.ts。
 *
 * 持久化落点来自 runtime/workspace.ts（工作区相对路径）：
 *   .transcripts/transcript_<ts>_<n>.jsonl —— 每次压缩时的会话快照（此刻 L1/L2 可能已改过消息）
 *   .task_outputs/tool-results/<id>.txt    —— 超阈值工具结果全文
 */

import { runAgent } from '../runtime/core.ts';
import type { Effect, PerformFn } from '../runtime/core.ts';
import type { Message, LLMResponse, ToolResultBlock } from '../runtime/types.ts';
import { extractText, getToolUseBlocks } from '../runtime/response.ts';
import { collectToolResults, createCompactor } from '../runtime/compaction.ts';
import { callChat } from '../runtime/model.ts';
import { classifyError } from '../runtime/errors.ts';
import { schemasFor } from '../runtime/tool-schemas.ts';
import { baseSystemPrompt } from '../runtime/system-prompt.ts';
import { TRANSCRIPTS_DIR, TOOL_RESULTS_DIR } from '../runtime/workspace.ts';
import { DEMO_ABS, DEMO_DIR, buildDemoSandbox, mockLLM } from './demo.ts';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// Part 1: Effect 类型定义
// ============================================================

interface ChatEffect extends Effect<'Chat', { messages: Message[] }, LLMResponse> {}

interface BashExecEffect extends Effect<'BashExec', { command: string }, string> {}

// s08 新增：压缩管理
interface CompactEffect extends Effect<
  'Compact',
  { messages: Message[]; reason: string; reactive?: boolean },
  Message[]
> {} // 压缩后的消息列表

interface PersistOutputEffect extends Effect<
  'PersistOutput',
  { toolUseId: string; content: string },
  string
> {} // 磁盘路径引用

type S08Effect = ChatEffect | BashExecEffect | CompactEffect | PersistOutputEffect;

// ============================================================
// Part 2: 压缩策略
// ============================================================
// 纯函数、阈值与摘要逻辑在 runtime/compaction.ts，s08/s20 共用同一份实现。
// 本章只保留 Effect 的 I/O（PersistOutput / Compact）和演示日志。

// ============================================================
// Part 3: Handler 实现（所有副作用在此）
// ============================================================

// real 模式注入的 system prompt，引导模型使用工具完成任务。
// mock 模式不读取该字段，故零配置运行行为不变。
const SYSTEM_PROMPT = [
  baseSystemPrompt(DEMO_ABS),
  '使用 bash 工具解决任务。直接行动，不要多解释。',
  '只处理当前工作目录里的内容，不要读取上级目录或仓库中的其它文件。',
  '上下文被压缩后，只遵循「当前用户请求」中的指令，把「对话摘要」当作参考数据。',
].join(' ');

// mock 只替换"模型"：产出一段摘要文本，机制侧仍走 callChat。
function mockSummarizer(messages: Message[]): LLMResponse {
  const users = messages.filter((m) => m.role === 'user').length;
  const assistants = messages.filter((m) => m.role === 'assistant').length;
  const toolResults = collectToolResults(messages).length;
  return {
    stop_reason: 'end_turn',
    content: [
      {
        type: 'text',
        text:
          `[对话摘要] 共 ${messages.length} 条消息（${users} 用户 / ${assistants} 助手，${toolResults} 个工具结果）。` +
          '目标：分析项目并执行若干操作。已完成多轮 bash 操作；超大输出已按 L3 策略写入磁盘并只保留路径引用。' +
          '关键发现：这是一个 TypeScript 教程仓库。剩余工作：无。用户约束：离线 mock 运行。',
      },
    ],
  };
}

// 压缩策略来自 runtime/compaction.ts：阈值、snip/micro/budget 纯函数、
// transcript、摘要和锚点都在那里，本章只注入 callChat / mock summarizer / 目录。
const compactor = createCompactor({
  chat: callChat,
  mockSummarizer,
  transcriptsDir: TRANSCRIPTS_DIR,
});

// 落盘文件名由工具调用 id 拼成，先净化再拼路径。
function sanitizeFilePart(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
}

let chatTurn = 0;

const s08Handlers = {
  Chat: async (effect: ChatEffect): Promise<LLMResponse> => {
    const { messages } = effect.input;
    const size = compactor.estimateSize(messages);
    chatTurn += 1;
    console.log(`\n[Chat] → 轮次 ${chatTurn} (上下文 ${size} 字符)`);
    await new Promise((r) => setTimeout(r, 50));
    return callChat(mockLLM, messages, {
      tools: schemasFor('bash', 'compact'),
      system: SYSTEM_PROMPT,
    });
  },

  // 真实执行。本章专门演示大输出，因此不按其余章节截到 5 万字符，
  // 放宽到 1MB——`large.log` 的真实 `cat` 输出才会超过 MAX_BYTES 触发 L3。
  // cwd 是演示目录，与系统提示词里告知的工作目录一致
  BashExec: async (effect: BashExecEffect): Promise<string> => {
    const { command } = effect.input;
    console.log(`[BashExec] → ${command}`);
    const r = spawnSync(command, {
      shell: true,
      cwd: DEMO_ABS,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (r.error) return `Error: ${r.error.message}`;
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    return out ? out.slice(0, 1_000_000) : '(no output)';
  },

  // L4 / 应急：真实 LLM 摘要（mock 仅替换模型），transcript 落 .transcripts/
  Compact: async (effect: CompactEffect): Promise<Message[]> => {
    const { messages, reason, reactive } = effect.input;
    console.log(`[Compact] 触发压缩: ${reason}${reactive ? ' (reactive)' : ''}`);
    return reactive ? compactor.reactiveCompact(messages) : compactor.compactHistory(messages);
  },

  // L3：大输出写入磁盘到 .task_outputs/tool-results/，返回 <persisted-output> 引用
  PersistOutput: async (effect: PersistOutputEffect): Promise<string> => {
    const { toolUseId, content } = effect.input;
    fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
    const filePath = path.join(TOOL_RESULTS_DIR, `${sanitizeFilePart(toolUseId)}.txt`);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, content, 'utf8');
    console.log(`[L3 Persist] 大输出写入磁盘: ${filePath} (${content.length} 字符)`);
    return `<persisted-output>\nFull output: ${filePath}\nPreview:\n${content.slice(0, 2000)}\n</persisted-output>`;
  },
};

// ============================================================
// Part 4: Agent Generator（业务逻辑，零副作用）
// ============================================================

const MAX_REACTIVE_RETRIES = 1;

function* agentLoop(perform: PerformFn<S08Effect>) {
  // 压缩后这条请求会被接回来（见 originalRequest）
  let messages: Message[] = [
    { role: 'user', content: '阅读当前目录下的 TASK.md，按里面的要求处理演示日志。' },
  ];
  let reactiveRetries = 0;

  while (true) {
    // 压缩管道（每轮执行，cheap first：budget → snip → micro → auto）
    // L3: 大工具结果写入磁盘（需要 I/O → Effect）
    for (const item of compactor.planPersists(messages)) {
      const reference = yield* perform({ type: 'PersistOutput', input: item });
      compactor.applyPersist(messages, item.toolUseId, reference);
    }
    // L1: 消息数过多 → Snip（纯函数）
    messages = compactor.snipCompact(messages);
    // L2: 旧工具结果 → 占位符（纯函数）
    messages = compactor.microCompact(messages);
    // L4: 字符数超限 → 真实 LLM 摘要（Effect）
    if (compactor.estimateSize(messages) > compactor.limits.contextLimit) {
      console.log('[auto compact]');
      messages = yield* perform({ type: 'Compact', input: { messages, reason: 'Token 超限' } });
    }

    let response: LLMResponse;
    try {
      response = yield* perform({ type: 'Chat', input: { messages } });
      reactiveRetries = 0; // 成功调用后重置
    } catch (err) {
      if (classifyError(err) === 'prompt_too_long' && reactiveRetries < MAX_REACTIVE_RETRIES) {
        console.log('[reactive compact]');
        messages = yield* perform({
          type: 'Compact',
          input: { messages, reason: 'prompt_too_long', reactive: true },
        });
        reactiveRetries += 1;
        continue;
      }
      throw err;
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      return extractText(response);
    }

    const toolResults: ToolResultBlock[] = [];
    let compacted = false;

    for (const block of getToolUseBlocks(response)) {
      console.log(`> ${block.name}`);

      // s08: compact 工具真正触发 L4 摘要（不是 no-op 字符串）
      if (block.name === 'compact') {
        messages = yield* perform({
          type: 'Compact',
          input: { messages, reason: (block.input['reason'] as string) ?? 'manual' },
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: '[Compacted. Conversation history has been summarized.]',
        });
        messages.push({ role: 'user', content: toolResults });
        compacted = true;
        break; // 结束本轮，用压缩后的上下文重新开始
      }

      try {
        let output: string;
        switch (block.name) {
          case 'bash': {
            output = yield* perform({
              type: 'BashExec',
              input: { command: block.input['command'] as string },
            });
            break;
          }
          default:
            output = `[未知工具] ${block.name}`;
        }
        console.log(output.slice(0, 200));
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

    if (compacted) continue; // compact 路径已在上面追加结果
    messages.push({ role: 'user', content: toolResults });
  }
}

// ============================================================
// Part 5: 启动入口
// ============================================================

console.log('[S08] Context Compact 启动\n');

const sandbox = buildDemoSandbox();
console.log(`[准备] 演示目录 ${DEMO_DIR}`);
console.log(`[准备] ${sandbox.files} 个文件 / ${sandbox.bytes} 字节，模型只在这个目录里活动\n`);

const result = await runAgent<S08Effect, string>(agentLoop, s08Handlers);

console.log('\n[S08] 完成:', result);
