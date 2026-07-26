// Single responsibility: the only source of "now" in the framework. Everything time-related
// takes a `Clock` so tests freeze time instead of sleeping. Nothing else may call `Date.now()`.

export interface Clock {
  /** Wall-clock instant. Always UTC-backed; format at the edge with an explicit IANA tz. */
  now(): Date;
  /** Monotonic milliseconds — safe for durations, unaffected by wall-clock jumps. */
  monotonic(): number;
}

export interface FrozenClock extends Clock {
  /** Move wall-clock and monotonic time forward by `ms`. */
  advance(ms: number): void;
  set(at: Date | number | string): void;
}

export const systemClock: Clock = Object.freeze({
  now(): Date {
    return new Date();
  },
  monotonic(): number {
    return performance.now();
  },
});

function toEpochMs(at: Date | number | string): number {
  if (at instanceof Date) return at.getTime();
  if (typeof at === 'number') return at;
  return new Date(at).getTime();
}

/** A clock stuck at `at` until `advance()` is called. Monotonic starts at 0. */
export function frozenClock(at: Date | number | string = 0): FrozenClock {
  let epochMs = toEpochMs(at);
  let mono = 0;
  return {
    now(): Date {
      return new Date(epochMs);
    },
    monotonic(): number {
      return mono;
    },
    advance(ms: number): void {
      epochMs += ms;
      mono += ms;
    },
    set(next: Date | number | string): void {
      epochMs = toEpochMs(next);
    },
  };
}
