/**
 * s20: Comprehensive — 把 s10–s19 的机制组合成一个完整的、真正能跑的 Agent
 *
 * 本章把每一章的机制都接上真实的文件、进程与定时器，再用同一个代数效应运行器（runAgent）串起来
 * （而不是只在内存里模拟、让各 Effect 只打印日志）：
 *
 *   s08 上下文压缩     → 每轮真实跑 预算/裁剪/微压缩/LLM 摘要；超长工具输出写入磁盘（PersistOutput）
 *   s09 Memory         → 真实读写 .memory/
 *   s10 Prompt 组装     → 运行时按上下文分段组装 system prompt
 *   s11 错误恢复        → 真实区分 429/529/过长，退避重试 + 连续 529 切换模型
 *   s12 Task System    → .tasks/ 持久化任务图 + blockedBy 依赖图
 *   s13 Background     → 真实后台任务注册表 + 通知收集
 *   s14 Cron           → 真实 setInterval 调度器 + .scheduled_tasks.json 持久化 + 队列注入
 *   s15 Agent Teams    → 真实 JSONL 信箱 + 独立 generator 的队友子循环
 *   s16 Team Protocols → request_id 协议状态机 + 计划审批会真的等待响应
 *   s17 Autonomous     → 队友空闲 WORK/IDLE/SHUTDOWN 状态机
 *   s18 Worktree       → 真实 git worktree 隔离（spawnSync 调 git）+ 变更保护
 *   s19 MCP Plugin     → 进程内 MCP 服务器（教学版）+ 工具池装配（mcp__{server}__{tool}）
 *
 * Mock 只替换「模型调用」这一件事：并发任务、定时器、持久化、git、协议全部是真实代码。
 * 默认 AGENT_MODE=mock 完全离线可跑，末尾打印 [S20] 完成。
 */

import * as fs from 'node:fs';

import { runAgent } from '../runtime/core.ts';
import { describeMode } from '../runtime/env.ts';
import { truncate } from '../runtime/text.ts';
import { settleActiveWithin } from '../runtime/wait.ts';
import { MEMORY_DIR, TASKS_DIR, WORKSPACE_ROOT, WORKTREES_DIR } from '../runtime/workspace.ts';
import { flushBackground } from './background.ts';
import { CLEANUP_WAIT_MS, OUTPUT_DIR, S20_MAILBOX_DIR } from './config.ts';
import { loadDurableJobs, startCronScheduler, stopCronScheduler } from './cron.ts';
import type { S20Effect } from './effects.ts';
import { worktrees } from './git.ts';
import { s20Handlers } from './handlers.ts';
import { leadLoop } from './lead-loop.ts';
import { protocol } from './protocol-runtime.ts';
import { activeTeammates, stopTeammates, teammateFailures } from './team.ts';

// ============================================================
// Part 16: 启动入口 + 收尾
// ============================================================

fs.mkdirSync(TASKS_DIR, { recursive: true });
fs.mkdirSync(MEMORY_DIR, { recursive: true });

console.log('[S20] Comprehensive — 整合 Harness 启动');
console.log(`  模式: ${describeMode()}  工作区: ${WORKSPACE_ROOT}`);
console.log(`  任务: ${TASKS_DIR}  信箱: ${S20_MAILBOX_DIR}  worktree: ${WORKTREES_DIR}`);
console.log(`  演示产物: ${OUTPUT_DIR}（已在 .gitignore 忽略）\n`);

loadDurableJobs();
startCronScheduler();
worktrees.cleanup(); // 清理 git worktree 元数据；同名残留由 create_worktree 自己处理

let result: string | undefined;
let ok = true;
try {
  result = await runAgent<S20Effect, string>(leadLoop, s20Handlers);
} catch (err) {
  ok = false;
  process.exitCode = 1;
  console.error(
    `[S20] lead 运行失败（${describeMode()}）: ${err instanceof Error ? err.message : String(err)}`,
  );
}

// 收尾：先通知仍在空闲等待的队友停止，再停调度器、清 worktree、冲后台。
stopTeammates();
const remaining = await settleActiveWithin(activeTeammates, CLEANUP_WAIT_MS);
if (remaining.length > 0) {
  // 队友没在收尾窗口内结束，不能把“lead 返回了”当成整次运行成功。
  ok = false;
  process.exitCode = 1;
  console.warn(
    `[S20] 退出前仍有队友在运行: ${remaining.join(', ')}（不会强制结束；如有在途模型请求，进程可能要等它完成）`,
  );
}
try {
  stopCronScheduler();
} catch (err) {
  ok = false;
  process.exitCode = 1;
  console.warn(`[S20] stopCronScheduler 失败: ${err instanceof Error ? err.message : String(err)}`);
}
try {
  worktrees.cleanup();
} catch (err) {
  ok = false;
  process.exitCode = 1;
  console.warn(`[S20] worktrees.cleanup 失败: ${err instanceof Error ? err.message : String(err)}`);
}
try {
  await flushBackground();
} catch (err) {
  ok = false;
  process.exitCode = 1;
  console.warn(`[S20] flushBackground 失败: ${err instanceof Error ? err.message : String(err)}`);
}

console.log('\n[Protocol] 协议请求汇总:');
for (const req of protocol.all()) {
  console.log(`  ${req.requestId}: type=${req.type} ${req.sender}→${req.target} [${req.status}]`);
}

if (teammateFailures.size > 0) {
  ok = false;
  process.exitCode = 1;
  console.error(`[S20] 队友失败: ${[...teammateFailures].join(', ')}`);
}

if (ok && result !== undefined) {
  console.log(`\n[S20] 结果: ${truncate(result, 200)}`);
  console.log('[S20] 完成');
} else {
  console.log('[S20] 失败');
}
