/**
 * 机制回归守卫：断言「各章 README 声明的机制」在 agent.ts 中确有对应实现。
 *
 * 背景：本仓曾出现"文档声称实现了机制、代码却用硬编码/mock 顶替"的情况
 * （如 s14 无调度线程、s08 摘要是硬编码、s12 启动清空任务）。e2e 只能证明
 * 章节能跑通，无法证明机制真实存在。这里用源码模式匹配做防回归：
 * 每个被修过的章节，必须能在 agent.ts 里找到该机制的关键代码痕迹。
 *
 * 说明：这是"关键痕迹"检查，不是语义证明；配合 e2e（能运行）与人工核对
 * （输出体现机制）共同构成验证。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Check {
  /** 该机制的人类可读描述，失败时用于报错。 */
  what: string;
  /** 关键代码痕迹（正则，对源码全文）。 */
  match: RegExp;
}

/** 每个章节 README 声明的、必须真实存在的机制。 */
const expectations: Record<string, Check[]> = {
  "s02_tool_use": [
    { what: "GlobSearch 真正使用 pattern（glob→regex）", match: /globToRegExp/ },
    { what: "mock 写入工作区相对路径，不再写 /tmp", match: /s02_output\.txt/ },
  ],
  "s08_context_compact": [
    { what: "摘要走真实 LLM 调用", match: /callChat\(\s*mockSummarizer/ },
    { what: "transcript 落盘 .transcripts/", match: /TRANSCRIPTS_DIR/ },
    { what: "工具结果落盘 .task_outputs/tool-results/", match: /TOOL_RESULTS_DIR/ },
  ],
  "s09_memory": [
    { what: "select/extract/consolidate 都是真实 LLM 调用", match: /mockSelector/ },
    { what: "每轮抽取记忆", match: /ExtractMemories/ },
    { what: "记忆合并", match: /ConsolidateMemories/ },
    { what: "记忆文件落在工作区 .memory/", match: /MEMORY_DIR/ },
  ],
  "s11_error_recovery": [
    { what: "按 name/message 字符串分类错误", match: /classifyError/ },
    { what: "model/maxTokens 透传进 callChat", match: /maxTokens/ },
    { what: "备用模型来自 FALLBACK_MODEL_ID", match: /FALLBACK_MODEL_ID/ },
    { what: "max_tokens 是 stop_reason 而非异常", match: /stop_reason === ['"]max_tokens['"]/ },
  ],
  "s12_task_system": [
    { what: "任务持久化到 .tasks/", match: /TASKS_DIR/ },
    { what: "依赖检查 canStart", match: /canStart/ },
    { what: "真实的 blockedBy 依赖图", match: /blockedBy/ },
    { what: "注册 get_task 工具", match: /['"]get_task['"]/ },
  ],
  "s13_background_tasks": [
    { what: "bg_%04d 命名", match: /padStart\(4,\s*['"]0['"]\)/ },
    { what: "后台任务注册表 + 锁", match: /Mutex/ },
    { what: "任务通知 <task_notification>", match: /task_notification/ },
    { what: "run_in_background 触发后台", match: /run_in_background/ },
  ],
  "s14_cron_scheduler": [
    { what: "真实调度循环 setInterval", match: /setInterval/ },
    { what: "调度/处理器锁", match: /Mutex/ },
    { what: "minute 去重标记", match: /lastFired|_last_fired/i },
    { what: "cron 字段解析支持区间/列表", match: /cronFieldMatches/ },
    { what: "list_crons 工具", match: /list_crons/ },
  ],
  "s15_agent_teams": [
    { what: "队友是独立子 loop（再次调用 runAgent）", match: /runAgent/ },
    { what: "信箱落在工作区 .mailboxes/", match: /MAILBOXES_DIR/ },
    { what: "JSONL 信箱格式", match: /\.jsonl/ },
  ],
  "s16_team_protocols": [
    { what: "request_id 匹配的响应校验", match: /matchResponse/ },
    { what: "待处理请求表", match: /pendingRequests/ },
    { what: "真实 requestId", match: /requestId/ },
  ],
  "s17_autonomous_agents": [
    { what: "WORK/IDLE/SHUTDOWN 状态机", match: /WorkerState/ },
    { what: "idle_poll 空闲轮询", match: /IdlePoll/ },
    { what: "自主扫描并认领任务", match: /scanUnclaimed|autoClaim/ },
  ],
  "s18_worktree_isolation": [
    { what: "真实 git worktree add", match: /\['worktree',\s*'add'/ },
    { what: "真实 git worktree remove", match: /\['worktree',\s*'remove'/ },
    { what: "删除分支 branch -D", match: /\['branch',\s*'-D'/ },
    { what: "改动计数守卫", match: /discardChanges/ },
    { what: "事件日志 events.jsonl", match: /WORKTREE_EVENTS_PATH/ },
    { what: "keep_worktree 保留审查", match: /keep_worktree|KeepWorktree/ },
  ],
  "s20_comprehensive": [
    { what: "错误分类复用 runtime/errors", match: /classifyError/ },
    { what: "真实 cron 调度", match: /setInterval/ },
    { what: "真实 git worktree", match: /\['worktree',\s*'add'/ },
    { what: "request_id 协议状态机", match: /matchResponse/ },
    { what: "计划审批是真实闸门", match: /submit_plan|SubmitPlan/ },
  ],
};

for (const [dir, checks] of Object.entries(expectations)) {
  test(`机制守卫: ${dir}`, async () => {
    const source = await readFile(join(root, dir, "agent.ts"), "utf8");
    const missing = checks
      .filter((c) => !c.match.test(source))
      .map((c) => c.what);
    assert.deepEqual(missing, [], `${dir} 缺少以下真实机制:\n${missing.join("\n")}`);
  });
}

test("全仓章节不再把持久化写到 os.tmpdir()", async () => {
  const chapters = [
    "s01_agent_loop", "s02_tool_use", "s03_permission", "s04_hooks", "s05_todo_write",
    "s06_subagent", "s07_skill_loading", "s08_context_compact", "s09_memory", "s10_system_prompt",
    "s11_error_recovery", "s12_task_system", "s13_background_tasks", "s14_cron_scheduler",
    "s15_agent_teams", "s16_team_protocols", "s17_autonomous_agents", "s18_worktree_isolation",
    "s19_mcp_plugin", "s20_comprehensive",
  ];
  const offenders: string[] = [];
  for (const dir of chapters) {
    const source = await readFile(join(root, dir, "agent.ts"), "utf8");
    if (/os\.tmpdir\(\)/.test(source)) offenders.push(dir);
  }
  assert.deepEqual(offenders, [], `以下章节仍把状态写到 os.tmpdir():\n${offenders.join("\n")}`);
});

test("s12 不再启动即清空任务；s17 不再用 globalThis 侧信道", async () => {
  const s12 = await readFile(join(root, "s12_task_system/agent.ts"), "utf8");
  assert.ok(!/cleanupTasks/.test(s12), "s12 不应再有 cleanupTasks（会删光任务，破坏重启恢复）");

  const s17 = await readFile(join(root, "s17_autonomous_agents/agent.ts"), "utf8");
  assert.ok(
    !/globalThis\s*\.\s*_pendingTaskId\s*=/.test(s17),
    "s17 不应再用 globalThis._pendingTaskId 侧信道赋值",
  );
});
