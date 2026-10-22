export interface LimiterOptions {
  maxPerMinute: number;
  maxConcurrent: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Strict sliding-window rate limit (never more than maxPerMinute starts in any 60s window;
 * a plain token bucket would allow a 2x burst across a window boundary) + semaphore (concurrency).
 * acquire() resolves to a release function.
 */
export class RateLimiter {
  private starts: number[] = [];
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly max: number;
  private readonly maxConcurrent: number;

  constructor(o: LimiterOptions) {
    this.max = o.maxPerMinute;
    this.maxConcurrent = o.maxConcurrent;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async acquire(): Promise<() => void> {
    await this.takeSlot();
    try {
      await this.takeToken();
    } catch (e) {
      this.releaseSlot();
      throw e;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseSlot();
    };
  }

  private async takeSlot(): Promise<void> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    // slot ownership was handed over by releaseSlot (inFlight unchanged)
  }

  private releaseSlot(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.inFlight--;
  }

  private async takeToken(): Promise<void> {
    for (;;) {
      const t = this.now();
      while (this.starts.length && this.starts[0]! <= t - 60_000) this.starts.shift();
      if (this.starts.length < this.max) {
        this.starts.push(t);
        return;
      }
      await this.sleep(Math.max(1, this.starts[0]! + 60_000 - t));
    }
  }
}
