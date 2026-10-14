import type { AgentProgram, Effect } from "./effects.ts";
import { runEffects, type EffectHandlers, type Perform } from "./effects.ts";
import type { Message, Model, ModelTurn, ToolDefinition } from "./types.ts";

export interface LogEffect extends Effect<"Log", { message: string }, void> {}

export interface ModelEffect extends Effect<
  "Model",
  { system: string; messages: Message[]; tools: ToolDefinition[] },
  ModelTurn
> {}

export interface ToolCallEffect extends Effect<
  "ToolCall",
  { name: string; args: Record<string, unknown>; requiresApproval?: boolean },
  string
> {}

export interface ApprovalEffect extends Effect<
  "Approval",
  { reason: string; payload: unknown },
  boolean
> {}

export interface DelegateEffect extends Effect<
  "Delegate",
  { role: string; task: string },
  string
> {}

export type CoreEffect = LogEffect | ModelEffect | ToolCallEffect | ApprovalEffect | DelegateEffect;

export interface AgentLoopOptions {
  system: string;
  query: string;
  tools: ToolDefinition[];
  maxTurns?: number;
  /**
   * 判断某个工具调用是否需要先经过审批。
   *
   * 返回 true 时，loop 会 yield 一个 ApprovalEffect（与 s03 的权限检查流程一致）。
   * 默认恒为 false，因此不传此选项时，所有工具都直接执行、不经过审批。
   */
  requiresApproval?: (name: string, args: Record<string, unknown>) => boolean;
}

export function agentLoop(options: AgentLoopOptions): AgentProgram<CoreEffect, Message[]> {
  return function* loop(perform: Perform<CoreEffect>) {
    const messages: Message[] = [{ role: "user", content: options.query }];
    const maxTurns = options.maxTurns ?? 12;
    const requiresApproval = options.requiresApproval ?? (() => false);

    for (let turn = 0; turn < maxTurns; turn += 1) {
      const response = yield* perform({
        type: "Model",
        input: { system: options.system, messages, tools: options.tools },
      });

      messages.push({ role: "assistant", content: response.content });

      if (response.stopReason !== "tool_use") {
        yield* perform({
          type: "Log",
          input: { message: `Agent 循环结束: ${response.stopReason}` },
        });
        return messages;
      }

      for (const toolUse of response.toolUses) {
        // 需要审批的工具：由 generator 声明一个 Approval 效应，
        // 把「是否允许」交给运行时（与 s03 的权限检查流程一致）。
        if (requiresApproval(toolUse.name, toolUse.args)) {
          const approved = yield* perform({
            type: "Approval",
            input: {
              reason: `工具 ${toolUse.name} 需要审批`,
              payload: { name: toolUse.name, args: toolUse.args },
            },
          });
          if (!approved) {
            messages.push({
              role: "tool",
              name: toolUse.name,
              content: `tool_use_id=${toolUse.id}\n[拒绝] 工具 ${toolUse.name} 未获批准`,
            });
            continue;
          }
        }

        const result = yield* perform({
          type: "ToolCall",
          input: { name: toolUse.name, args: toolUse.args },
        });
        messages.push({
          role: "tool",
          name: toolUse.name,
          content: `tool_use_id=${toolUse.id}\n${result}`,
        });
      }
    }

    messages.push({ role: "assistant", content: "达到最大轮次，停止执行。" });
    return messages;
  };
}

export function createCoreHandlers(input: {
  model: Model;
  tools: Record<string, (args: Record<string, unknown>) => Promise<string> | string>;
  approve?: (reason: string, payload: unknown) => Promise<boolean> | boolean;
  log?: (message: string) => Promise<void> | void;
  delegate?: (role: string, task: string) => Promise<string> | string;
}): EffectHandlers<CoreEffect> {
  return {
    Log: async (effect) => {
      await input.log?.(effect.input.message);
    },
    Model: async (effect) => {
      return input.model.complete(effect.input);
    },
    Approval: async (effect) => {
      return input.approve?.(effect.input.reason, effect.input.payload) ?? false;
    },
    ToolCall: async (effect) => {
      const { name, args, requiresApproval } = effect.input;
      // 拦截式审批：调用方也可以不进 ApprovalEffect，而是直接在 ToolCall 上
      // 标记 requiresApproval。两种方式都受支持：
      //   - agentLoop 的 requiresApproval 选项 → yield ApprovalEffect（推荐）
      //   - ToolCall.input.requiresApproval → 在 handler 内即时拦截
      if (requiresApproval) {
        const approved = input.approve?.(`工具 ${name} 需要审批`, args) ?? false;
        if (!approved) {
          throw new Error(`工具调用未获批准: ${name}`);
        }
      }

      const tool = input.tools[name];
      if (!tool) {
        throw new Error(`未知工具: ${name}`);
      }
      return tool(args);
    },
    Delegate: async (effect) => {
      if (!input.delegate) {
        throw new Error("当前运行时没有配置 Delegate 处理器");
      }
      return input.delegate(effect.input.role, effect.input.task);
    },
  };
}

export async function runAgent<Result>(
  program: AgentProgram<CoreEffect, Result>,
  handlers: EffectHandlers<CoreEffect>,
): Promise<Result> {
  return runEffects(program, handlers);
}
