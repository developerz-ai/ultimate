// The named risk, mitigated in code. A deploy drops N sockets at once; if every client reconnects
// immediately the rolling restart becomes a self-inflicted outage that outlasts the deploy.
//
// Three mechanisms, in the order they fire:
//   1. drainPlan()    — the draining node assigns each client a distinct delay slot before closing
//   2. policyDelay()  — the client's own jittered retry, for failures nobody scheduled
//   3. AcceptBudget   — the receiving node's token bucket, so recovery sheds instead of collapsing

import {
  backoffDelay,
  type Clock,
  finiteOption,
  type JitterMode,
  type Random,
  systemClock,
} from '@ultimat3/core/page';
import { type Frame, PROTOCOL_VERSION } from './sync-protocol';

/** Injected so tests are deterministic and `local` mutators stay replayable. */
export type Rng = Random;

/** Core's, re-exported under this package's name — never a second copy of the same three modes. */
export type { JitterMode };

export interface BackoffPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly factor: number;
  readonly jitter: JitterMode;
}

/**
 * `full` jitter by default: it is the only mode that actually decorrelates a herd. `equal` keeps a
 * floor for latency-sensitive clients; `none` exists for tests and is never a production choice.
 */
export const defaultBackoff: BackoffPolicy = {
  baseMs: 500,
  maxMs: 30_000,
  factor: 2,
  jitter: 'full',
};

/** The longest a browser waits between two dials, whatever the attempt. */
export const BROWSER_RECONNECT_MAX_MS = 4_000;

/**
 * A browser's redial: the same curve, capped at seconds rather than `defaultBackoff`'s thirty.
 * Measured after a deploy — six dials in ~3s, then a full-jitter roll under a 30s cap left the
 * node that came back (and the `update-available` it had for the tab) unreached for 27s. `equal`
 * jitter, because at the cap it keeps a floor: a SIGKILLed node's herd redials inside a 2-4s
 * window rather than at once, and the `AcceptBudget` sheds the excess before any query runs. A
 * PLANNED restart never reaches this: the drain's `reconnect` frame assigns each socket its slot.
 */
export const browserBackoff: BackoffPolicy = {
  baseMs: 500,
  maxMs: BROWSER_RECONNECT_MAX_MS,
  factor: 2,
  jitter: 'equal',
};

/**
 * A {@link BackoffPolicy} mapped onto `@ultimat3/core`'s `backoffDelay` — the one curve. Attempt is
 * 1-BASED, core's count: the wait after the first failure is `attempt: 1` and is `baseMs`.
 *
 * Internal to this package and never re-exported from the barrel. Until 22.0.0 `.` exported a
 * 0-based `backoffDelay` of its own that shifted by one before delegating, which made two counting
 * conventions under one name — and a caller that passed a 1-based count to it (the channel
 * catch-up retry did) waited twice as long as it meant to, with no error anywhere.
 */
export function policyDelay(
  policy: BackoffPolicy,
  attempt: number,
  rng: Rng = Math.random,
): number {
  return backoffDelay({
    attempt,
    base: policy.baseMs,
    max: policy.maxMs,
    factor: policy.factor,
    curve: 'exponential',
    jitter: policy.jitter,
    random: rng,
  });
}

/**
 * The timer half of mechanism 2. Returns its own canceller rather than a handle, so nothing has to
 * name a type that differs between Bun, the browser and `node:timers`. Injected because a reconnect
 * only provable by sleeping is a reconnect no test proves — and an unproven one silently did not
 * fire at all until `As of 2026-08`.
 */
export type Scheduler = (fn: () => void, ms: number) => () => void;

/** The production scheduler: the one `setTimeout` on the client's reconnect path. */
export const timeoutScheduler: Scheduler = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  return () => {
    clearTimeout(handle);
  };
};

export type ReconnectReason = 'drain' | 'overload' | 'rebalance';

export interface DrainPlanEntry {
  readonly socketId: string;
  readonly afterMs: number;
}

/**
 * A plan entry and what became of it — what `SyncNode.drain` returns. `notified: false` means
 * backpressure dropped that socket's `reconnect` frame: the frame is what carries the slot, nothing
 * re-sends it, so that client reconnects on its own backoff and the count is the only place a log
 * can say how much of the spread actually shipped.
 */
