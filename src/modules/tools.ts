import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { specsToToolDefinitions } from "../core/tool-specs.ts";
import type { ToolDefinition } from "../core/types.ts";

const execFileAsync = promisify(execFile);

export interface ToolContext {
  cwd: string;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<string> | string;

/** 基础工具的名字列表（与 createBaseTools 的 key 一一对应）。 */
export const BASE_TOOL_NAMES = ["bash", "read_file", "write_file", "edit_file", "glob"] as const;

// 定义从 runtime 注册表派生，name/description/parameters 不再手写。
export const baseToolDefinitions: ToolDefinition[] = specsToToolDefinitions(...BASE_TOOL_NAMES);

export function safePath(cwd: string, path: string): string {
  const full = resolve(cwd, path);
  const root = resolve(cwd);
  if (full !== root && !full.startsWith(`${root}/`)) {
    throw new Error(`路径逃逸工作区: ${path}`);
  }
  return full;
}

export function createBaseTools(context: ToolContext): Record<string, ToolHandler> {
  return {
    bash: async (args) => {
      const command = String(args.command ?? "");
      if (!command.trim()) return "Error: command required";
      if (/(rm\s+-rf\s+\/|sudo|shutdown|reboot|>\s*\/dev\/)/.test(command)) {
        return "Error: 危险命令已被拦截";
      }

      const { stdout, stderr } = await execFileAsync("sh", ["-lc", command], {
        cwd: context.cwd,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      });
      return `${stdout}${stderr}`.trim() || "(no output)";
    },

    read_file: async (args) => {
      const path = safePath(context.cwd, String(args.path ?? ""));
      return readFile(path, "utf8");
    },

    write_file: async (args) => {
      const path = safePath(context.cwd, String(args.path ?? ""));
      const content = String(args.content ?? "");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
      return `写入 ${content.length} 字节: ${args.path}`;
    },

    edit_file: async (args) => {
      const path = safePath(context.cwd, String(args.path ?? ""));
      const oldText = String(args.old_text ?? "");
      const newText = String(args.new_text ?? "");
      const current = await readFile(path, "utf8");
      if (!current.includes(oldText)) {
        return `Error: 未找到待替换文本: ${args.path}`;
      }
      await writeFile(path, current.replace(oldText, newText), "utf8");
      return `已编辑: ${args.path}`;
    },

    glob: async (args) => {
      const pattern = String(args.pattern ?? "");
      const files = await listFiles(context.cwd);
      const matcher = globToRegExp(pattern);
      const matches = files.filter((file) => matcher.test(file));
      return matches.length > 0 ? matches.join("\n") : "(no matches)";
    },
  };
}

async function listFiles(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    if (entry.name === "node_modules" || entry.name === ".git") return [];
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) return listFiles(root, full);
    return [full.slice(root.length + 1)];
  }));
  return nested.flat();
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}
