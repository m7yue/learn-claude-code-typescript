/**
 * 后台任务注册表与通知格式 —— 全仓单一实现（s13 / s20 共用）。
 *
 * 启动后台任务后立即返回 bg id；任务在独立的 Promise 里执行，结果写回注册表
 * 和 `.task_outputs/bg_xxxx.log`。收集时输出真实 CC 的 `<task-notification>`：
 * task-id / task-type / status / summary / output-file。
 *
 * 执行器与日志由调用方注入：s13 用自己的模拟 executeTool，s20 用本章的模拟执行器；
 * 两边保留各自的日志文案。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ToolUseBlock } from './types.ts';

export interface BackgroundTaskRecord {
  toolUseId: string;
  command: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  finishedAt?: number;
  /** 完整输出的文件路径；写文件失败时为空。 */
  outputFile?: string;
}

export type BackgroundLogEvent = 'start' | 'done' | 'failed';

export interface BackgroundRegistryOptions {
  /** 真正执行一个工具调用；抛错会被记录为 failed。 */
  executor: (block: ToolUseBlock) => Promise<string>;
  /** 输出文件目录（通常是工作区的 .task_outputs）。 */
  outputDir: string;
  /** 章节自己的日志；不传则只在失败时输出一条。 */
  log?: (event: BackgroundLogEvent, bgId: string, task: BackgroundTaskRecord, output: string) => void;
  /** waitForAll 的默认超时。 */
  waitTimeoutMs?: number;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 把后台任务的完整输出写到工作区；写失败只记日志，不影响任务状态。 */
export function writeBackgroundOutput(
  bgId: string,
  output: string,
  outputDir: string,
): string | undefined {
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    const file = path.join(outputDir, `${bgId}.log`);
    fs.writeFileSync(file, output, 'utf8');
    return file;
  } catch (error) {
    console.log(
      `  [background output error] ${bgId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/** 把一条已完成任务转成真实 CC 的 task-notification 文本。 */
export function buildTaskNotification(bgId: string, task: BackgroundTaskRecord, output: string): string {
  const summary = output.length > 200 ? output.slice(0, 200) : output;
  const outputFile = task.outputFile
    ? `  <output-file>${escapeXml(task.outputFile)}</output-file>\n`
    : '';
  return (
    `<task-notification>\n` +
    `  <task-id>${bgId}</task-id>\n` +
    `  <task-type>local_bash</task-type>\n` +
    `  <status>${task.status}</status>\n` +
    `  <summary>${escapeXml(summary)}</summary>\n` +
    outputFile +
    `</task-notification>`
  );
}

/**
 * 后台任务注册表。start 立即返回 bg id；collect 收取已完成任务并删除记录。
 */
export class BackgroundRegistry {
  private counter = 0;
  private readonly backgroundTasks = new Map<string, BackgroundTaskRecord>();
  private readonly backgroundResults = new Map<string, string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly options: BackgroundRegistryOptions;

  constructor(options: BackgroundRegistryOptions) {
    this.options = options;
  }

  /** 启动一个后台任务，立即返回 bg id。 */
  start(block: ToolUseBlock): string {
    this.counter += 1;
    const bgId = `bg_${String(this.counter).padStart(4, '0')}`;
    const command =
      typeof block.input['command'] === 'string' ? block.input['command'] : block.name;

    const task: BackgroundTaskRecord = {
      toolUseId: block.id,
      command,
      status: 'running',
      startedAt: Date.now(),
    };
    this.backgroundTasks.set(bgId, task);

    // 不等它：主循环拿到 bgId 后立刻继续，后台那段代码稍后把结果写回来。
    const job = (async () => {
      try {
        const output = await this.options.executor(block);
        this.backgroundResults.set(bgId, output);
        task.outputFile = writeBackgroundOutput(bgId, output, this.options.outputDir);
        task.status = 'completed';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const output = `Error: ${message}`;
        this.backgroundResults.set(bgId, output);
        task.outputFile = writeBackgroundOutput(bgId, output, this.options.outputDir);
        task.status = 'failed';
        this.options.log?.('failed', bgId, task, output);
      } finally {
        task.finishedAt = Date.now();
      }
    })();
    this.pending.add(job);
    void job.then(
      () => this.pending.delete(job),
      () => this.pending.delete(job),
    );

    this.options.log?.('start', bgId, task, '');
    return bgId;
  }

  /** 等完在途任务；超时后放弃剩余任务，避免结束回合时无限等待。 */
  async waitForAll(timeoutMs = this.options.waitTimeoutMs ?? 5_000): Promise<void> {
    if (this.pending.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([Promise.allSettled([...this.pending]), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** 收集已完成（completed/failed）的任务；wait=true 时先等在途任务。 */
  async collect(wait = false): Promise<string[]> {
    if (wait) await this.waitForAll();

    const readyIds = [...this.backgroundTasks.entries()]
      .filter(([, task]) => task.status !== 'running')
      .map(([bgId]) => bgId);

    const notifications: string[] = [];
    for (const bgId of readyIds) {
      const task = this.backgroundTasks.get(bgId)!;
      const output = this.backgroundResults.get(bgId) ?? '';
      this.backgroundTasks.delete(bgId);
      this.backgroundResults.delete(bgId);

      notifications.push(buildTaskNotification(bgId, task, output));
      const label = task.status === 'completed' ? 'done' : 'failed';
      this.options.log?.(label, bgId, task, output);
    }
    return notifications;
  }
}
