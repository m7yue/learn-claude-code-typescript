/**
 * 等待一组并发任务结束 —— 章节的 activeTeammates 注册表直接传进来即可。
 *
 * 超时返回仍在运行的 key；全部结束返回空数组。超时读取的是调用时的注册表，
 * 而不是快照，避免把已经移除的队友误报成“仍在运行”。
 */
export function settleActiveWithin<T>(
  active: ReadonlyMap<string, Promise<T>>,
  timeoutMs: number,
): Promise<string[]> {
  const entries = [...active.entries()];
  if (entries.length === 0) return Promise.resolve([]);

  return new Promise<string[]>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (remaining: string[]): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(remaining);
    };

    timer = setTimeout(() => finish([...active.keys()]), Math.max(0, timeoutMs));
    void Promise.allSettled(entries.map(([, promise]) => promise)).then(() => finish([]));
  });
}
