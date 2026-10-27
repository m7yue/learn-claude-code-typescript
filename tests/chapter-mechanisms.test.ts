/**
 * 机制回归守卫：断言「各章 README 声明的机制」在章节源码中确有对应实现。
 *
 * 背景：本仓曾出现"文档声称实现了机制、代码却用硬编码/mock 顶替"的情况
 * （如 s14 无调度线程、s08 摘要是硬编码、s12 启动清空任务）。e2e 只能证明
 * 章节能跑通，无法证明机制真实存在。这里用源码模式匹配做防回归：
 * 每个被修过的章节，必须能在章节源码里找到该机制的关键代码痕迹。
 *
 * 说明：这是"关键痕迹"检查，不是语义证明；配合 e2e（能运行）与人工核对
 * （输出体现机制）共同构成验证。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 已抽到 runtime/ 的共享实现：这些章节的机制痕迹要去共享模块里找。
 * 只加共享源，不删除原章节断言。
 */
const sharedSources: Record<string, string[]> = {
  s08_context_compact: ["runtime/compaction.ts"],
  s11_error_recovery: ["runtime/recovery.ts"],
  s13_background_tasks: ["runtime/background.ts"],
  s14_cron_scheduler: ["runtime/cron.ts"],
  s20_comprehensive: [
    "runtime/cron.ts",
    "runtime/compaction.ts",
    "runtime/recovery.ts",
    "runtime/background.ts",
  ],
};

/**
 * 章节源码 = 该章节目录下的所有 .ts + 该章使用的共享模块。
 *
 * 只看 agent.ts 会漏掉被拆出去的演示脚手架（如 s08 的 demo.ts）。
 * 逐个文件匹配，而不是把几个文件拼成一整段 —— 拼接会让 `[\s\S]{0,500}?`
 * 这类跨行模式把两个文件里无关的两件事凑成一次命中。
 */
async function chapterSources(dir: string): Promise<string[]> {
  const files = (await readdir(join(root, dir))).filter((f) => f.endsWith(".ts"));
  const sources = await Promise.all(files.map((f) => readFile(join(root, dir, f), "utf8")));
  for (const rel of sharedSources[dir] ?? []) {
    sources.push(await readFile(join(root, rel), "utf8"));
  }
  return sources;
}

/** 去掉注释；absent 守卫只看代码，解释性注释不应触发失败。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

interface Check {
  /** 该机制的人类可读描述，失败时用于报错。 */
  what: string;
  /** 关键代码痕迹（正则，对源码全文）。 */
  match?: RegExp;
  /** 改法回退的标志（正则，对去掉注释后的源码；命中即失败）。 */
  absent?: RegExp;
}

/** 全仓章节清单（多处断言共用）。 */
const chapters = [
  "s01_agent_loop", "s02_tool_use", "s03_permission", "s04_hooks", "s05_todo_write",
  "s06_subagent", "s07_skill_loading", "s08_context_compact", "s09_memory", "s10_system_prompt",
  "s11_error_recovery", "s12_task_system", "s13_background_tasks", "s14_cron_scheduler",
  "s15_agent_teams", "s16_team_protocols", "s17_autonomous_agents", "s18_worktree_isolation",
  "s19_mcp_plugin", "s20_comprehensive",
];

