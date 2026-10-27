/**
 * s20 的运行时配置 —— 常量、环境变量与路径。
 *
 * 集中在这里，避免 2500 行的主文件里散落魔法数字；各模块按需 import。
 * 先加载 .env：DEFAULT_MODEL / 超时覆盖都在模块加载时读取，--real 下 resolveMode 不会代为加载。
 */

import * as path from 'node:path';
import { loadEnvOnce, resolveMode } from '../runtime/env.ts';
import { configuredFallbackModel } from '../runtime/recovery.ts';
import { MAILBOXES_DIR } from '../runtime/workspace.ts';

loadEnvOnce();

// 本章演示产物目录（工作区相对路径，已 gitignore）。
export const OUTPUT_DIR = './s20_comprehensive/.output';

export const LEAD_ID = 'lead';
export const WORKER_ID = 'worker';
export const SUBAGENT_ID = 'subagent';
export const WORKER_ROLE = '工程师';

export const MODE = resolveMode();
// 本章自己的信箱目录：不和 s15/s16/s17 共享同一层。
export const S20_MAILBOX_DIR = path.join(MAILBOXES_DIR, 's20');

export const DEFAULT_MODEL = (process.env.MODEL_ID || '').trim() || 'claude-opus-4-5';
export const FALLBACK_MODEL = configuredFallbackModel();

export const DEFAULT_MAX_TOKENS = 8000;
export const ESCALATED_MAX_TOKENS = 16000;
export const MAX_CONSECUTIVE_529 = 2;
export const MAX_REACTIVE_COMPACTIONS = 3;
/** 单次 Chat 遇到 429/529 时的最大重试次数；与 s11 的 MAX_RETRIES 对齐。 */
export const MAX_CHAT_RETRIES = 10;

export const CONTEXT_LIMIT = 50000;
export const COMPACTED_MARKER = '[Compacted. Continue with summarized context.]';
export const SNIP_MAX_MESSAGES = 50;
export const KEEP_RECENT_TOOL_RESULTS = 3;
export const TOOL_RESULT_MAX_BYTES = 200000;
export const PERSIST_THRESHOLD = 30000;

export const MAX_TEAMMATE_TURNS = 10;
export const MAX_SUBAGENT_TURNS = 10;
export const POLL_MS = Number(process.env.S20_POLL_MS) || (MODE === 'real' ? 100 : 5);
export const IDLE_POLL_INTERVAL_MS = Number(process.env.S20_IDLE_POLL_MS) || 20;
export const IDLE_TIMEOUT_MS =
  Number(process.env.S20_IDLE_TIMEOUT_MS) || (MODE === 'real' ? 10 * 60_000 : 8000);
export const GATE_TIMEOUT_MS =
  Number(process.env.S20_GATE_TIMEOUT_MS) || (MODE === 'real' ? 5 * 60_000 : 8000);
export const RESPONSE_TIMEOUT_MS =
  Number(process.env.S20_RESPONSE_TIMEOUT_MS) || (MODE === 'real' ? 5 * 60_000 : 20_000);
export const CLEANUP_WAIT_MS =
  Number(process.env.S20_CLEANUP_WAIT_MS) || (MODE === 'real' ? 3_000 : 1_000);
export const CRON_TICK_MS = MODE === 'real' ? 1000 : 20;
export const WORKTREE_NAME = 's20-wt';
