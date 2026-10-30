/**
 * 工程层 harness 的可复用入口。
 *
 * CLI（src/harness.ts）和 evals 共用这里的组装：同一套工具、权限、提示词和循环。
 * 两边各写一份组装逻辑，工具集或审批规则一改就会漂移。
 */

import type { LLMUsage } from "../runtime/types.ts";
import { agentLoop, createCoreHandlers, runAgent } from "./core/agent.ts";
import type { Message, Model } from "./core/types.ts";
import { createTeachingHarness } from "./modules/comprehensive.ts";
import { buildHarnessTools } from "./modules/harness-tools.ts";
import { createAuditHooks } from "./modules/hooks.ts";

/** 评测可用的观察点；CLI 不传，行为不变。 */
export interface HarnessObserver {
  onModelTurn?(event: {
    turn: number;
    stopReason: string;
    content: string;
    usage?: LLMUsage;
    durationMs: number;
  }): void;
  onToolCall?(event: {
    name: string;
    args: Record<string, unknown>;
    result: string;
    error: boolean;
    durationMs: number;
  }): void;
  onApproval?(event: {
    toolName: string;
    args: Record<string, unknown>;
    /** 权限管线的结论：allow / ask / deny。 */
    decision: "allow" | "ask" | "deny";
    /** 最终是否放行；非交互场景里 ask 也会被拒绝。 */
    approved: boolean;
    /** 权限管线给出的原因。 */
    reason: string;
    /** agentLoop 请求审批的理由，例如“工具 bash 需要审批”。 */
    requestReason: string;
  }): void;
}

export interface HarnessAgentOptions {
  cwd: string;
  model: Model;
  maxTurns?: number;
  /** 结构化事件钩子；评测用它记 trace，CLI 用它打印权限消息。 */
  observer?: HarnessObserver;
  /** 循环与审计钩子的日志，调用方决定前缀和去处。 */
  log?: (message: string) => void;
}

export interface HarnessRunResult {
  messages: Message[];
  finalAnswer: string;
}

export interface HarnessAgent {
  system: string;
  run(query: string): Promise<HarnessRunResult>;
}

export function createHarnessAgent(options: HarnessAgentOptions): HarnessAgent {
  const { cwd, model, maxTurns = 12, observer } = options;
  const log = options.log ?? (() => {});

  const harness = createTeachingHarness(cwd);
  const { definitions: tools, handlers } = buildHarnessTools({
    cwd,
    tasks: harness.tasks,
    team: harness.team,
    todos: harness.todos,
  });

  // 审计钩子包在工具执行外面：与 src/harness.ts 的 CLI 行为一致。
  const audit = createAuditHooks((message) => log(message));
  // 包装每个工具 handler：只记录调用和结果，不改变原有语义；
  // handler 抛错时照常抛出，是否终止循环仍由 agentLoop 决定。
  const observedHandlers: Record<
    string,
    (args: Record<string, unknown>) => Promise<string>
  > = {};
  for (const [name, handler] of Object.entries(handlers)) {
    observedHandlers[name] = async (args) => {
      await audit.run({ event: "PreToolUse", toolName: name, args });
      const startedAt = Date.now();
      try {
        const result = await handler(args);
        observer?.onToolCall?.({
          name,
          args,
          result,
          error: false,
          durationMs: Date.now() - startedAt,
        });
        for (const outcome of await audit.run({ event: "PostToolUse", toolName: name, result })) {
          if (outcome.message) log(outcome.message);
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        observer?.onToolCall?.({
          name,
          args,
          result: message,
          error: true,
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
    };
  }

  // 权限管线 → ApprovalEffect 的批准函数。
  // 非交互场景没有「人工确认」，所以 ask 和 deny 一样拒绝。
  function approve(requestReason: string, payload: unknown): boolean {
    const { name, args } = payload as { name: string; args: Record<string, unknown> };
    const result = harness.permission.check(name, args);
    if (result.decision === "deny") {
      observer?.onApproval?.({
        toolName: name,
        args,
        decision: "deny",
        approved: false,
        reason: result.reason,
        requestReason,
      });
      return false;
    }
    if (result.decision === "ask") {
      // 非交互式 harness 默认保守拒绝；需要放行时由调用方自定义规则。
      observer?.onApproval?.({
        toolName: name,
        args,
        decision: "ask",
        approved: false,
        reason: result.reason,
        requestReason,
      });
      return false;
    }
    observer?.onApproval?.({
      toolName: name,
      args,
      decision: "allow",
      approved: true,
      reason: result.reason,
      requestReason,
    });
    return true;
  }

  // 包一层模型只做观察：记录轮次、stopReason 和 usage，不改请求内容。
  let turn = 0;
  const observedModel: Model = {
    async complete(input) {
      const startedAt = Date.now();
      const response = await model.complete(input);
      turn += 1;
      observer?.onModelTurn?.({
        turn,
        stopReason: response.stopReason,
        content: response.content,
        usage: response.usage,
        durationMs: Date.now() - startedAt,
      });
      return response;
    },
  };

  // 与 CLI 一致：当前没有未完成 todo 或队友上下文，这两段提示词不组装。
  const system = harness.prompt.assemble({ cwd, hasOpenTodos: false, hasTeam: false });

  return {
    system,
    async run(query) {
      const messages = await runAgent(
        agentLoop({
          system,
          query,
          tools,
          maxTurns,
          requiresApproval: (name, args) => harness.permission.check(name, args).decision !== "allow",
        }),
        createCoreHandlers({
          model: observedModel,
          tools: observedHandlers,
          approve,
          log,
        }),
      );
      const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
      return { messages, finalAnswer: lastAssistant?.content ?? "" };
    },
  };
}
