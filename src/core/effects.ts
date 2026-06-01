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
  let lastValue: unknown;

  while (true) {
    const step = iterator.next(lastValue);
    if (step.done) {
      return step.value;
    }

    const effect = step.value;
    const handler = handlers[effect.type as E["type"]] as unknown as EffectHandler<E> | undefined;
    if (!handler) {
      throw new Error(`没有找到效应处理器: ${effect.type}`);
    }

    try {
      lastValue = await handler(effect);
    } catch (error) {
      const thrown = iterator.throw?.(error);
      if (!thrown) {
        throw error;
      }
      if (thrown.done) {
        return thrown.value;
      }
      lastValue = thrown.value;
    }
  }
}
