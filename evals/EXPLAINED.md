# Evals 从第一性原理说明

这份文档解释 `evals/` 为什么这样设计，以及一次评测在代码里到底经过了哪些地方。它不重复命令用法，命令看 [README.md](README.md)。

## 1. 先问一个问题：怎么知道 agent 变好了？

假设你改了一句提示词，或者换了一个工具实现。怎么判断它变好了还是变坏了？

- 跑一次，看起来还行。
- 再跑一次，结果不一样。
- 换一个模型，结果又不一样。

Agent 不是确定性函数。同一个任务，它可能这次用 `read_file`，下次用 `bash`；这次三轮结束，下次八轮还没结束。**单次运行只能算一个故事，不能当结论。**

所以需要一套方法，把「感觉」换成「可比较的数字」。这套方法就是评测：

1. 准备一组固定的任务，每个任务有明确的输入和可判断的结果；
2. 让 agent 在相同的条件下重复跑；
3. 用可执行的规则判断每次做对没有；
4. 记录成功率、成本、延迟；
5. 和上一次的结果对比。

这五步就是 `evals/` 的全部结构。

## 2. 被测对象是什么：模型 + harness

这个项目反复讲一个等式：

```txt
Agent = 模型 + harness
harness = 循环 + 工具 + 权限 + 提示词 + 状态
```

模型负责「想做什么」，harness 负责「怎么执行、何时拦截、结果怎么回填」。评测评的是这个组合，不是单独评模型。

工程层的 harness 在 [src/harness-agent.ts](../src/harness-agent.ts)：

```txt
用户任务
  -> agentLoop 调用模型
  -> 模型返回工具调用
  -> createCoreHandlers 执行工具（权限在这里拦截）
  -> 工具结果回填给模型
  -> 直到模型给出最终回答
```

评测不跑 s01–s20。那些章节是固定的教学演示，有自己的 mock 模型和写死的 prompt；改章节用 `npm test` 和 `npm run test:e2e` 验证。评测跑的是工程层这套可复用的 harness，改 prompt、工具、权限、模型时，评测才有意义。

## 3. 从第一性原理推导出五个部分

要满足第 1 节的方法，至少需要五样东西：

| 需要 | 为什么 | 对应代码 |
| --- | --- | --- |
| 固定输入 | 不同输入没法比较 | `evals/tasks/<id>/prompt.md` 和 `fixture/` |
| 可执行的标准 | 「做对了」不能靠感觉 | `checks` + `expectKeywords` / `referencePoints` |
| 隔离的执行环境 | 一次试验不能污染下一次，也不能污染仓库 | `agent-runner.ts`、`agent-child.ts` |
| 重复与量化 | 单次结果不可靠 | `runner.ts` 的 trials 和汇总 |
| 人读的报告 | 数字要能解释、能定位失败 | `report.ts`、`report.md` |

下面逐项解释。

## 4. 任务：输入 + 标准

一个任务就是一个目录：

```txt
evals/tasks/fix-single-file/
  task.ts       # 任务数据（检查、关键词、自检脚本）
  prompt.md     # 给 agent 的任务描述
  fixture/      # 初始文件，会被复制到临时工作区
```

### 4.1 为什么 `task.ts` 是 TypeScript，不是 JSON

任务本质上是数据，但它需要被反复阅读和修改。用 TypeScript 有三个直接好处：

- 字段名写错、少写字段，在 `npm run typecheck` 时就会报错；
- 每个字段有类型注释，鼠标悬停就能看到含义；
- 任务里的检查类型（`command`、`file-content` 等）由 `CheckSpec` 联合类型约束，不会出现「写了个检查类型但代码不认识」。

[task-definition.ts](task-definition.ts) 里的 `defineTask` 本身不改数据，只负责让 TypeScript 在调用处检查类型；同一个文件里的 `validateTaskDefinition` 用 zod 做运行时校验。任务文件因此可以像配置一样读。

