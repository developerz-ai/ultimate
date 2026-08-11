// Determinism, installed globally by the test preload. Anything nondeterministic in a test is a
// bug: a frozen clock means "advance it", a seeded RNG means "same values every run", and both are
// restorable so a test that genuinely needs real time can opt out explicitly.

import { NondeterministicError } from './errors';

export const DEFAULT_SEED = 20260101;
export const DEFAULT_NOW = '2026-01-01T00:00:00.000Z';

const RealDate = Date;
const realRandom = Math.random;
// Captured up front: the brand check below is only unforgeable while this is the engine's own
// `getTime` and not whatever a later assignment to `Date.prototype.getTime` left there.
const dateGetTime = RealDate.prototype.getTime;

let frozenAt = new RealDate(DEFAULT_NOW).getTime();
let installed = false;

/** mulberry32: 32 bits of state, uniform enough for tests, identical across platforms and runs. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded id generator, so factories produce stable uuids without a real RNG. */
export function seededUuid(seed: number): () => string {
  const next = seededRandom(seed);
  const hex = (count: number): string =>
    Array.from({ length: count }, () => Math.floor(next() * 16).toString(16)).join('');
  return () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

class FrozenDate extends RealDate {
  constructor(...args: readonly unknown[]) {
    if (args.length === 0) {
      super(frozenAt);
      return;
    }
    // Delegating with a spread keeps every real Date constructor overload working unchanged.
    super(...(args as ConstructorParameters<typeof RealDate>));
  }

  static override now(): number {
    return frozenAt;
  }

  /**
   * While the harness is installed `globalThis.Date` is this subclass, so `value instanceof Date`
   * asks "is it a FrozenDate" — and a Date the runtime built for itself is not one: a timestamptz
   * off a Postgres socket, a `structuredClone`, anything from another realm. Every
   * `value instanceof Date` guard in the framework would then reject a real Date under test and
   * nowhere else, which is the worst place a difference can be. Freezing the clock must not change
   * what a Date *is*, so answer for the internal slot rather than for a prototype chain.
   *
   * `value instanceof RealDate` is not that answer: `instanceof` is per-realm, so a Date built in
   * a `node:vm` context or a worker — the "another realm" case above — still comes back false. A
   * `[object Date]` from `Object.prototype.toString` is not it either: any object carrying
   * `Symbol.toStringTag: 'Date'` passes that. `getTime` throws for anything without a
   * `[[DateValue]]` slot, and that slot is the one thing neither a fake nor a realm can hide.
   */
  static override [Symbol.hasInstance](value: unknown): boolean {
    try {
      dateGetTime.call(value);
      return true;
    } catch {
      return false;
    }
  }
}

export interface DeterminismOptions {
  readonly seed?: number;
  readonly now?: string | number;
}

/** Install the frozen clock and the seeded RNG globally. Idempotent. */
export function installDeterminism(options: DeterminismOptions = {}): void {
  frozenAt = new RealDate(options.now ?? DEFAULT_NOW).getTime();
  const next = seededRandom(options.seed ?? DEFAULT_SEED);
  globalThis.Date = FrozenDate as unknown as DateConstructor;
  Math.random = next;
  installed = true;
}

export function restoreDeterminism(): void {
  globalThis.Date = RealDate;
  Math.random = realRandom;
  installed = false;
}

export const isDeterminismInstalled = (): boolean => installed;

/** Move the frozen clock forward. The only legal way for time to pass inside a test. */
export function advanceClock(ms: number): Date {
  frozenAt += ms;
  return new RealDate(frozenAt);
}

export const frozenNow = (): Date => new RealDate(frozenAt);

export function setFrozenClock(now: string | number): void {
  frozenAt = new RealDate(now).getTime();
}

/** Run `body` with the clock frozen at `now`, then restore whatever was there before. */
export async function frozenClock<T>(now: string, body: () => T | Promise<T>): Promise<T> {
  const previous = frozenAt;
  frozenAt = new RealDate(now).getTime();
  try {
    return await body();
  } finally {
    frozenAt = previous;
  }
}

/**
 * Run a body twice and fail if the results differ. Used by the harness to catch the tests that
 * only pass because they ran first.
 */
export async function assertDeterministic<T>(what: string, body: () => T | Promise<T>): Promise<T> {
  const first = await body();
  const second = await body();
  const a = JSON.stringify(first);
  const b = JSON.stringify(second);
  if (a !== b) throw new NondeterministicError({ what, first: a, second: b });
  return first;
}
