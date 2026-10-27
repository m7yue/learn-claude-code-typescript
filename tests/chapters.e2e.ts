/**
 * 章节端到端回归：把每一章的 agent.ts 作为独立子进程运行。
 *
 * 之所以用子进程而不是 import：各章在模块顶层就 await runAgent(...)，
 * 直接 import 会在测试进程内执行并可能污染环境/挂起。
 *
 * 强制 AGENT_MODE=mock，保证测试永远不访问网络。
 * 运行：npm run test:e2e
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const chapters: Array<[dir: string, marker: string]> = [
  ["s01_agent_loop", "[S01] 完成"],
  ["s02_tool_use", "[S02] 完成"],
  ["s03_permission", "[S03] 完成"],
  ["s04_hooks", "[S04] 完成"],
  ["s05_todo_write", "[S05] 完成"],
  ["s06_subagent", "[S06] 完成"],
  ["s07_skill_loading", "[S07] 完成"],
  ["s08_context_compact", "[S08] 完成"],
  ["s09_memory", "[S09] 完成"],
  ["s10_system_prompt", "[S10] 完成"],
  ["s11_error_recovery", "[S11] 完成"],
  ["s12_task_system", "[S12] 完成"],
  ["s13_background_tasks", "[S13] 完成"],
  ["s14_cron_scheduler", "[S14] 完成"],
  ["s15_agent_teams", "[S15] 完成"],
  ["s16_team_protocols", "[S16] 完成"],
  ["s17_autonomous_agents", "[S17] 完成"],
  ["s18_worktree_isolation", "[S18] 完成"],
  ["s19_mcp_plugin", "[S19] 完成"],
  ["s20_comprehensive", "[S20] 完成"],
];

/** 各章演示产物（相对章节目录）：应生成在工作区里，而不是仓库里。 */
const demoArtifacts: Record<string, string[]> = {
  s02_tool_use: [".output/s02_output.txt"],
  s07_skill_loading: [".output/review-target.js"],
  s08_context_compact: [
    ".output/demo/TASK.md",
    ".output/demo/bulk.log",
    ".output/demo/large.log",
    ".output/demo/notes/note-01.md",
  ],
  s15_agent_teams: [".output/analyzer_sample.ts", ".output/reviewer_sample.ts"],
  s20_comprehensive: [".output/report.md", ".output/worker-note.md"],
};

/** 各章 demo 必须在 stdout 里留下的机制痕迹：能跑通（完成标记）不等于演示了本章声称的机制。 */
const requiredStdout: Record<string, string[]> = {
  s08_context_compact: ["[L1 Snip]", "[L2 Micro]", "[L3 Persist]", "[auto compact]"],
  s10_system_prompt: [
    "[AssemblePrompt] 重新组装: [identity, tools, workspace]",
    "[AssemblePrompt] 重新组装: [identity, tools, workspace, task]",
    "[AssemblePrompt] ✓ 缓存命中",
  ],
  s12_task_system: ["[ClaimTask] ✗ Blocked by:", "[CompleteTask] 解锁: 编写测试"],
  s13_background_tasks: [
    "[background] dispatched bg_0001",
    "[inject] 注入 1 条后台通知",
    "<task-id>bg_0001</task-id>",
    "后台任务完成通知",
  ],
  s14_cron_scheduler: [
    "[cron register] health_check",
    "[cron fire] health_check",
    "[inject cron] 执行健康检查",
    "[queue processor] delivering scheduled work",
    "已收到 [Scheduled]",
  ],
  s15_agent_teams: [
    "[准备] 已生成样例",
    "[SpawnTeammate] 生成: analyzer",
    "[SpawnTeammate] 生成: reviewer",
    "[bus] analyzer → main",
    "[teammate] analyzer finished",
    "[CheckInbox:main] 收到 2 条消息",
    "[inject inbox] 2 条",
    "分析完成",
    "审查完成",
  ],
  s16_team_protocols: [
    "[SpawnTeammate] 生成: planner",
    "[SubmitPlan]",
    "[RequestPlan]",
    "[ReviewPlan]",
    "plan_approval_request",
    "plan_approval_response",
    "[rejected]",
    "要求补充后再提交",
    "Lead 拒绝",
    "[Protocol] 协议请求汇总:",
  ],
  s17_autonomous_agents: [
    "[Lifecycle] worker: WORK → IDLE",
    "[Lifecycle] worker: IDLE → WORK (claimed)",
    "[Lifecycle] worker: IDLE → SHUTDOWN (timeout)",
    "[ScanUnclaimed] 发现 1 个可认领任务",
    "[ClaimTask] ✗ Task task_owned_by_lead already owned by main",
    "[CompleteTask] ✗ Task task_owned_by_lead_active is owned by main, not worker",
    "[AutoClaim] ◑ task_0000_s17_0001",
    "[CompleteTask] ✓ task_0000_s17_0001",
    "[CompleteTask] 解锁: 清理日志文件",
    "[CompleteTask] ✓ task_0000_s17_0002",
    "收到自主工作者的报告：",
  ],
  s20_comprehensive: [
    "[MCP] connected 'docs'",
    "[background] bg_0001 started",
    "[cron] fired health",
    "[SubmitPlan]",
    "[ReviewPlan]",
    "plan_approval_response",
    "[Protocol] 协议请求汇总:",
    // 以下断言防止机制在“能跑通”的假象下退化
    "[autonomous] worker auto-claimed",
    "[CreateWorktree] s20-wt:",
    "worktree 's20-wt' has",
    "[RemoveWorktree] s20-wt: removed",
    "<task-id>bg_0001</task-id>",
    "<output-file>",
    "[Inbox]",
    "注入 lead 上下文",
    "[PersistOutput]",
    "250000",
    "type=plan_approval",
    "type=shutdown",
    "[approved]",
  ],
};

