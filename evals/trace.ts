/** 轨迹文件：一行一个 JSON 事件，父进程在子进程结束后读取。 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { TrajectoryEvent } from "./types.ts";

export function appendTrace(path: string, event: TrajectoryEvent): void {
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
}

export function readTrace(path: string): TrajectoryEvent[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const events: TrajectoryEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as TrajectoryEvent);
    } catch {
      // 子进程被杀时最后一行可能不完整；忽略即可，不影响已有事件。
    }
  }
  return events;
}