/** 每个章节 README 声明的、必须真实存在的机制。 */
const expectations: Record<string, Check[]> = {
  "s01_agent_loop": [
    {
      what: "BashExec 真实执行（不再返回写死的文件列表）",
      match: /spawnSync\(command[\s\S]{0,200}?shell: true/,
      absent: /file1\.ts\\nfile2\.ts/,
    },
  ],
  "s02_tool_use": [
    { what: "GlobSearch 真正使用 pattern（glob→regex）", match: /globToRegExp/ },
    { what: "演示产物目录锚定章节目录（s02_tool_use/.output，不再写仓库根）", match: /'\.\/s02_tool_use\/\.output'/ },
    { what: "写出的仍是 s02_output.txt", match: /s02_output\.txt/ },
  ],
  "s03_permission": [
    {
      what: "BashExec 真实执行（不再是回显字符串）",
      match: /spawnSync\(command[\s\S]{0,200}?shell: true/,
      absent: /\(执行结果: \$\{command\}\)/,
    },
    { what: "Gate 3 在终端真问用户，非交互环境自动同意", match: /isTTY/ },
    { what: "闸门用模型工具名，write_file 规则能匹配上", match: /tool !== 'write_file'/ },
    { what: "闸门不再给工具改名（改名会让规则失配）", absent: /\? 'BashExec' : block\.name/ },
    { what: "演示临时文件锚定章节目录（s03_permission/.output，不写进仓库根）", match: /'s03_permission\/\.output'/ },
  ],
  "s06_subagent": [
    {
      what: "主 Agent 的 ReadFile 与子 Agent 同为真读（不再返回占位符）",
      match: /\[主\] ReadFile[\s\S]{0,500}?fs\.readFileSync/,
      absent: /\(主 Agent 读取/,
    },
    {
      what: "主 Agent 的 BashExec 真执行（不再回显命令文本）",
      match: /\[主\] BashExec[\s\S]{0,400}?spawnSync\(command/,
      absent: /\(主 Agent 执行/,
    },
    {
      what: "子 Agent 的 BashExec 真执行（不再回显命令文本）",
      match: /\[子\] BashExec[\s\S]{0,400}?spawnSync\(command/,
      absent: /\(子 Agent 执行/,
    },
  ],
  "s07_skill_loading": [
    { what: "load_skill 先过名字白名单再拼路径", match: /isKnownSkill\(name\)[\s\S]{0,300}?path\.join\(SKILLS_DIR/ },
    { what: "技能名白名单正则", match: /SKILL_NAME_RE/ },
    { what: "read_file 真实读取且以工作区为界", match: /fs\.readFileSync\(safePath\(/ },
  ],
  "s08_context_compact": [
    { what: "摘要走真实 LLM 调用", match: /chat:\s*callChat/ },
    { what: "transcript 落盘 .transcripts/", match: /TRANSCRIPTS_DIR/ },
    { what: "工具结果落盘 .task_outputs/tool-results/", match: /TOOL_RESULTS_DIR/ },
    { what: "落盘文件名里的 toolUseId 先净化再拼路径", match: /sanitizeFilePart\(toolUseId\)/ },
    {
      what: "大输出来自真实文件，不再是按命令名造的特判",
      match: /buildDemoLog\(DEMO_BIG_BYTES\)/,
      absent: /'L'\.repeat\(210_000\)/,
    },
    {
      what: "bash 的工作目录收进演示目录",
      match: /cwd: DEMO_ABS/,
    },
    {
      what: "系统提示词里告知的工作目录与 bash 的 cwd 是同一个",
      match: /baseSystemPrompt\(DEMO_ABS\)/,
    },
    {
      what: "应急判定用仓库共用的 classifyError，不再自写子串匹配",
      match: /classifyError\(err\)/,
      absent: /includes\('too many tokens'\)/,
    },
    {
      what: "压缩后把最初那条用户请求接回来",
      match: /originalRequest\(messages\)/,
    },
    {
      what: "transcript 文件名带递增序号，相隔一秒内的两次压缩不会互相覆盖",
      match: /transcript_\$\{stamp\}_\$\{transcriptSeq\}/,
    },
  ],
  "s09_memory": [
    { what: "select/extract/consolidate 都是真实 LLM 调用", match: /mockSelector/ },
    { what: "每轮抽取记忆", match: /ExtractMemories/ },
    { what: "记忆合并", match: /ConsolidateMemories/ },
    { what: "记忆文件落在工作区 .memory/", match: /MEMORY_DIR/ },
    { what: "写记忆文件前先解析路径并挡越界（不只靠 slugify）", match: /memoryFilePath\(filename\)/ },
    {
      what: "索引文件按大小写不敏感排除（大小写不敏感的文件系统上 memory.md 就是 MEMORY.md）",
      match: /toLowerCase\(\) === 'memory\.md'/,
    },
    { what: "slug 兜底名不与索引同名", match: /slug !== 'memory'/ },
    { what: "合并未产出可用条目时保留旧记忆，不清空", match: /entries\.length === 0/ },
  ],
  "s10_system_prompt": [
    { what: "上下文变化后真的重新组装（当前任务写回 context）", match: /context = \{ \.\.\.context, activeTask/ },
    {
      what: "主循环按模型是否还要调用工具结束，不设轮次上限",
      match: /while \(true\)[\s\S]{0,500}?stop_reason !== 'tool_use'/,
    },
    { what: "不再把与模拟说明矛盾的环境句拼进提示词", absent: /ENVIRONMENT_PROMPT/ },
    { what: "请求改成模拟 bash 下能完成的事（不再要求真的列出目录）", absent: /帮我列出当前目录/ },
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
    {
      what: "complete 只解锁直接依赖刚完成任务的下游（不是所有 canStart 的 pending 任务）",
      match: /blockedBy\.includes\(taskId\)[\s\S]{0,120}?canStart\(t\.id\)/,
      absent: /blockedBy\.length > 0 && canStart/,
    },
  ],
  "s13_background_tasks": [
    { what: "bg_%04d 命名", match: /padStart\(4,\s*['"]0['"]\)/ },
    { what: "后台任务注册表", match: /class BackgroundRegistry/ },
    { what: "注册表用 backgroundResults 保存结果", match: /backgroundResults/ },
    { what: "s13 不再使用进程内 Mutex", absent: /\bMutex\b/ },
    { what: "任务通知 <task-notification>", match: /task-notification/ },
    { what: "通知带 task-type", match: /<task-type>/ },
    { what: "通知带 output-file", match: /<output-file>/ },
    { what: "后台输出写入工作区 .task_outputs/", match: /TASK_OUTPUTS_DIR/ },
    { what: "结束回合时等待并注入后台通知", match: /stop_reason !== ['"]tool_use['"][\s\S]{0,600}?wait: true/ },
    { what: "结束回合排空有上限", match: /MAX_END_TURN_DRAINS/ },
    { what: "注册表可等待在途任务", match: /waitForAll/ },
    { what: "后台失败标记为 failed", match: /status = ['"]failed['"]/ },
    { what: "只有 bash 能进后台", match: /toolName !== ['"]bash['"]\) return false/ },
    { what: "run_in_background 触发后台", match: /run_in_background/ },
    { what: "路径基准取 WORKSPACE_ROOT（不从提示词借 process.cwd）", match: /path\.relative\(WORKSPACE_ROOT, resolved\)/ },
  ],
  "s14_cron_scheduler": [
    { what: "真实调度循环 setInterval", match: /setInterval/ },
    { what: "队列处理器用 agentLock.tryAcquire 拿锁", match: /agentLock\.tryAcquire\(\)/ },
    { what: "队列处理器在 finally 中释放 agentLock", match: /agentLock\.tryAcquire\(\)[\s\S]{0,400}?finally\s*\{\s*release\(\);\s*\}/ },
    { what: "主流程用 agentLock.withLock 包住 runAgentTurn", match: /agentLock\.withLock\(\(\) => runAgentTurn\(\)\)/ },
    { what: "s14 不再使用 cronLock", absent: /\bcronLock\b/ },
    { what: "minute 去重标记", match: /lastFired|_last_fired/i },
    { what: "cron 字段解析支持区间/列表（parseCronField）", match: /parseCronField/ },
    { what: "list_crons 工具", match: /list_crons/ },
  ],
  "s15_agent_teams": [
    { what: "队友是独立子 loop（再次调用 runAgent）", match: /runAgent/ },
    { what: "信箱落在工作区 .mailboxes/", match: /MAILBOXES_DIR/ },
    { what: "s15 使用自己的信箱子目录", match: /S15_MAILBOX_DIR/ },
    { what: "模块加载时先读取 .env", match: /loadEnvOnce\(\);\s*\n\s*const MODE = resolveMode\(\)/ },
    { what: "JSONL 信箱格式", match: /\.jsonl/ },
    { what: "审查样例由章节启动时生成", match: /ensureDemoSamples/ },
    { what: "任务目标指向样例文件", match: /ANALYZER_SAMPLE/ },
    { what: "任务不再指向 runtime/core.ts", absent: /['"]runtime\/core\.ts['"]/ },
    { what: "任务不再指向本章 agent.ts", absent: /['"]s15_agent_teams\/agent\.ts['"]/ },
    { what: "spawn schema 带必填 prompt", match: /required: \[\.\.\.\(base\.input_schema\.required \?\? \[\]\), 'prompt'\]/ },
    { what: "lead 在 end_turn 后等待活跃队友", match: /WaitForTeammates/ },
    { what: "lead 自动注入 inbox", match: /\[inject inbox\]/ },
    { what: "lead check_inbox 不再等待所有队友", absent: /\bawaitTeammates\b/ },
    { what: "队友结束后自动移除句柄", match: /activeTeammates\.delete\(agentId\)/ },
    { what: "按 promise 身份清理", match: /activeTeammates\.get\(agentId\) === promise/ },
    { what: "spawn 拒绝保留名 main", match: /if \(agentId === LEAD_ID\) throw new Error/ },
    { what: "Chat 用队友的真实角色", match: /teammateSystemPrompt\(agentId, effect\.input\.role/ },
    { what: "文件工具的 safePath 以 WORKSPACE_ROOT 为基（复用 runtime/paths.resolveWithin）", match: /function safePath\(p: string\): string \{\s*return resolveWithin\(WORKSPACE_ROOT, p\);/ },
    { what: "文件工具确实经 safePath", match: /safePath\(effect\.input\.path\)/ },
    { what: "模型给的路径不再直接 resolve 到进程 cwd", absent: /path\.resolve\(effect\.input\.path\)/ },
    { what: "重新 spawn 同名队友时清空旧信箱", match: /clearInbox/ },
    { what: "队友失败会设置退出码", match: /teammateFailures/ },
    { what: "文件工具错误交给外层派发（不在 handler 内返回 Error:）", absent: /ReadFile:[\s\S]{0,500}?return `Error:/ },
    { what: "信箱名先过白名单校验再拼路径", match: /validateAgentId\(agentId\)/ },
  ],
  "s16_team_protocols": [
    { what: "request_id 匹配的响应校验", match: /settleResponse/ },
    { what: "待处理请求表", match: /pendingRequests/ },
    { what: "真实 requestId", match: /requestId/ },
    { what: "s16 使用自己的信箱子目录", match: /S16_MAILBOX_DIR/ },
    { what: "模块加载时先读取 .env", match: /loadEnvOnce\(\)/ },
    { what: "预先创建信箱文件", match: /ensureInbox/ },
    { what: "等待新消息由 MessageBus.waitForMessage 负责", match: /waitForMessage/ },
    { what: "写入信箱后结束等待", match: /completeWait\(to\)/ },
    { what: "收尾时结束仍在等待的队友", match: /BUS\.completeWait\(agentId\)/ },
    { what: "队友结束后自动移除句柄", match: /activeTeammates\.delete\(agentId\)/ },
    { what: "按 promise 身份清理", match: /activeTeammates\.get\(agentId\) === promise/ },
    { what: "收尾有宿主停止信号", match: /stopTeammates/ },
    { what: "真实模式响应超时可配", match: /S16_RESPONSE_TIMEOUT_MS/ },
    { what: "工具结果后继续 Chat（不等待新消息）", match: /pendingToolResults/ },
    { what: "submit_plan 读取模型传入的计划文本", match: /block\.input\['plan'\]/ },
    { what: "review_plan 依据 pending 请求里的计划文本", match: /state\.payload/ },
    { what: "review_plan 在 Lead 侧", match: /LEAD_TOOLS: ToolSchema\[\] = \[[\s\S]{0,400}?REVIEW_PLAN_SCHEMA/ },
    { what: "submit_plan 在队友侧", match: /TEAMMATE_TOOLS: ToolSchema\[\] = \[[\s\S]{0,400}?SUBMIT_PLAN_SCHEMA/ },
    { what: "plan_approval_request 消息类型", match: /'plan_approval_request'/ },
    { what: "plan_approval_response 消息类型", match: /'plan_approval_response'/ },
    { what: "超时/宿主收尾也会落定协议状态", match: /settleResponseIfPending/ },
    { what: "request_id 由队友 SubmitPlan 的 Handler 生成，不接受模型传入", match: /const requestId = newRequestId\('plan'\)/, absent: /effect\.input\.requestId/ },
    { what: "收尾等待有时间上限，不一直等 awaitTeammates", absent: /\bawaitTeammates\b/ },
    { what: "活跃队友表按身份逐个移除，不整体 clear", absent: /activeTeammates\.clear/ },
    { what: "只清理本章信箱目录", absent: /fs\.rmSync\(MAILBOXES_DIR/ },
    { what: "文件工具的 safePath 以 WORKSPACE_ROOT 为基（复用 runtime/paths.resolveWithin）", match: /function safePath\(p: string\): string \{\s*return resolveWithin\(WORKSPACE_ROOT, p\);/ },
    { what: "文件工具确实经 safePath", match: /safePath\(effect\.input\.path\)/ },
    { what: "模型给的路径不再直接 resolve 到进程 cwd", absent: /path\.resolve\(effect\.input\.path\)/ },
    { what: "check_inbox 的等待可配置", match: /waitMs \?\? 500/ },
    { what: "check_inbox 分发读取 waitMs", match: /block\.input\['waitMs'\]/ },
    { what: "RequestShutdown 先校验目标", match: /RequestShutdown:[\s\S]{0,300}?validateAgentId\(agentId\)/ },
    { what: "队友失败会设置退出码", match: /teammateFailures/ },
    { what: "文件工具错误交给外层派发（不在 handler 内返回 Error:）", absent: /ReadFile:[\s\S]{0,500}?return `Error:/ },
    { what: "信箱名先过白名单校验再拼路径", match: /validateAgentId\(agentId\)/ },
  ],
  "s17_autonomous_agents": [
    { what: "WORK/IDLE/SHUTDOWN 状态机", match: /WorkerState/ },
    { what: "idle_poll 空闲轮询", match: /IdlePoll/ },
    { what: "自主扫描并认领任务", match: /scanUnclaimed|autoClaim/ },
    { what: "s17 使用自己的信箱子目录", match: /S17_MAILBOX_DIR/ },
    { what: "s17 使用自己的任务板子目录", match: /S17_TASKS_DIR/ },
    { what: "任务目录只在 .tasks/s17", match: /path\.join\(TASKS_DIR, 's17'\)/ },
    { what: "只读本章任务目录", match: /readdirSync\(S17_TASKS_DIR\)/, absent: /readdirSync\(TASKS_DIR\)/ },
    { what: "只重置本章任务目录", match: /rmSync\(S17_TASKS_DIR/, absent: /rmSync\(TASKS_DIR/ },
    { what: "模块加载时先读取 .env", match: /loadEnvOnce\(\)/ },
    { what: "单次空闲等待不超过剩余超时", match: /Math\.min\(interval, Math\.max\(1, deadline - Date\.now\(\)\)\)/ },
    { what: "WORK 阶段退出原因按实际触发记录", match: /\$\{shutdownReason\}/ },
    { what: "预先创建信箱文件", match: /ensureInbox/ },
    { what: "队友结束后自动移除句柄", match: /activeTeammates\.delete\(agentId\)/ },
    { what: "auto_claim 的 owner 固定为当前工作者", match: /type: 'AutoClaim', input: \{ owner: agentId \}/ },
    { what: "s17 maxTokens 可配", match: /S17_MAX_TOKENS/ },
    { what: "只清理本章信箱目录", absent: /fs\.rmSync\(MAILBOXES_DIR/ },
    { what: "信箱名先过白名单校验再拼路径", match: /validateAgentId\(agentId\)/ },
    { what: "Lead 可主动请求关机", match: /RequestShutdown/ },
    { what: "关机 request_id 由宿主生成", match: /newShutdownRequestId/ },
    { what: "关机响应按 request_id 关联", match: /pendingShutdowns/ },
    { what: "关机消息带 request_id", match: /request_id/ },
    { what: "worker 回复 shutdown_response", match: /shutdown_response/ },
    { what: "shutdown_response 带同一 request_id", match: /metadata: \{ request_id: requestId, approve: true, responder: agentId \}/ },
    { what: "Lead 工具集含 request_shutdown", match: /specFor\('request_shutdown'\)/ },
    { what: "Lead 收信时落定关机响应", match: /recordShutdownResponses/ },
    { what: "关机响应更新 pending 状态", match: /pending\.status = approved \? 'approved' : 'rejected'/ },
    { what: "check_inbox 不阻塞，回合结束由宿主等待", match: /WaitForTeammates/ },
    { what: "等待队友有时间上限", match: /settleActiveWithin/ },
    { what: "回合结束最多注入有限轮", match: /MAX_END_TURN_DRAINS/ },
    { what: "回合结束注入 inbox", match: /\[inject inbox\]/ },
    { what: "不再一直等待队友", absent: /\bawaitTeammates\b/ },
    { what: "完成阶段严格校验 owner", match: /!task\.owner \|\| task\.owner !== owner/ },
    { what: "解锁只报告直接下游", match: /blockedBy\.includes\(taskId\)[\s\S]{0,120}?canStart\(t\.id\)/, absent: /blockedBy\.length > 0 && canStart/ },
    { what: "idle_poll 不再暴露给 worker 模型", absent: /WORKER_TOOLS[\s\S]{0,400}?['"]idle_poll['"]/ },
    { what: "WORK 分发不再处理 idle_poll", absent: /case ['"]idle_poll['"]/ },
    { what: "AutoClaim 日志不再冒充 IDLE→WORK", absent: /\[IDLE→WORK\]/ },
    { what: "退出摘要带已完成任务", match: /buildWorkerSummary/ },
    { what: "worker 退出前归还自己未完成的任务", match: /unfinishedOnExit[\s\S]{0,300}?type: 'ReleaseTask'/ },
    { what: "异常退出也归还任务", match: /releaseTask\(unfinished\.id, agentId\)/ },
    { what: "仍有队友在运行时按失败处理", match: /stillRunning\.length === 0/ },
    { what: "worker 失败会标记失败", match: /teammateFailures/ },
    { what: "失败时设置退出码", match: /process\.exitCode = 1/ },
    { what: "Lead 不给已退出队友发消息", match: /!activeTeammates\.has\(to\)/ },
    { what: "lead 的工具集与派发一致（bash 有 case）", match: /function\* leadLoop[\s\S]*?case 'bash'/ },
    { what: "关机响应校验响应者", match: /pending\.agentId !== m\.from/ },
    { what: "所有发送者都校验目标是否在运行", match: /to !== LEAD_ID && !activeTeammates\.has\(to\)/ },
  ],
  "s18_worktree_isolation": [
    { what: "真实 git worktree add", match: /\['worktree',\s*'add'/ },
    { what: "真实 git worktree remove", match: /\['worktree',\s*'remove'/ },
    { what: "删除分支 branch -D", match: /\['branch',\s*'-D'/ },
    { what: "改动计数守卫", match: /discardChanges/ },
    { what: "事件日志 events.jsonl", match: /WORKTREE_EVENTS_PATH/ },
    { what: "keep_worktree 保留审查", match: /keep_worktree|KeepWorktree/ },
    { what: "清理只遍历本次运行的登记簿", match: /function cleanupWorktrees\(\)[\s\S]{0,700}?worktreePaths/ },
    { what: "keep_worktree 的保留会跳过自动清理", match: /keptWorktrees/ },
    { what: "不再全仓扫荡 wt/* 分支", absent: /refs\/heads\/wt\// },
    { what: "未知 worktreeId 不静默回落到工作区根", match: /!\s*worktreePaths\.has\(wtId\)/ },
  ],
  "s20_comprehensive": [
    { what: "错误分类复用 runtime/errors", match: /classifyError/ },
    { what: "s20 使用自己的信箱子目录", match: /S20_MAILBOX_DIR/ },
    { what: "模块加载时先读取 .env", match: /loadEnvOnce\(\)/ },
    { what: "check_inbox 输出带 metadata（协议 request_id 可见）", match: /Object\.keys\(m\.metadata\)/ },
    { what: "预先创建信箱文件", match: /ensureInbox/ },
    { what: "等待新消息由 MessageBus.waitForMessage 负责", match: /waitForMessage/ },
    { what: "写入信箱后结束等待", match: /completeWait\(to\)/ },
    { what: "收尾时结束仍在等待的队友", match: /BUS\.completeWait\(agentId\)/ },
    { what: "队友结束后自动移除句柄", match: /activeTeammates\.delete\(agentId\)/ },
    { what: "收尾有宿主停止信号", match: /stopTeammates/ },
    { what: "真实模式 gate 超时可配", match: /S20_GATE_TIMEOUT_MS/ },
    { what: "工具结果后继续 Chat（不回到 await 等待）", match: /phase = 'work';\s*\n\s*const toolResults/ },
    { what: "收尾等待有时间上限，不一直等 awaitTeammates", absent: /\bawaitTeammates\b/ },
    { what: "活跃队友表按身份逐个移除，不整体 clear", absent: /activeTeammates\.clear/ },
    { what: "信箱只写本章子目录，不写共享根目录", absent: /writeFileSync\(path\.join\(MAILBOXES_DIR/ },
    { what: "只清理本章信箱目录", absent: /fs\.rmSync\(MAILBOXES_DIR/ },
    { what: "真实 cron 调度", match: /setInterval/ },
    { what: "真实 git worktree", match: /\['worktree',\s*'add'/ },
    { what: "request_id 协议状态机", match: /protocol\.settle|createProtocolStore/ },
    { what: "计划审批是真实闸门", match: /submit_plan|SubmitPlan/ },
    { what: "演示产物目录锚定章节目录（s20_comprehensive/.output，不写进 docs/）", match: /'\.\/s20_comprehensive\/\.output'/ },
    { what: "mock 的 edit_file 用 snake_case 键（与工具 schema 一致，否则编辑静默失效）", match: /'edit_file',[^\n]*old_text:/ },
    { what: "落盘文件名先净化（toolUseId / 记忆键名）", match: /sanitizeFilePart\(/ },
    { what: "信箱名先过白名单校验再拼路径", match: /validateAgentId\(agentId\)/ },
    {
      what: "task 工具按注册表的键（task）读取，不是 description",
      match: /block\.input\['task'\]/,
      absent: /SpawnSubagent[\s\S]{0,100}?block\.input\['description'\]/,
    },
    { what: "compact 的 reason 被真正读取", match: /force: true, reason/ },
    { what: "worktree 名拒绝 . 和 ..", match: /name === '\.' \|\| name === '\.\.'/ },
    { what: "worktree 保留集合参与清理", match: /keptWorktrees\.has\(name\)/ },
    { what: "worktree 删除只作用于严格子目录", match: /isStrictChild\(base, wtPath\)/ },
    { what: "safeChildPath 复用 resolveWithin", match: /function safeChildPath[\s\S]{0,120}?return resolveWithin\(base, p\)/ },
    { what: "GlobSearch 走 safeChildPath 边界", match: /safeChildPath\(WORKSPACE_ROOT, dir\)/ },
    { what: "协议状态机可独立测试", match: /createProtocolStore/ },
    { what: "shutdown 超时落定", match: /settleIfPending\('shutdown_response', requestId, false\)/ },
    { what: "计划审批超时落定", match: /settleIfPending\('plan_approval_response', requestId, false\)/ },
    { what: "ReviewPlan 先 send 再 settle", match: /BUS\.send\(reviewerId[\s\S]{0,600}?protocol\.settle\('plan_approval_response'/ },
    { what: "ReviewPlan 校验 reviewer", match: /reviewerId !== LEAD_ID/ },
    { what: "RequestPlan 返回 pending", match: /status: 'pending', feedback: '已发出计划请求'/ },
    { what: "prompt_too_long 有次数上限", match: /MAX_REACTIVE_COMPACTIONS/ },
    { what: "real 退避不被 mock 缩放", match: /resolveMode\(\) === ['"]mock['"] \? full \* MOCK_DELAY_SCALE : full/ },
    { what: "子代理有轮数上限", match: /MAX_SUBAGENT_TURNS/ },
    { what: "CheckInbox 统一消费协议消息", match: /handleProtocolInbox/ },
    { what: "队友失败会设置退出码", match: /teammateFailures/ },
    { what: "compact 标记不重复", match: /COMPACTED_MARKER/ },
    { what: "文件工具错误交给外层派发（不在 handler 内返回 Error:）", absent: /ReadFile:[\s\S]{0,500}?return `Error:/ },
  ],
};

/** 工具仍是教学模拟的章节：必须在 system prompt 里说明，真模型才不会空转。 */
const simulatedChapters = [
  "s02_tool_use", "s04_hooks", "s05_todo_write", "s07_skill_loading", "s10_system_prompt",
  "s11_error_recovery", "s13_background_tasks", "s15_agent_teams", "s16_team_protocols",
  "s17_autonomous_agents", "s19_mcp_plugin",
];

test("模拟章节的 system prompt 里说明了 bash 是模拟的", async () => {
  const missing: string[] = [];
  for (const dir of simulatedChapters) {
    const sources = await chapterSources(dir);
    if (!sources.some((s) => s.includes("本教学演示中 bash 是模拟的"))) missing.push(dir);
  }
  assert.deepEqual(
    missing,
    [],
    `以下章节的 system prompt 没有说明 bash 是模拟的（真模型会拿到假反馈而空转）:\n${missing.join("\n")}`,
  );
});

for (const [dir, checks] of Object.entries(expectations)) {
  test(`机制守卫: ${dir}`, async () => {
    const sources = await chapterSources(dir);
    const missing = checks
      .filter((check) => {
        const { match, absent } = check;
        const hit = match ? sources.some((s) => match.test(s)) : true;
        const bad = absent ? sources.some((s) => absent.test(stripComments(s))) : false;
        return !hit || bad;
      })
      .map((c) => c.what);
    assert.deepEqual(missing, [], `${dir} 缺少以下真实机制（或旧写法又回来了）:\n${missing.join("\n")}`);
  });
}

test("章节不再以 process.cwd() 作为工作区基准（注释里的说明不算）", async () => {
  const offenders: string[] = [];
  for (const dir of chapters) {
    for (const raw of await chapterSources(dir)) {
      const code = stripComments(raw);
      if (/process\.cwd\(\)/.test(code)) {
        offenders.push(dir);
        break;
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `以下章节仍以 process.cwd() 为工作区基准（应改用 runtime/workspace.ts 的 WORKSPACE_ROOT）:\n${offenders.join("\n")}`,
  );
});

test("全仓章节不再把持久化写到 os.tmpdir()", async () => {
  const offenders: string[] = [];
  for (const dir of chapters) {
    const sources = await chapterSources(dir);
    if (sources.some((s) => /os\.tmpdir\(\)/.test(s))) offenders.push(dir);
  }
  assert.deepEqual(offenders, [], `以下章节仍把状态写到 os.tmpdir():\n${offenders.join("\n")}`);
});

test("s12 不再启动即清空任务；s17 不再用 globalThis 侧信道", async () => {
  const s12 = await chapterSources("s12_task_system");
  assert.ok(!s12.some((s) => /cleanupTasks/.test(s)), "s12 不应再有 cleanupTasks（会删光任务，破坏重启恢复）");

  const s17 = await chapterSources("s17_autonomous_agents");
  assert.ok(
    !s17.some((s) => /globalThis\s*\.\s*_pendingTaskId\s*=/.test(s)),
    "s17 不应再用 globalThis._pendingTaskId 侧信道赋值",
  );
});
