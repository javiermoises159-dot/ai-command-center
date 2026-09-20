/**
 * A small fixed-window rate limiter.
 *
 * This is not a defence against a determined attacker — it is in-process, so a
 * second server instance has its own counters, and a client behind a changing
 * address gets a fresh window. What it does do is stop one runaway client from
 * saturating the API: a polling loop gone wrong, a retry storm, a script left
 * running overnight.
 *
 * The default ceiling is far above what the app itself needs (its polling adds
 * up to a few dozen requests a minute), so a normal session never sees it.
 * Real authentication and per-account quotas belong in front of this; there is
 * no user model yet, so there is nothing to attribute a quota to.
 */

export interface RateLimitOptions {
  /** Requests allowed per window, per client. */
  max: number;
  windowMs: number;
  /** Injected in tests so the window does not depend on the wall clock. */
  now?: () => number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Requests still available in the current window. */
  remaining: number;
  /** Epoch milliseconds when the current window ends. */
  resetAt: number;
  /** Seconds to wait, for the `Retry-After` header. Only when blocked. */
  retryAfterSeconds: number;
}

interface Window {
  count: number;
  startedAt: number;
}

/** Windows older than this many windows are dropped, so the map cannot grow forever. */
const SWEEP_EVERY = 1_000;

export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly now: () => number;
  private sinceSweep = 0;

  constructor(private readonly options: RateLimitOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Count one request from `key` and say whether it may proceed. */
  check(key: string): RateLimitVerdict {
    const now = this.now();
    this.maybeSweep(now);

    const current = this.windows.get(key);
    const window: Window =
      current === undefined || now - current.startedAt >= this.options.windowMs
        ? { count: 0, startedAt: now }
        : current;

    window.count += 1;
    this.windows.set(key, window);

    const resetAt = window.startedAt + this.options.windowMs;
    const allowed = window.count <= this.options.max;
    return {
      allowed,
      remaining: Math.max(0, this.options.max - window.count),
      resetAt,
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAt - now) / 1000)),
    };
  }

  /** Drop windows that have expired. Amortised: it runs every `SWEEP_EVERY` checks. */
  private maybeSweep(now: number): void {
    this.sinceSweep += 1;
    if (this.sinceSweep < SWEEP_EVERY) return;
    this.sinceSweep = 0;
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= this.options.windowMs) this.windows.delete(key);
    }
  }

  /** Forget every counter. Used by tests and on reconfiguration. */
  reset(): void {
    this.windows.clear();
    this.sinceSweep = 0;
  }
}
