export type HookEvent = "PreToolUse" | "PostToolUse" | "Stop" | "Error";

export interface HookContext {
  event: HookEvent;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: string;
  error?: unknown;
}

export interface HookResult {
  allow?: boolean;
  message?: string;
  extraContext?: string;
}

export type Hook = (context: HookContext) => Promise<HookResult> | HookResult;

export class HookManager {
  private readonly hooks = new Map<HookEvent, Hook[]>();

  register(event: HookEvent, hook: Hook): void {
    const list = this.hooks.get(event) ?? [];
    list.push(hook);
    this.hooks.set(event, list);
  }

  async run(context: HookContext): Promise<HookResult[]> {
    const results: HookResult[] = [];
    for (const hook of this.hooks.get(context.event) ?? []) {
      results.push(await hook(context));
    }
    return results;
  }
}

export function createAuditHooks(log: (message: string) => void): HookManager {
  const manager = new HookManager();
  manager.register("PreToolUse", ({ toolName, args }) => {
    log(`[hook:pre] ${toolName} ${JSON.stringify(args)}`);
    return { allow: true };
  });
  manager.register("PostToolUse", ({ toolName, result }) => {
    if ((result?.length ?? 0) > 2_000) {
      return { message: `${toolName} 返回较大结果，建议触发 compact。` };
    }
    return {};
  });
  return manager;
}
