/**
 * AgentRunner 的正式实现：每个 trial 起一个子进程，父进程只负责超时和读结果。
 *
 * 子进程入口是 evals/agent-child.ts；这里不关心里面用的是真实模型还是脚本模型。
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readTrace } from "./trace.ts";
import type { AgentRunInput, AgentRunResult, AgentRunner } from "./types.ts";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHILD = join(ROOT, "evals", "agent-child.ts");
const MAX_OUTPUT = 8 * 1024 * 1024;

export class HarnessAgentRunner implements AgentRunner {
  async run(input: AgentRunInput): Promise<AgentRunResult> {
    // prompt / result / trace 放在独立的 IO 目录，不写进 workspace：
    // workspace 是 agent 的现场，检查器会按 fixture 比对文件，不能被评测文件污染。
    const runDir = await mkdtemp(join(tmpdir(), "lcc-eval-io-"));
    const promptFile = join(runDir, "prompt.txt");
    const resultFile = join(runDir, "result.json");
    const traceFile = join(runDir, "trace.jsonl");
    await writeFile(promptFile, input.prompt, "utf8");

    const args = [
      "--import",
      "tsx",
      CHILD,
      "--task-id",
      input.task.id,
      "--workspace",
      input.workspace,
      "--outside",
      input.outside,
      "--prompt-file",
      promptFile,
      "--mode",
      input.mode,
      "--result-file",
      resultFile,
      "--trace-file",
      traceFile,
      "--max-turns",
      String(input.maxTurns),
    ];
    if (input.mode === "fake") {
      args.push("--script", input.script ?? "gold");
    }

    // cwd 保持仓库根目录，保证 .env 和 tsx 能解析；
    // 真正的任务现场通过 AGENT_WORKSPACE 传给子进程。
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGENT_WORKSPACE: input.workspace,
    };
    if (input.mode === "fake") {
      // 显式覆盖 .env 里的 real，避免本地配置让自检触网。
      env.AGENT_MODE = "mock";
      env.EVAL_OFFLINE = "1";
    } else {
      env.AGENT_MODE = "real";
    }

    const startedAt = Date.now();
    try {
      await execFileAsync(process.execPath, args, {
        cwd: ROOT,
        timeout: input.timeoutMs,
        maxBuffer: MAX_OUTPUT,
        env,
      });
      const raw = JSON.parse(await readFile(resultFile, "utf8")) as AgentRunResult;
      const trace = readTrace(traceFile);
      return {
        ...raw,
        trace,
        // 延迟按父进程测到的 wall-clock 算，包含子进程启动和 tsx 解析。
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      // 子进程可能在写 result.json 之前就退出；已经落盘的 trace 仍然有用，
      // 检查器可以据此判断失败前发生了什么。
      const trace = readTrace(traceFile);
      const failure = error as {
        killed?: boolean;
        signal?: string;
        code?: number;
        message?: string;
      };
      // execFile 超时会杀掉子进程并置 killed；signal 判断兼容不同平台的报错形状。
      const timedOut = failure.killed === true || failure.signal === "SIGTERM";
      return {
        status: timedOut ? "timeout" : "error",
        finalAnswer: "",
        tokens: input.mode === "fake" ? { input: 0, output: 0 } : null,
        durationMs: Date.now() - startedAt,
        truncated: trace.some(
          (event) => event.type === "model" && event.stopReason === "max_tokens",
        ),
        trace,
        error: failure.message ?? String(error),
      };
    } finally {
      // 默认删除；--keep-io 时保留 prompt.txt / result.json / trace.jsonl，
      // 由调用方打印路径，方便对照一次 trial 的输入、轨迹和结果。
      if (input.keepIo) {
        input.onIoKept?.(runDir);
      } else {
        await rm(runDir, { recursive: true, force: true });
      }
    }
  }
}