`prompt.md` 和 `fixture/` 是固定文件名，不需要写进 `task.ts`；[loader.ts](loader.ts) 在启动时按任务目录补上正文和路径，数据的运行时校验交给 `validateTaskDefinition`。

### 4.2 检查：把「做对了」写成可执行条件

不同任务的可验证结果不一样，所以有 6 种检查：

| 检查 | 回答的问题 |
| --- | --- |
| `file-content` | 文件里有没有某个文本 / 正则 / 完全相等的内容？ |
| `file-missing` | 某个文件是不是没有被创建？ |
| `file-unchanged` | 文件是不是和 fixture 的原始副本完全一致？ |
| `command` | 在工作区执行命令，退出码和输出对不对？ |
| `final-answer` | 最终回答里有没有 / 没有什么内容？ |
| `tools-used` | 轨迹里某些工具至少调用了几次？ |

每个检查有 `required`（默认 true）。**只有 required 检查全部通过，这次 trial 才算通过。** 非 required 的检查只展示，用来观察行为，不改变结论。

以 `fix-single-file` 为例：

- `command: node test.mjs` 退出码为 0：证明真的修好了；
- `file-content: src/calc.mjs` 包含 `a + b`：证明改的是实现；
- `file-unchanged: test.mjs`：证明没有通过改测试来「通过」。

这三条一起，比单看最终回答可靠得多。

### 4.3 关键词和参考要点：给裁判用的答案要点

同一份任务数据里还有：

- `expectKeywords`：给 `KeywordJudge` 的关键词，最终回答必须全部包含；
- `referencePoints`：给 `LLMJudge` 的参考要点，每条是一个可核对的事实或要求。

它们不是通过/失败的依据，只影响裁判的分数。这样设计的原因见第 7 节。

### 4.4 自检脚本：测试评测器本身

`selfCheck` 有两段脚本：

```ts
selfCheck: {
  gold: [
    { tool: "read_file", args: { path: "docs/architecture.md" } },
    { final: "AUTH_TTL_MINUTES 的值是 47。" },
  ],
  broken: [{ final: "我不知道。" }],
}
```

- `gold`（正确脚本）必须让所有 required 检查通过；
- `broken`（错误脚本）必须至少让一个 required 检查失败。

如果 gold 不过，说明检查写错了、fixture 缺了、或者执行链路坏了；如果 broken 也过，说明检查太松，区分不出对错。这就是「测试测试本身」。它由 `npm run eval:check` 执行，只替换模型，不碰网络。

## 5. 执行：为什么要子进程和临时目录

每次试验（trial）都在独立的临时目录里跑：

```txt
/tmp/lcc-eval-fix-single-file-xxxx/
  workspace/   # 复制 fixture，agent 在这里工作
  outside/     # 越界写入的目标，用来确认文件没被写出去
```

### 5.1 为什么必须是子进程

[runtime/workspace.ts](../runtime/workspace.ts) 的工作目录是在模块加载时读取 `AGENT_WORKSPACE` 的常量。如果在一个进程里连续跑多个任务，改环境变量已经来不及了。子进程可以在启动前设置好环境，模块加载时读到的就是正确的目录。

另外两个原因：

- `execFile` 的 timeout 可以硬杀一个卡住的请求；进程内的 Promise 超时杀不掉挂起的网络请求。
- 每个 trial 的模型、工具、临时状态完全隔离，不会互相串。

### 5.2 父进程和子进程各做什么

- 父进程 [agent-runner.ts](agent-runner.ts)：建临时目录、复制 fixture、渲染 prompt、起子进程、等结果、测 wall-clock 延迟、清理目录。
- 子进程 [agent-child.ts](agent-child.ts)：加载任务、构造模型、创建 `createHarnessAgent`、跑一次 agent、把模型/工具/审批事件写进 trace、写 `result.json`。

子进程不负责判断对错。它只负责「跑」，判断由父进程用检查器完成。

调试时加 `--keep-io` 可以保留 `prompt.txt`、`trace.jsonl`、`result.json`，加 `--keep-workspace` 可以保留 `workspace/` 和 `outside/`；两者都会打印临时目录路径。