/** 各章不应出现在 stdout 里的内容：机制退化的痕迹。 */
const forbiddenStdout: Record<string, string[]> = {
  s15_agent_teams: [
    "[CheckInbox:analyzer] 收到 0 条消息",
    "[CheckInbox:reviewer] 收到 0 条消息",
  ],
};

/** 各章演示产物（相对工作区根目录，而不是章节目录）。 */
const workspaceArtifacts: Record<string, string[]> = {
  s13_background_tasks: [".task_outputs/bg_0001.log"],
  s14_cron_scheduler: [".scheduled_tasks.json"],
  s15_agent_teams: [
    ".mailboxes/s15/main.jsonl",
    ".mailboxes/s15/analyzer.jsonl",
    ".mailboxes/s15/reviewer.jsonl",
  ],
  s16_team_protocols: [".mailboxes/s16/main.jsonl", ".mailboxes/s16/planner.jsonl"],
  s17_autonomous_agents: [
    ".mailboxes/s17/main.jsonl",
    ".mailboxes/s17/worker.jsonl",
    ".tasks/s17/task_0000_s17_0001.json",
    ".tasks/s17/task_0000_s17_0002.json",
    ".tasks/s17/task_owned_by_lead.json",
    ".tasks/s17/task_owned_by_lead_active.json",
  ],
  s20_comprehensive: [".mailboxes/s20/lead.jsonl", ".mailboxes/s20/worker.jsonl"],
};

for (const [dir, marker] of chapters) {
  test(`章节可独立运行: ${dir}`, async () => {
    // 各章把状态写到工作区下的 .tasks/.memory/... —— 用独立临时工作区隔离，
    // 避免章节之间（如 s12/s14 共用 .tasks）互相污染，也避免污染仓库。
    const workspace = await mkdtemp(join(tmpdir(), `lcc-${dir}-`));
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", join(root, dir, "agent.ts")],
      {
        cwd: root,
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, AGENT_MODE: "mock", AGENT_WORKSPACE: workspace },
      },
    );
    assert.ok(
      stdout.includes(marker),
      `${dir} 输出缺少完成标记 ${marker}，末尾输出:\n${stdout.slice(-500)}`,
    );
    for (const rel of demoArtifacts[dir] ?? []) {
      assert.ok(
        existsSync(join(workspace, dir, rel)),
        `${dir} 未在工作区生成 ${rel}（工作区: ${workspace}）`,
      );
    }
    for (const rel of workspaceArtifacts[dir] ?? []) {
      assert.ok(
        existsSync(join(workspace, rel)),
        `${dir} 未在工作区生成 ${rel}（工作区: ${workspace}）`,
      );
    }
    for (const marker of requiredStdout[dir] ?? []) {
      assert.ok(
        stdout.includes(marker),
        `${dir} 输出里没有 ${marker}：本章声称的机制没被演示到`,
      );
    }
    for (const marker of forbiddenStdout[dir] ?? []) {
      assert.ok(
        !stdout.includes(marker),
        `${dir} 输出里出现了 ${marker}：机制退化或日志噪音又回来了`,
      );
    }
  });
}

