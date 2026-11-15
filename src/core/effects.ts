export interface Effect<Type extends string = string, Input = unknown, Output = unknown> {
  type: Type;
  input: Input;
  output: Output;
}

export type EffectInput<E extends Effect, Type extends E["type"]> =
  Extract<E, { type: Type }>["input"];

export type EffectOutput<E extends Effect, Type extends E["type"]> =
  Extract<E, { type: Type }>["output"];

export interface Perform<E extends Effect> {
  <Type extends E["type"]>(
    effect: { type: Type; input: EffectInput<E, Type> },
  ): Generator<Extract<E, { type: Type }>, EffectOutput<E, Type>, EffectOutput<E, Type>>;
}

export type EffectHandler<E extends Effect> = (effect: E) => Promise<E["output"]> | E["output"];

export type EffectHandlers<E extends Effect> = {
  [Type in E["type"]]: EffectHandler<Extract<E, { type: Type }>>;
};

export type AgentProgram<E extends Effect, Result> = (perform: Perform<E>) => Generator<E, Result, unknown>;

export function createPerform<E extends Effect>(): Perform<E> {
  return function* perform(effect) {
    return yield effect as Extract<E, { type: typeof effect.type }>;
  } as Perform<E>;
}

export async function runEffects<E extends Effect, Result>(
  program: AgentProgram<E, Result>,
  handlers: EffectHandlers<E>,
): Promise<Result> {
  const iterator = program(createPerform<E>());
  let step = iterator.next();

  while (true) {
    if (step.done) {
      return step.value;
    }

    const effect = step.value;
    const handler = handlers[effect.type as E["type"]] as unknown as EffectHandler<E> | undefined;
    if (!handler) {
      throw new Error(`没有找到效应处理器: ${effect.type}`);
    }

    try {
      step = iterator.next(await handler(effect));
    } catch (error) {
      // 把失败交还给 Agent 逻辑；它在 catch 内 yield 的新效应由 throw() 返回，回到循环顶部照常执行
      step = iterator.throw(error);
    }
  }
}
