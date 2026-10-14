/**
 * 静态校验：各章 schemasFor(...) 传入的每个字符串字面量都已在注册表中。
 *
 * 这比 e2e 更早定位问题——e2e 只在子进程崩溃时才发现，这里直接指出是哪个名字、哪一章。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_SPECS } from "../runtime/tool-schemas.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const chapters = [
  "s01_agent_loop", "s02_tool_use", "s03_permission", "s04_hooks", "s05_todo_write",
  "s06_subagent", "s07_skill_loading", "s08_context_compact", "s09_memory", "s10_system_prompt",
  "s11_error_recovery", "s12_task_system", "s13_background_tasks", "s14_cron_scheduler",
  "s15_agent_teams", "s16_team_protocols", "s17_autonomous_agents", "s18_worktree_isolation",
  "s19_mcp_plugin", "s20_comprehensive",
];

test("各章 schemasFor 的字面量工具名都已注册", async () => {
  const missing: string[] = [];

  for (const dir of chapters) {
    const source = await readFile(join(root, dir, "agent.ts"), "utf8");
    for (const call of source.matchAll(/schemasFor\(([^)]*)\)/g)) {
      for (const literal of call[1].matchAll(/['"]([^'"]+)['"]/g)) {
        const name = literal[1];
        if (!Object.prototype.hasOwnProperty.call(TOOL_SPECS, name)) {
          missing.push(`${dir}: ${name}`);
        }
      }
    }
  }

  assert.deepEqual(missing, [], `以下 schemasFor 名称未注册:\n${missing.join("\n")}`);
});
