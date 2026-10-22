/** Webhook-signal queue. Implementations must coalesce repeated signals per customer. */
export interface SyncQueue {
  enqueueSync(zohoCustomerId: string): Promise<void>;
  close(): Promise<void>;
}
export type SyncHandler = (zohoCustomerId: string) => Promise<unknown>;

export interface InMemoryQueueOptions {
  debounceMs?: number; // default 30s
  onError?: (customerId: string, e: unknown) => void;
}

/**
 * In-process debounce: the first signal for a customer arms a timer; further signals inside the
 * window are coalesced into it. A signal arriving while the sync runs schedules exactly one more run.
 */
export class InMemorySyncQueue implements SyncQueue {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Set<string>();
  private rerun = new Set<string>();
  private inflight = new Set<Promise<void>>();
  private closed = false;
  private debounceMs: number;
  constructor(private handler: SyncHandler, private opts: InMemoryQueueOptions = {}) {
    this.debounceMs = opts.debounceMs ?? 30_000;
  }

  async enqueueSync(id: string): Promise<void> {
    if (this.closed) return;
    if (this.running.has(id)) { this.rerun.add(id); return; }
    if (this.timers.has(id)) return; // coalesced
    const t = setTimeout(() => { this.timers.delete(id); this.run(id); }, this.debounceMs);
    t.unref?.();
    this.timers.set(id, t);
  }

  pending(): number { return this.timers.size; }

  private run(id: string): void {
    this.running.add(id);
    const p = (async () => {
      try { await this.handler(id); } catch (e) { this.opts.onError?.(id, e); }
      finally {
        this.running.delete(id);
        if (this.rerun.delete(id) && !this.closed) void this.enqueueSync(id);
      }
    })();
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  /** Cancels pending timers and waits for running syncs. */
  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await Promise.allSettled([...this.inflight]);
  }
}