test("s15 只清理自己的信箱子目录，不碰共享 .mailboxes 根目录", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lcc-s15-isolation-"));
  const mailboxRoot = join(workspace, ".mailboxes");
  mkdirSync(mailboxRoot, { recursive: true });

  const rootMain = join(mailboxRoot, "main.jsonl");
  const stale =
    JSON.stringify({
      from: "s17",
      to: "main",
      body: "stale-s17-message",
      type: "result",
      timestamp: 1,
    }) + "\n";
  writeFileSync(rootMain, stale, "utf8");

  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", join(root, "s15_agent_teams", "agent.ts")],
    {
      cwd: root,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, AGENT_MODE: "mock", AGENT_WORKSPACE: workspace },
    },
  );

  assert.ok(
    !stdout.includes("stale-s17-message"),
    "s15 读到了共享 .mailboxes 根目录里的旧消息",
  );
  assert.equal(
    readFileSync(rootMain, "utf8"),
    stale,
    "s15 改写了共享 .mailboxes/main.jsonl",
  );
  assert.ok(
    stdout.includes("[CheckInbox:main] 收到 2 条消息"),
    "s15 没有读到自己的两条队友结果",
  );
});

test("s16/s17/s20 只清理自己的信箱子目录，不碰共享 .mailboxes 根目录", async () => {
  const cases = [
    { dir: "s16_team_protocols", leadFile: "main.jsonl", marker: "stale-s16-cross-chapter" },
    { dir: "s17_autonomous_agents", leadFile: "main.jsonl", marker: "stale-s17-cross-chapter" },
    { dir: "s20_comprehensive", leadFile: "lead.jsonl", marker: "stale-s20-cross-chapter" },
  ];

  for (const c of cases) {
    const workspace = await mkdtemp(join(tmpdir(), `lcc-${c.dir}-isolation-`));
    const mailboxRoot = join(workspace, ".mailboxes");
    mkdirSync(mailboxRoot, { recursive: true });

    const stalePath = join(mailboxRoot, c.leadFile);
    const stale =
      JSON.stringify({
        from: "s99",
        to: c.leadFile.replace(".jsonl", ""),
        body: c.marker,
        type: "result",
        timestamp: 1,
      }) + "\n";
    writeFileSync(stalePath, stale, "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", join(root, c.dir, "agent.ts")],
      {
        cwd: root,
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, AGENT_MODE: "mock", AGENT_WORKSPACE: workspace },
      },
    );

    assert.ok(existsSync(stalePath), `${c.dir} 删掉了共享 .mailboxes/${c.leadFile}`);
    assert.ok(
      !stdout.includes(c.marker),
      `${c.dir} 读到了共享 .mailboxes/${c.leadFile} 里的旧消息`,
    );
    assert.equal(
      readFileSync(stalePath, "utf8"),
      stale,
      `${c.dir} 改写了共享 .mailboxes/${c.leadFile}`,
    );
  }
});

test("s17 任务板隔离在 .tasks/s17，且完成两个预置任务", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lcc-s17-task-isolation-"));
  const tasksRoot = join(workspace, ".tasks");
  const s17Dir = join(tasksRoot, "s17");
  const s12Dir = join(tasksRoot, "s12");
  mkdirSync(s17Dir, { recursive: true });
  mkdirSync(s12Dir, { recursive: true });

  const rootTaskPath = join(tasksRoot, "task_root_other.json");
  writeFileSync(
    rootTaskPath,
    JSON.stringify(
      {
        id: "task_root_other",
        subject: "共享根任务",
        description: "",
        status: "pending",
        owner: null,
        blockedBy: [],
      },
      null,
      2,
    ),
    "utf8",
  );

  const s12TaskPath = join(s12Dir, "task_s12_private.json");
  writeFileSync(
    s12TaskPath,
    JSON.stringify(
      {
        id: "task_s12_private",
        subject: "s12 私有任务",
        description: "",
        status: "pending",
        owner: null,
        blockedBy: [],
      },
      null,
      2,
    ),
    "utf8",
  );

  const stalePath = join(s17Dir, "task_stale.json");
  writeFileSync(
    stalePath,
    JSON.stringify({
      id: "task_stale",
      subject: "过期任务",
      description: "",
      status: "pending",
      owner: null,
      blockedBy: [],
    }),
    "utf8",
  );

  const rootBefore = readFileSync(rootTaskPath, "utf8");
  const s12Before = readFileSync(s12TaskPath, "utf8");

  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", join(root, "s17_autonomous_agents", "agent.ts")],
    {
      cwd: root,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, AGENT_MODE: "mock", AGENT_WORKSPACE: workspace },
    },
  );

  assert.equal(readFileSync(rootTaskPath, "utf8"), rootBefore, "s17 改写了共享 .tasks 根目录的任务");
  assert.equal(readFileSync(s12TaskPath, "utf8"), s12Before, "s17 改写了 .tasks/s12 的任务");
  assert.ok(!stdout.includes("共享根任务"), "s17 扫描到了共享 .tasks 根目录的任务");
  assert.ok(!stdout.includes("s12 私有任务"), "s17 扫描到了其它章节的任务");
  assert.ok(!existsSync(stalePath), "s17 启动时没有重置自己的任务目录");

  const readTask = (name: string): { status: string; owner: string | null } =>
    JSON.parse(readFileSync(join(s17Dir, name), "utf8")) as { status: string; owner: string | null };

  const a = readTask("task_0000_s17_0001.json");
  assert.equal(a.status, "completed");
  assert.equal(a.owner, "worker");

  const b = readTask("task_0000_s17_0002.json");
  assert.equal(b.status, "completed");
  assert.equal(b.owner, "worker");

  const owned = readTask("task_owned_by_lead.json");
  assert.equal(owned.status, "pending");
  assert.equal(owned.owner, "main");

  const ownedActive = readTask("task_owned_by_lead_active.json");
  assert.equal(ownedActive.status, "in_progress");
  assert.equal(ownedActive.owner, "main");

  const reportAt = stdout.indexOf("收到自主工作者的报告：");
  assert.ok(reportAt >= 0, "lead 没有收到 worker 的报告");
  const report = stdout.slice(reportAt);
  assert.ok(report.includes("task_0000_s17_0001"), "报告里没有 task_0000_s17_0001");
  assert.ok(report.includes("task_0000_s17_0002"), "报告里没有 task_0000_s17_0002");
});

