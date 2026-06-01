/**
 * learn-claude-code-typescript 核心运行时
 *
 * 三个原语，构成完整的代数效应系统：
 *
 * 1. Effect — 声明"要做什么"（纯数据，无副作用）
 * 2. perform() — Generator 内部 yield 效应的入口
 * 3. runAgent() — 驱动循环，将效应路由到 Handler
 */

// ============================================================
// 核心类型
// ============================================================

/**
 * 所有效应的基类。
 * input  = handler 接收的数据
 * output = handler 返回的数据（phantom type，编译期推导用）
 */
export interface BaseEffect {
  type: string;
  input: unknown;
  output: unknown;
}

/**
 * Handler：接收完整 effect 对象，返回与 effect.output 匹配的值
 */
export type EffectHandler<E extends BaseEffect> = (effect: E) => Promise<E['output']>;

/**
 * Handlers 映射表：每个 effect.type 对应一个 handler
 */
export type EffectHandlers<E extends BaseEffect> = {
  [K in E['type']]: EffectHandler<Extract<E, { type: K }>>;
};

/**
 * 根据 effect type 字符串推导返回类型
 */
type InferOutput<E extends BaseEffect, K extends E['type']> =
  Extract<E, { type: K }>['output'];

/**
 * perform 函数类型。
 * 调用方式：const result = yield* perform({ type: 'Xxx', input: {...} })
 * result 的类型由 Effect 定义中的 output 自动推导。
 */
export interface PerformFn<E extends BaseEffect> {
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
export type AgentFactory<E extends BaseEffect, TReturn = unknown> =
  (perform: PerformFn<E>) => Generator<E, TReturn, unknown>;

// ============================================================
// createPerform — 创建类型化的 perform 函数
// ============================================================

export function createPerform<E extends BaseEffect>(): PerformFn<E> {
  return function* (effect) {
    return (yield effect) as any;
  } as PerformFn<E>;
}

// ============================================================
// runAgent — 驱动循环
//
// 等价于 Python 的：
//   while True:
//     response = client.messages.create(...)
//     if stop_reason != "tool_use": return
//     results = dispatch_tools(response)
//     messages.append(results)
//
// 等价关系：
//   Python stop_reason == "tool_use"  →  Generator done === false
//   Python stop_reason != "tool_use"  →  Generator done === true
//   Python TOOL_HANDLERS[name](**args) →  handlers[effect.type](effect)
//   Python messages.append(result)    →  agent.next(result)
// ============================================================

export async function runAgent<E extends BaseEffect, TReturn = unknown>(
  factory: AgentFactory<E, TReturn>,
  handlers: EffectHandlers<E>
): Promise<TReturn> {
  const perform = createPerform<E>();
  const agent = factory(perform);

  let lastResult: unknown;

  while (true) {
    try {
      const { value, done } = agent.next(lastResult);

      // Generator 返回（done === true）= Python 的 stop_reason != "tool_use"
      if (done) return value as TReturn;

      const effect = value as E;
      const handler = handlers[effect.type as E['type']] as unknown as EffectHandler<E>;

      if (!handler) {
        throw new Error(`[runAgent] 未找到 effect 类型的 handler: "${effect.type}"`);
      }

      // 执行 handler，结果将通过 agent.next() 注入回 Generator
      // 等价于 Python 的：messages.append(tool_result)
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
