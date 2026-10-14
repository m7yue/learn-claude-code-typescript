/**
 * learn-claude-code-typescript 核心运行时
 *
 * 三个基本部件，构成完整的代数效应系统：
 *
 * 1. Effect — 声明"要做什么"（纯数据，无副作用）
 * 2. perform() — Generator 内部 yield 效应的入口
 * 3. runAgent() — 驱动循环，将效应路由到 Handler
 */

// ============================================================
// 核心类型
// ============================================================

/**
 * 泛型效应基座：type 是路由键，input 是 handler 入参，output 是 handler 返回值。
 *
 * 与工程层 src/core/effects.ts 的 Effect 保持同一形状，章节统一用它来声明效应：
 *   interface ChatEffect extends Effect<'Chat', { messages: Message[] }, LLMResponse> {}
 */
export interface Effect<
  Type extends string = string,
  Input = unknown,
  Output = unknown,
> {
  type: Type;
  input: Input;
  output: Output;
}

/**
 * Handler：接收完整 effect 对象，返回与 effect.output 匹配的值
 */
export type EffectHandler<E extends Effect> = (effect: E) => Promise<E['output']>;

/**
 * Handlers 映射表：每个 effect.type 对应一个 handler
 */
export type EffectHandlers<E extends Effect> = {
  [K in E['type']]: EffectHandler<Extract<E, { type: K }>>;
};

/**
 * 根据 effect type 字符串推导返回类型
 */
type InferOutput<E extends Effect, K extends E['type']> =
  Extract<E, { type: K }>['output'];

/**
 * perform 函数类型。
 * 调用方式：const result = yield* perform({ type: 'Xxx', input: {...} })
 * result 的类型由 Effect 定义中的 output 自动推导。
 */
export interface PerformFn<E extends Effect> {
  <K extends E['type']>(
    effect: { type: K; input: Extract<E, { type: K }>['input'] }
  ): Generator<
    Extract<E, { type: K }>,
    InferOutput<E, K>,
    InferOutput<E, K>
  >;
}

/**
 * Agent 工厂函数类型：接收 perform，返回 Generator
 */
export type AgentFactory<E extends Effect, TReturn = unknown> =
  (perform: PerformFn<E>) => Generator<E, TReturn, unknown>;

// ============================================================
// createPerform — 创建类型化的 perform 函数
// ============================================================

export function createPerform<E extends Effect>(): PerformFn<E> {
  return function* (effect) {
    return (yield effect) as any;
  } as PerformFn<E>;
}

// ============================================================
// runAgent — 驱动循环
//
// 把 Generator 当作状态机反复驱动，直到它结束：
//   - agent.next(value)：把上一个 handler 的结果交回 Generator，取下一个 effect
//   - Generator 未完成（done === false）：拿到一个 effect，路由到对应 handler 执行
//   - Generator 完成（done === true）：把它的返回值作为 runAgent 的结果
//   - agent.throw(error)：把 handler 抛出的错误注入 Generator，交给 Agent 业务逻辑处理
//
// 对照关系（模型返回 → Generator 状态）：
//   模型 stop_reason == "tool_use"  →  Generator done === false
//   模型 stop_reason != "tool_use"  →  Generator done === true
//   工具调用 handlers[name](input)  →  handlers[effect.type](effect)
//   工具结果追加进消息列表           →  agent.next(result)
// ============================================================

export async function runAgent<E extends Effect, TReturn = unknown>(
  factory: AgentFactory<E, TReturn>,
  handlers: EffectHandlers<E>
): Promise<TReturn> {
  const perform = createPerform<E>();
  const agent = factory(perform);

  let lastResult: unknown;

  while (true) {
    try {
      const { value, done } = agent.next(lastResult);

      // Generator 返回（done === true）：模型已给出最终答复，任务结束
      if (done) return value as TReturn;

      const effect = value as E;
      const handler = handlers[effect.type as E['type']] as unknown as EffectHandler<E>;

      if (!handler) {
        throw new Error(`[runAgent] 未找到 effect 类型的 handler: "${effect.type}"`);
      }

      // 执行 handler，结果将通过 agent.next() 注入回 Generator
      lastResult = await handler(effect);

    } catch (error) {
      // 将错误注入 Generator，让 Agent 业务逻辑决定如何处理
      const { value, done } = agent.throw(error);
      if (done) return value as TReturn;
      // Generator 在 catch 块内 yield 了新 effect，必须立即处理
      // （不能等下一轮 agent.next(lastResult)，那会跳过这个 effect）
      const effect = value as E;
      const handler = handlers[effect.type as E['type']] as unknown as EffectHandler<E>;
      if (!handler) {
        throw new Error(`[runAgent] 未找到 effect 类型的 handler: "${effect.type}"`);
      }
      lastResult = await handler(effect);
    }
  }
}
