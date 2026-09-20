/**
 * Circuit breaker for providers.
 *
 * A provider that fails again and again is not a provider worth trying on the
 * next step: every attempt costs time, and on an external provider it can cost
 * money. After `threshold` consecutive failures the breaker opens and the
 * router stops offering that provider until the cooldown expires.
 *
 * The lifecycle is deliberately small:
 *
 *   closed  --(threshold consecutive failures)-->  open
 *   open    --(cooldown expires)-->                on probation (usable again)
 *   probation --(one success)-->                   closed
 *   probation --(one failure)-->                   open again
 *
 * Probation is why an expired cooldown does not reset the counter: a provider
 * that comes back and fails immediately goes straight back out instead of
 * burning another `threshold` attempts. Only a success clears the record.
 *
 * Time comes from an injected `Clock`, never from `Date.now()`, so a caller —
 * and a test — decides what "now" means.
 */

import type { CircuitState } from '../types.ts';
import type { Clock } from '../util.ts';

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker. */
  threshold: number;
  /** How long a tripped provider stays out of rotation. */
  cooldownMs: number;
}

/**
 * The three phases the lifecycle above describes, by their usual names.
 * `half_open` is what this breaker calls probation: the cooldown has expired and
 * the next call is the probe.
 */
export function circuitPhase(state: CircuitState | null): 'closed' | 'open' | 'half_open' {
  if (state === null) return 'closed';
  if (state.open) return 'open';
  return state.probation ? 'half_open' : 'closed';
}

export class CircuitBreaker {
  private readonly byProvider = new Map<string, CircuitState>();
  /** Providers whose cooldown expired since the last `takeHalfOpened()`. */
  private readonly halfOpened = new Set<string>();

  constructor(
    private readonly clock: Clock,
    private readonly options: CircuitBreakerOptions,
  ) {}

  /** A successful call: the provider's record is cleared. */
  recordSuccess(providerId: string): CircuitState {
    const state: CircuitState = {
      providerId,
      consecutiveFailures: 0,
      open: false,
      openedUntil: null,
      lastFailure: null,
      probation: false,
    };
    this.byProvider.set(providerId, state);
    return { ...state };
  }

  /** A failed call: trips the breaker once the threshold is reached. */
  recordFailure(providerId: string): CircuitState {
    const now = this.clock.now();
    const current = this.refresh(providerId, now);
    const consecutiveFailures = (current?.consecutiveFailures ?? 0) + 1;
    const open = consecutiveFailures >= this.options.threshold;
    const state: CircuitState = {
      providerId,
      consecutiveFailures,
      open,
      openedUntil: open ? new Date(now.getTime() + this.options.cooldownMs).toISOString() : null,
      lastFailure: now.toISOString(),
      probation: false,
    };
    this.byProvider.set(providerId, state);
    return { ...state };
  }

  /** True while the provider is out of rotation. Closes the breaker when the cooldown has expired. */
  isOpen(providerId: string): boolean {
    return this.refresh(providerId, this.clock.now())?.open === true;
  }

  /** The provider's current standing, or `null` when it has no record. */
  state(providerId: string): CircuitState | null {
    const state = this.refresh(providerId, this.clock.now());
    return state === undefined ? null : { ...state };
  }

  /** Every provider the breaker has seen, for dashboards and diagnostics. */
  states(): CircuitState[] {
    const now = this.clock.now();
    return [...this.byProvider.keys()]
      .map((id) => this.refresh(id, now))
      .filter((s): s is CircuitState => s !== undefined)
      .map((s) => ({ ...s }))
      .sort((a, b) => a.providerId.localeCompare(b.providerId));
  }

  /**
   * The providers that went from open to half-open (cooldown expired) since the
   * last call, each reported once. The breaker moves lazily — when someone next
   * looks — so this is how the engine learns about the transition to audit it.
   */
  takeHalfOpened(): string[] {
    const taken = [...this.halfOpened];
    this.halfOpened.clear();
    return taken;
  }

  /** Forget everything. Used when the operator reconfigures providers. */
  reset(providerId?: string): void {
    if (providerId === undefined) {
      this.byProvider.clear();
      this.halfOpened.clear();
    } else {
      this.byProvider.delete(providerId);
      this.halfOpened.delete(providerId);
    }
  }

  /**
   * Close an open breaker whose cooldown has passed, leaving the failure count
   * in place so the provider comes back on probation rather than with a clean
   * slate.
   */
  private refresh(providerId: string, now: Date): CircuitState | undefined {
    const state = this.byProvider.get(providerId);
    if (state === undefined) return undefined;
    if (state.open && state.openedUntil !== null && Date.parse(state.openedUntil) <= now.getTime()) {
      const reopened: CircuitState = {
        ...state,
        open: false,
        openedUntil: null,
        consecutiveFailures: Math.max(0, this.options.threshold - 1),
        probation: true,
      };
      this.byProvider.set(providerId, reopened);
      this.halfOpened.add(providerId);
      return reopened;
    }
    return state;
  }
}
