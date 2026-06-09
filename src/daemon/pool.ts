// src/pool.ts
//
// Warm-TUI pool for the daemon. Holds pre-started, idle-at-the-prompt TUIs keyed
// by signature so a repeated request can skip the ~659ms spawn→ready. Pure
// bookkeeping: kill() is injected per entry, so this is unit-testable without a
// real pty. The daemon owns spawning/refilling; the pool owns membership,
// expiry, and the global cap.

export interface Warm<T = unknown> {
  sig: string;
  sessionId: string;
  /** now() value at warm time; used for TTL expiry. */
  bornAt: number;
  /** Terminate this warm TUI's process tree. */
  kill: () => void;
  /** The held payload (the driver Session in production). */
  value: T;
}

export interface WarmPoolOptions {
  /** Hard cap on TOTAL warm TUIs across all signatures (RAM bound). */
  max: number;
  /** A warm TUI older than this is considered stale and discarded. */
  ttlMs: number;
  now: () => number;
}

export class WarmPool<T = unknown> {
  private readonly bySig = new Map<string, Warm<T>[]>();
  constructor(private readonly opts: WarmPoolOptions) {}

  /** Total warm TUIs across all signatures. */
  size(): number {
    let n = 0;
    for (const arr of this.bySig.values()) n += arr.length;
    return n;
  }

  /** Warm TUIs currently held for one signature. */
  countFor(sig: string): number {
    return this.bySig.get(sig)?.length ?? 0;
  }

  /** Add a warm TUI; evict the oldest if this pushes total over `max`. */
  add(w: Warm<T>): void {
    const arr = this.bySig.get(w.sig);
    if (arr) arr.push(w);
    else this.bySig.set(w.sig, [w]);
    while (this.size() > this.opts.max) this.evictOldest();
  }

  /** Take a non-expired warm TUI for `sig`, or null. Expired ones are killed. */
  take(sig: string): Warm<T> | null {
    this.evictExpired();
    const arr = this.bySig.get(sig);
    if (!arr || arr.length === 0) return null;
    const w = arr.shift()!;
    if (arr.length === 0) this.bySig.delete(sig);
    return w;
  }

  /** Drop + kill every entry older than the TTL. */
  evictExpired(): void {
    const cutoff = this.opts.now() - this.opts.ttlMs;
    for (const [sig, arr] of this.bySig) {
      const live = arr.filter((w) => {
        if (w.bornAt <= cutoff) {
          w.kill();
          return false;
        }
        return true;
      });
      if (live.length) this.bySig.set(sig, live);
      else this.bySig.delete(sig);
    }
  }

  /** Kill + drop every warm TUI. */
  clear(): void {
    for (const arr of this.bySig.values()) for (const w of arr) w.kill();
    this.bySig.clear();
  }

  private evictOldest(): void {
    let oldest: Warm<T> | undefined;
    let oldestSig: string | undefined;
    for (const [sig, arr] of this.bySig) {
      for (const w of arr) {
        if (!oldest || w.bornAt < oldest.bornAt) {
          oldest = w;
          oldestSig = sig;
        }
      }
    }
    if (!oldest || oldestSig === undefined) return;
    oldest.kill();
    const arr = this.bySig.get(oldestSig)!.filter((w) => w !== oldest);
    if (arr.length) this.bySig.set(oldestSig, arr);
    else this.bySig.delete(oldestSig);
  }
}
