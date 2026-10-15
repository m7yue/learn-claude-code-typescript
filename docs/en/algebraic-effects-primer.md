# Algebraic Effects Primer: Understand It in a Frontend-Friendly Way

Many people see the term Algebraic Effects for the first time and feel it sounds academic. In this project, you can skip the full formal theory and focus on one sentence:

```txt
Algebraic effects = business logic declares “what I want to do”, and the runtime decides “how to do it”.
```

## First look at the usual way

If an Agent wants to run a shell command, the most direct code is:

```ts
const output = await exec(command);
```

The problem with this line is: Agent logic is mixed in with the actual side effect. If you later want to add permission checks, logging, mocking, sandboxing, or retries, you have to change around this line.

## Now look at the effect-based way

In this project, Agent logic is written like this:

```ts
const output = yield* perform({
  type: "BashExec",
  input: { command },
});
```

This does not execute the command directly; it only declares:

```txt
I need a BashExec effect.
```

How it is actually handled is decided by an external handler:

```ts
const handlers = {
  BashExec: async (effect) => {
    return exec(effect.input.command);
  },
};
```

With a different handler, the same Agent can become:

- Teaching mode: return a fixed string and do not execute the shell.
- Test mode: record the call and assert the parameters.
- Safe mode: verify permissions before deciding whether to execute.
- Real mode: call shell, filesystem, model APIs, or MCP tools.

## What is similar in frontend concepts?

If you have frontend experience, you can compare it to these ideas:

| Frontend experience | Similar idea in algebraic effects |
| --- | --- |
| A user clicks a button triggering an event | Agent `perform()` an effect |
| A reducer only describes how state changes | Agent only describes the next intent |
| Middleware intercepts actions | handler/hook intercepts effects |
| Mock service worker replaces network requests | test handler replaces real side effects |

The analogy is not exact, but it helps build intuition: the core idea is still separating “declare” and “interpret”.

## How does this relate to React?

Frontend developers are not completely unfamiliar with this idea.

React is not a language that supports algebraic effects, and React Hooks are not the same thing. But many design decisions in React expose a similar intuition: components declare what UI they want, while the runtime decides how to update the DOM, schedule work, pause, resume, and execute side effects.

For example:

```tsx
function Profile() {
  const [name, setName] = useState("Ada");

  useEffect(() => {
    document.title = name;
  }, [name]);

  return <h1>{name}</h1>;
}
```

You do not manually create and update the DOM in the component, and you do not decide when the effect actually runs. You simply describe state, UI, and side effects, and React runtime interprets them.

The intuition behind Suspense is also similar:

```tsx
<Suspense fallback={<Loading />}>
  <Profile />
</Suspense>
```

If the subtree is not ready, React can temporarily render the fallback and continue when the condition is met. It is not a complete implementation of algebraic effects, but it makes the core idea easier to understand:

```txt
Business code can declare that it needs some capability, and the outer runtime is responsible for catching, interpreting, and resuming.
```

The `yield* perform(effect)` in this project does something similar: Agent code declares “I want to read a file / execute a command / request permission”, and the outer `runAgent()` plus handlers interpret it.

## Why is Agent especially suitable for this model?

A Coding Agent constantly interacts with the real world:

- read files
- write files
- run commands
- create tasks
- call sub-agents
- load memories
- call MCP tools

These actions all carry risks and need to be observed, tested, and replaceable. If Agent logic directly does `await readFile()` or `await exec()` everywhere, the system quickly becomes hard to control.

Algebraic effects let us turn all actions into clear intentions:

```txt
ReadFile
WriteFile
BashExec
RequestPermission
LoadSkill
ReadMemory
CreateTask
MCPToolCall
```

Then the runtime interprets those intentions centrally.

## The three keywords in this project

| Keyword | Purpose |
| --- | --- |
| Effect | A piece of pure data that describes what the Agent wants to do |
| Handler | Interprets the Effect and executes the real or simulated side effect |
| runAgent | Drives the Generator and sends handler results back to the Agent |

You can understand algebraic effects at this level first, then read each chapter. The complete theory can come later; for understanding Agent harness, this intuition is already very useful.