test("s20 的 worktree/任务/后台在干净工作区真实落盘", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lcc-s20-mechanisms-"));
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", join(root, "s20_comprehensive", "agent.ts")],
      {
        cwd: root,
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, AGENT_MODE: "mock", AGENT_WORKSPACE: workspace },
      },
    );

    assert.match(stdout, /\[autonomous\] worker auto-claimed/, "worker 没有自主认领任务");
    assert.match(stdout, /type=plan_approval .*\[approved\]/, "计划审批没有在汇总里落为 approved");
    assert.match(stdout, /type=shutdown .*\[approved\]/, "关机协议没有在汇总里落为 approved");

    // worktree：先创建、有变更时拒绝删除、最后 discard 删除
    assert.equal(
      existsSync(join(workspace, ".worktrees", "s20-wt")),
      false,
      "R15 之后 worktree 目录应被删除",
    );
    const events = readFileSync(join(workspace, ".worktrees", "events.jsonl"), "utf8");
    assert.match(events, /"type":"create"/);
    assert.match(events, /"type":"remove"/);
    assert.match(events, /"task_id":"task_/, "create_worktree 的 taskId 没有写进事件日志");

    // 后台输出与大输出落盘
    const bgOutput = join(workspace, ".task_outputs", "bg_0001.log");
    assert.ok(existsSync(bgOutput), "后台任务没有写 output-file");
    assert.match(readFileSync(bgOutput, "utf8"), /\[simulated\]/);
    const persisted = join(workspace, ".task_outputs", "tool-results", "L8a.txt");
    assert.ok(existsSync(persisted), "大输出没有触发 PersistOutput");
    assert.equal(readFileSync(persisted, "utf8").length, 250_000);

    // 任务图：worker 自主认领 D，lead 认领并完成 C
    const taskDir = join(workspace, ".tasks");
    const tasks = readdirSync(taskDir)
      .filter((f) => f.endsWith(".json"))
      .map(
        (f) =>
          JSON.parse(readFileSync(join(taskDir, f), "utf8")) as {
            subject: string;
            status: string;
            owner: string | null;
            preferredOwner?: string | null;
          },
      );
    const bySubject = new Map(tasks.map((t) => [t.subject, t]));
    const migration = bySubject.get("编写迁移说明");
    assert.ok(migration, "缺少“编写迁移说明”任务");
    assert.equal(migration.status, "completed");
    assert.equal(migration.owner, "worker");
    assert.equal(migration.preferredOwner, "worker");
    const integration = bySubject.get("集成测试");
    assert.ok(integration, "缺少“集成测试”任务");
    assert.equal(integration.status, "completed");
    assert.equal(integration.owner, "lead");
    assert.equal(integration.preferredOwner, "lead");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("章节演示产物不再落进仓库（回归守卫）", () => {
  // 这几个路径出现在仓库里，说明有章节的产物写错了位置（应落在章节目录的 .output/
  // 或 worktree 内）。跑过 `npm run sNN` 的开发者本地也可能存在同名文件，这里只查这几处。
  const polluting = ["s02_output.txt", "docs/report.md", "docs/worker-note.md", "auth.patch"].filter((rel) =>
    existsSync(join(root, rel)),
  );
  assert.deepEqual(polluting, [], `以下演示产物又写回了仓库:\n${polluting.join("\n")}`);
});