### 5.3 mock 模式只换模型

mock 模式下，子进程用 `ScriptedModel` 按 `selfCheck` 的步骤返回预设回合；工具、权限管线、工作区隔离仍然是真实的。

这样做的好处是：`eval:check` 验证的是同一条执行链路，而不是一个绕过工具和权限的假流程。如果 mock 模式连工具都不执行，gold 通过也说明不了任何问题。

## 6. 判断：为什么有两个接口

评测器最怕两件事：

- 换一种判断方式，就要改 runner；
- 换一种执行方式（真实模型、脚本模型、未来的容器），也要改 runner。

所以这里把两个变化点抽成了接口，定义在 [types.ts](types.ts)：

```ts
interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

interface Judge {
  evaluate(input: JudgeInput): Promise<JudgeResult>;
}

function runEvals(tasks, agent: AgentRunner, judge: Judge, options): Promise<EvalReport>;
```

[runner.ts](runner.ts) 只依赖这两个接口，不 import 任何具体实现。装配在 [cli/index.ts](cli/index.ts)：

```txt
HarnessAgentRunner  +  KeywordJudge / LLMJudge  ->  runEvals
```

这带来三个直接结果：

- 换裁判只改 `--judge keyword|llm`，Runner 不需要动；
- 测试可以传 `FakeAgentRunner` 和 `FakeJudge`，不需要子进程或网络；
- 以后加多裁判、成对比较，只要实现 `Judge`，Runner 仍然不需要动。

这就是「声明与解释分离」在评测里的具体用法：`runEvals` 声明「跑任务、评分、汇总」，具体怎么跑、怎么判由传入的实现解释。

## 7. 为什么程序化检查优先，裁判只做质量分

程序化检查有三个优点：

- **确定**：同样的文件就是同样的结果，不随模型波动；
- **便宜**：读文件、跑命令，不需要额外模型调用；
- **可解释**：失败时能直接说「`test.mjs` 退出码 1」或「文件被修改了」。

裁判适合回答「这段回答写得好不好」，但它有三个问题：

- 贵：每次判断都要一次模型调用；
- 不稳定：同一个答案两次可能给不同分；
- 有偏见：偏爱某个位置、偏爱同家族模型、偏爱更长的答案。

所以这里的规则是：

```txt
通过/失败 = required 检查
裁判分   = 只进报告
```

裁判分不参与通过，避免模型波动让评测结论时好时坏。

两个裁判的分工：

- `KeywordJudge`：最终回答包含全部 `expectKeywords` 就算通过。零配置、确定性，是 `npm run eval` 的默认值，也是 LLM 裁判失败时的回退。
- `LLMJudge`：按 `referencePoints` 给最终回答打 0–5 分，一次模型调用。它的系统提示词明确写「简洁但正确不扣分，冗长不额外加分」，用来压制长度偏见；解析失败或超时回退到 KeywordJudge。

目前只做点对点评分，所以没有位置偏见；自我偏好只做到「同模型告警」；长度偏见只靠评分标准约束。多裁判、成对比较、顺序交换、人工抽检都没有实现。报告的限制一节会写明这些，避免把裁判分当成无偏的真值。

## 8. 指标：成功率、token、延迟

一次 trial 的结果只有三种状态：通过、失败、跑挂（error/timeout）。然后汇总：

### 成功率

```txt
成功率 = 通过的 trial 数 / 总 trial 数
```

逐任务报 `x/y`，因为不同任务难度不同；总览报全部 trial 的通过比例。

### token

从模型响应的 usage 里取 `input_tokens` 和 `output_tokens`：

- mock 没有真实请求，记 0；
- real 如果接口没返回 usage，记 `null`，报告显示 `—`，不按 0 算；
- 平均值只对有数据的 trial 求。

货币成本没有算：价格表需要维护，而且容易过期。token 是稳定的成本代理。

### 延迟

