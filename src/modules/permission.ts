export type PermissionDecision = "allow" | "ask" | "deny";

export interface PermissionResult {
  decision: PermissionDecision;
  reason: string;
}

export interface PermissionRule {
  name: string;
  tools: string[];
  check: (args: Record<string, unknown>) => boolean;
  reason: string;
  decision: PermissionDecision;
}

export class PermissionPipeline {
  private readonly denyPatterns = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "> /dev/sda"];
  private readonly rules: PermissionRule[];

  constructor(rules: PermissionRule[] = []) {
    this.rules = rules;
  }

  check(toolName: string, args: Record<string, unknown>): PermissionResult {
    if (toolName === "bash") {
      const command = String(args.command ?? "");
      const denied = this.denyPatterns.find((pattern) => command.includes(pattern));
      if (denied) {
        return { decision: "deny", reason: `命中硬拒绝规则: ${denied}` };
      }
    }

    for (const rule of this.rules) {
      if (rule.tools.includes(toolName) && rule.check(args)) {
        return { decision: rule.decision, reason: rule.reason };
      }
    }

    return { decision: "allow", reason: "无风险规则命中" };
  }
}

export function defaultPermissionPipeline(workspace: string): PermissionPipeline {
  return new PermissionPipeline([
    {
      name: "write-outside-workspace",
      tools: ["write_file", "edit_file"],
      decision: "ask",
      reason: "写入工作区外部路径",
      check: (args) => {
        const path = String(args.path ?? "");
        return path.startsWith("/") && !path.startsWith(workspace);
      },
    },
    {
      name: "destructive-shell",
      tools: ["bash"],
      decision: "ask",
      reason: "可能破坏文件或权限的 shell 命令",
      check: (args) => /\brm\b|chmod\s+777|>\s*\/etc\//.test(String(args.command ?? "")),
    },
  ]);
}
