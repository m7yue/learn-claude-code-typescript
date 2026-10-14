/**
 * 异步互斥锁 —— 让同一段操作一个接一个地执行，不会同时进行。
 *
 * JS 只有一个线程，本来就谈不上同时修改；但 s14/s15/s16/s17/s20 里有多个
 * 定时器和异步任务（调度器、队列处理器、队友循环）会先后读写同一份数据，
 * 可能互相打断。这个类提供一把「锁」：同一时刻只允许一段代码进入被保护的操作。
 *
 * - acquire()：排队等待，拿到锁后返回一个「放锁」函数
 * - tryAcquire()：不等待；拿到锁就返回放锁函数，否则立即返回 null
 * - withLock()：把一段操作包起来执行，无论成功还是出错都保证放锁
 */

export class Mutex {
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  /** 等待并拿到锁；返回一个「放锁」函数（重复调用也安全）。 */
  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return this.makeReleaser();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.locked = true;
    return this.makeReleaser();
  }

  /** 尝试拿锁；成功返回「放锁」函数，失败立即返回 null。 */
  tryAcquire(): (() => void) | null {
    if (this.locked) return null;
    this.locked = true;
    return this.makeReleaser();
  }

  /** 在锁的保护下运行 fn；无论成功还是出错，最后都会放锁。 */
  async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  get isLocked(): boolean {
    return this.locked;
  }

  private makeReleaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.locked = false;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}
