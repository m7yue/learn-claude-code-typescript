# 代数效应入门：用前端工程师熟悉的方式理解

很多人第一次看到 Algebraic Effects 会觉得它像一个很学术的词。放到这个项目里，可以先不用管完整的理论定义，只抓住一句话：

```txt
代数效应 = 业务逻辑只声明“我要做什么”，运行时再决定“怎么做”。
```

## 先看普通写法

如果 Agent 想执行一个 shell 命令，最直接的写法是：

```ts
const output = await exec(command);
```

这行代码的问题是：Agent 逻辑和真实副作用绑死了。以后你想加入权限审批、日志、mock、沙盒、重试，都要围着这行代码改。

## 再看效应写法

在这个项目里，Agent 逻辑写成：

```ts
const output = yield* perform({
  type: "BashExec",
  input: { command },
});
```

这里没有直接执行命令，只是声明：

```txt
我需要一个 BashExec 效应。
```

真正怎么处理，由外部 handler 决定：

```ts
const handlers = {
  BashExec: async (effect) => {
    return exec(effect.input.command);
  },
};
```

换一套 handler，同一个 Agent 可以变成：

- 教学模式：返回固定字符串，不真正执行 shell。
- 测试模式：记录调用，断言参数。
- 安全模式：先检查权限，再决定是否执行。
- 真实模式：调用 shell、文件系统、模型 API 或 MCP 工具。

## 和前端里的概念有什么像

如果你写过前端，可以把它类比成这些东西：

| 前端经验 | 代数效应里的相似点 |
| --- | --- |
| 用户点击按钮触发 event | Agent `perform()` 一个 effect |
| reducer 只描述状态如何变 | Agent 只描述下一步意图 |
| middleware 拦截 action | handler / hook 拦截 effect |
| mock service worker 替换网络请求 | 测试 handler 替换真实副作用 |

这个类比不完全等价，但能帮助建立直觉：核心都是把“声明”和“解释”分开。

## 和 React 有什么关系

前端同学其实并不是完全没接触过这种思想。

React 不是一门支持代数效应的语言，React Hooks 也不等于代数效应。但 React 的很多设计会让你提前接触到相似的直觉：组件在 render 阶段更像是在“声明 UI 想要什么”，真正的 DOM 更新、调度、暂停、恢复、effect 执行，都交给 React runtime 解释。

比如：

```tsx
function Profile() {
  const [name, setName] = useState("Ada");

  useEffect(() => {
    document.title = name;
  }, [name]);

  return <h1>{name}</h1>;
}
```

你没有在组件里手动创建和更新 DOM，也没有自己决定 effect 什么时候真正执行。你只是把状态、UI 和副作用描述交给 React，React runtime 负责调度和解释。

Suspense 的直觉也很接近：

```tsx
<Suspense fallback={<Loading />}>
  <Profile />
</Suspense>
```

子树如果“还没准备好”，React 可以暂时切到 fallback，并在条件满足后继续渲染。它不是代数效应的完整实现，但它让前端同学很容易理解一个核心思想：

```txt
业务代码可以声明需要某种能力，外层 runtime 负责接住、解释、恢复。
```

这个项目里的 `yield* perform(effect)` 做的事情也类似：Agent 代码声明“我要读文件 / 执行命令 / 请求权限”，外层 `runAgent()` 和 handler 负责解释。

## 为什么 Agent 特别适合这个模型

Coding Agent 会不断接触真实世界：

- 读文件
- 写文件
- 跑命令
- 创建任务
- 调用子 Agent
- 加载记忆
- 连接 MCP 工具

这些动作都有风险，也都需要被观察、测试和替换。如果 Agent 逻辑里到处直接 `await readFile()`、`await exec()`，系统很快会变得难以控制。

代数效应让我们把所有动作都变成清晰的意图：

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

然后由运行时集中解释这些意图。

## 这个项目里的三个关键词

| 关键词 | 作用 |
| --- | --- |
| Effect | 一段纯数据，描述 Agent 想做什么 |
| Handler | 解释 Effect，执行真实或模拟副作用 |
| runAgent | 驱动 Generator，把 handler 结果送回 Agent |

你可以先把代数效应理解到这个程度，再去读每一章。完整理论可以以后再补；对理解 Agent harness 来说，这个直觉已经足够有用了。