export interface DrainedSocket extends DrainPlanEntry {
  readonly notified: boolean;
}

export interface DrainPlanOptions {
  /** Window across which reconnects are spread. Must exceed the node's own drain grace period. */
  readonly spreadMs?: number;
  readonly rng?: Rng;
}

/**
 * Slot assignment, not pure randomness: socket *i* of *n* is placed in its own `spreadMs/n` slot and
 * jittered inside it. Pure randomness clusters; slots guarantee a uniform spread even for small n,
 * which is what makes clients redistribute across the surviving nodes instead of all landing on one.
 */
export function drainPlan(
  socketIds: readonly string[],
  options: DrainPlanOptions = {},
): DrainPlanEntry[] {
  const spreadMs = finiteOption('drainPlan', 'spreadMs', options.spreadMs ?? 30_000);
  const rng = options.rng ?? Math.random;
  const total = socketIds.length;
  if (total === 0) return [];
  const slot = spreadMs / total;
  return socketIds.map((socketId, index) => ({
    socketId,
    afterMs: Math.round(index * slot + rng() * slot),
  }));
}

export function reconnectFrame(afterMs: number, reason: ReconnectReason): Frame {
  return { type: 'reconnect', v: PROTOCOL_VERSION, afterMs, reason };
}

export interface AcceptBudgetOptions {
  /** Sustained accepts per second per node during recovery. */
  readonly perSecond: number;
  /** Burst allowance, so a normal reconnect trickle is never delayed. */
  readonly burst?: number;
  readonly clock?: Clock;
}

/**
 * Token bucket on the accept path. A node that cannot afford a new socket must say so with a
 * `reconnect` frame carrying a delay — refusing without a delay just moves the herd next door.
 */
export class AcceptBudget {
  readonly #perSecond: number;
  readonly #burst: number;
  readonly #clock: Clock;
  #tokens: number;
  #lastRefill: number;

  constructor(options: AcceptBudgetOptions) {
    // `Math.max(1, …)` is a CLAMP, not a validator, and it propagates every non-finite value it is
    // handed. Measured: `perSecond: NaN` makes `#tokens` NaN, `tryAccept` asks `#tokens < 1`,
    // `NaN < 1` is false — so the bucket admits every accept, forever, and `retryAfterMs()`
    // answers NaN, which `JSON.stringify` writes into the `reconnect` frame as `null`. `Infinity`
    // is the same failure spelled differently: a budget that never refuses is not a budget. A
    // finite clamp is monotone and safe, so 0 and negatives keep their floor of 1.
    finiteOption('AcceptBudget', 'perSecond', options.perSecond);
    finiteOption('AcceptBudget', 'burst', options.burst ?? options.perSecond);
    this.#perSecond = Math.max(1, options.perSecond);
    this.#burst = Math.max(1, options.burst ?? options.perSecond);
    this.#clock = options.clock ?? systemClock;
    this.#tokens = this.#burst;
    this.#lastRefill = this.#clock.monotonic();
  }

  tryAccept(): boolean {
    this.#refill();
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }

  /**
   * Hands back a token `tryAccept` reserved for work that took no socket — an upgrade whose
   * credential was refused, or whose authenticator failed. Never past `burst`.
   */
  refund(): void {
    this.#refill();
    this.#tokens = Math.min(this.#burst, this.#tokens + 1);
  }

  /** Delay to hand a refused client, jittered so refusals do not re-synchronise the herd. */
  retryAfterMs(rng: Rng = Math.random): number {
    const base = Math.ceil(1000 / this.#perSecond);
    return Math.round(base + rng() * base * 4);
  }

  get tokens(): number {
    this.#refill();
    return Math.floor(this.#tokens);
  }

  /** The sustained rate this bucket was built with — what a refusal has to name to be actionable. */
  get perSecond(): number {
    return this.#perSecond;
  }

  #refill(): void {
    const now = this.#clock.monotonic();
    const elapsed = now - this.#lastRefill;
    if (elapsed <= 0) return;
    this.#lastRefill = now;
    this.#tokens = Math.min(this.#burst, this.#tokens + (elapsed / 1000) * this.#perSecond);
  }
}