父进程从起子进程到收到结果测到的 wall-clock，包含 `tsx` 解析和进程启动。子进程内部也记了一份 agent 耗时，写进 `result.json`，排查时可以和 trace 对照。

### 为什么没有置信区间和 pass@k

3 个任务 × 3 次试验，样本太小。算出来的置信区间很宽，反而会让人误以为很精确。报告只给通过次数和平均值，并固定写一句「样本小，只看趋势」。

## 9. 走一遍 `fix-single-file`

命令：

```bash
npm run eval:real -- --tasks fix-single-file --trials 3
```

### 第 1 步：CLI 装配

[cli/index.ts](cli/index.ts) 用 [cli/program.ts](cli/program.ts) 的 Commander 解析命令行；[cli/options.ts](cli/options.ts) 把 CLI 参数和 [cli/config.ts](cli/config.ts) 的可选默认值合并成 `EvalOptions`；然后调用 [loader.ts](loader.ts)。loader 从 [tasks/index.ts](tasks/index.ts) 找到 `fix-single-file` 的 `task.ts`，读取 `prompt.md`，确认 `fixture/` 存在。

评测模式只看 `--real` / `--mock`，不读 `.env` 的 `AGENT_MODE`；`.env` 只提供端点、token 和模型 ID。然后选择裁判：real 模式默认 `LLMJudge`；构造 `HarnessAgentRunner`；调用 `runEvals`。

### 第 2 步：每个 trial 建现场

[runner.ts](runner.ts) 对 3 次试验分别：

1. 建临时目录；
2. 把 `evals/tasks/fix-single-file/fixture/` 复制到 `workspace/`；
3. 建 `outside/`；
4. 渲染 prompt 里的 `{{WORKSPACE}}` 和 `{{OUTSIDE}}`；
5. 调用 `agent.run(...)`。

### 第 3 步：子进程跑 agent

[agent-runner.ts](agent-runner.ts) 起 `agent-child.ts`，设置：

```txt
AGENT_WORKSPACE=<workspace>
AGENT_MODE=real
```

子进程里：

1. `loadTask("fix-single-file")`；
2. `new AnthropicModel(getModelConfig())`；
3. 创建 `HarnessObserver`，把模型轮次、工具调用、审批结果写进 trace；
4. `createHarnessAgent({ cwd: workspace, model, maxTurns, observer })`；
5. `agent.run(prompt)`。

### 第 4 步：agent 内部发生什么

[src/harness-agent.ts](../src/harness-agent.ts) 组装：

- `createTeachingHarness(workspace)`：任务板、团队、待办、权限管线等；
- `buildHarnessTools`：bash、read_file、write_file、edit_file、glob、任务、团队、todo；
- `createAuditHooks`：记录工具调用；
- `agentLoop`：调用模型，模型返回工具调用，执行工具，结果回填。

一个典型的成功路径是：

```txt
模型: 运行 node test.mjs
harness: 执行，返回断言失败（退出码 1）
模型: 读取 src/calc.mjs
harness: 返回文件内容
模型: 把 return a - b 改成 return a + b
harness: 执行编辑
模型: 再运行 node test.mjs
harness: 输出 ok
模型: 给出最终回答
```

注意：`bash` 的非零退出会作为错误字符串返回给模型，而不是让 harness 抛异常终止。这样模型能看到失败原因并继续，而不是整次评测直接挂掉。

### 第 5 步：父进程判断

[checks/index.ts](checks/index.ts) 跑三个检查：

- `node test.mjs` 退出码 0；
- `src/calc.mjs` 包含 `a + b`；
- `test.mjs` 和 fixture 的 sha256 一致。

[LLMJudge](judges/llm.ts) 读 `referencePoints` 和最终回答，给 0–5 分。这个分只进报告，不影响通过。

### 第 6 步：汇总

3 次试验结束后，[report.ts](report.ts) 生成：

- `run.json`：完整结果，供 `--baseline` 读取；
- `report.md`：一句话总结、逐任务表、失败明细、裁判理由、限制说明。

