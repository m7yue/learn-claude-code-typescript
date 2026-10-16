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
import { existsSync } from "node:fs";
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
    for (const marker of requiredStdout[dir] ?? []) {
      assert.ok(
        stdout.includes(marker),
        `${dir} 输出里没有 ${marker}：本章声称的机制没被演示到`,
      );
    }
  });
}

test("章节演示产物不再落进仓库（回归守卫）", () => {
  // 这几个路径出现在仓库里，说明有章节的产物写错了位置（应落在章节目录的 .output/
  // 或 worktree 内）。跑过 `npm run sNN` 的开发者本地也可能存在同名文件，这里只查这几处。
  const polluting = ["s02_output.txt", "docs/report.md", "docs/worker-note.md", "auth.patch"].filter((rel) =>
    existsSync(join(root, rel)),
  );
  assert.deepEqual(polluting, [], `以下演示产物又写回了仓库:\n${polluting.join("\n")}`);
});