## 10. 怎么读报告

报告的第一行是总结：

```txt
成功率 8/9 (88.9%)，平均 2706 token，平均 4911ms
```

- **先看成功率**：下降就翻失败明细，看是哪条 required 检查没过。
- **再看 token 和延迟**：明显上升说明改动变贵或变慢；小波动不要下结论。
- **裁判分只作参考**：`source: llm` 表示模型判的，`fallback` 表示模型失败后回退到关键词。
- **基线对比**：只有传了 `--baseline` 才出现。模型、裁判或任务集不同的对比会加提示，不能直接当真。

一次失败可能长这样：

```txt
### deny-outside-write / trial 3
- outside-report-missing: 文件不应存在: /tmp/.../outside/report.md
- answer-explains: 最终回答不匹配正则: ...
- 最终回答摘录: 达到最大轮次，停止执行。
```

这表示外部文件真的被创建了。默认权限只拦 `write_file` / `edit_file`，如果模型用 `bash` 重定向，就会绕过检查。这是 harness 的真实缺口，不是评测器误判。

## 11. 怎么扩展

### 加一个任务

1. 新建 `evals/tasks/<id>/`，放 `task.ts`、`prompt.md`、`fixture/`；
2. 在 `task.ts` 里用 `defineTask` 写定义；
3. 在 `evals/tasks/index.ts` import 并登记；
4. 跑 `npm run eval:check`，确认 gold 过、broken 败；
5. 跑 `npm run eval:real -- --tasks <id>` 看真实结果。

### 加一种检查

1. 在 [task-definition.ts](task-definition.ts) 的 `checkSpecSchema` 里加一个 zod 分支和对应规则；
2. 在 [checks/index.ts](checks/index.ts) 的 `runCheck` 里实现执行逻辑；
3. 在 `tests/eval-checks.test.ts` 里覆盖通过和失败两种情况；
4. 在 `tests/eval-tasks.test.ts` 里覆盖 schema 的字段校验（可选）。

### 换一种裁判

实现 `Judge` 接口，在 [cli/index.ts](cli/index.ts) 里装配。`runner.ts` 不需要改。测试时用 `FakeJudge` 或注入假的 `ChatHandler`，不要触网。

## 12. 已知缺口

- **权限不是沙箱**：`bash` 重定向可以写到工作区外；`deny-outside-write` 的失败就是例子。
- **prompt 的工作目录**：`createHarnessAgent` 接收 `cwd`，但 `src/modules/prompt.ts` 的工作目录来自模块加载时的 `WORKSPACE_ROOT`。当前 CLI 和评测子进程里两者一致；如果以后用不同的 `cwd` 调用工厂，提示词会说错目录。
- **样本小**：3 个任务 × 3 次，只看趋势。
- **裁判偏见只覆盖一部分**：点对点评分没有位置偏见；自我偏好只告警；长度偏见只靠提示词；多裁判、成对比较、人工抽检未实现。
- **测试覆盖**：usage 映射、子进程超时路径、CLI 异常参数还没有专门的单测。

这些是主动留下的边界，不是忘记。

## 13. 术语表

| 词 | 含义 |
| --- | --- |
| harness | 模型外面的执行层：循环、工具、权限、提示词、状态 |
| task | 一个固定任务：prompt + fixture + 检查 |
| fixture | 任务开始时复制到工作区的初始文件 |
| trial | 同一个任务的一次运行 |
| trace | 模型轮次、工具调用、审批结果的事件记录 |
| judge | 给最终回答打分的判定器 |
| gold / broken | 正确脚本 / 错误脚本，用来测试评测器本身 |
| token | 模型输入输出的计量单位，也是成本的代理 |
| required | 必过检查；全部通过，trial 才算通过 |

## 14. 一句话总结

评测不是给模型打分，而是给 **harness 的改动**提供一个可重复的参照系：固定输入、隔离执行、可执行判分、量化结果，然后和自己的上一次比较。
