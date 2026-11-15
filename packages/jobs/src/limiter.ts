// `limiter(name, { rate, concurrency })`: ONE named budget, declared once at module scope and spent
// by every job that names it (`job({ limiter })`) — "the payment provider takes 10 calls a second
// and 4 at once, whichever job makes them". A declaration only: the value is data, and the gate
// that spends it is `limiter-gate.ts`, over the installed driver's `LeaseStore`.

import { LimiterDeclarationInvalidError } from './limiter-errors';
import type { RateLimit } from './limits';

export interface LimiterOptions {
  /** At most `limit` starts in ANY `windowMs`, fleet-wide — a sliding window, never a burst past it. */
  readonly rate?: RateLimit;
  /** At most this many runs holding the limiter at once, fleet-wide. */
  readonly concurrency?: number;
}

export interface JobLimiter {
  readonly kind: 'limiter';
  readonly name: string;
  readonly rate: RateLimit | undefined;
  readonly concurrency: number | undefined;
}

/**
 * The most starts one rate window may hold. Each start in a window is one `x_job_leases` row and
 * a grant probes the free slots (`SQL_LEASE_ACQUIRE`'s `generate_series`), so the cost of a grant
 * grows with `limit`. A budget past it is the same budget over a shorter window.
 */
export const MAX_LIMITER_RATE = 1_000;

/** A limiter name keys lease rows and appears in `x jobs show`: an id, never a payload. */
const NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;

const whole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

/** What every declaration of a name agreed on, per process: two answers are a refusal. */
const declared = new Map<string, string>();

const fingerprint = (limiter: JobLimiter): string =>
  JSON.stringify([limiter.rate?.limit, limiter.rate?.windowMs, limiter.concurrency]);

export function limiter(name: string, options: LimiterOptions): JobLimiter {
  const refuse = (field: string, value: unknown, why: string): never => {
    throw new LimiterDeclarationInvalidError({
      limiter: String(name),
      field,
      declared: value,
      why,
    });
  };
  if (typeof name !== 'string' || !NAME.test(name)) {
    refuse(
      'its name',
      name,
      'and a name is 1–100 of a-z, 0-9, ".", "_", "-", starting alphanumeric',
    );
  }
  const { rate, concurrency } = options;
  if (rate === undefined && concurrency === undefined) {
    refuse('neither rate nor concurrency', options, 'so it limits nothing');
  }
  if (concurrency !== undefined && !whole(concurrency)) {
    refuse('concurrency', concurrency, 'and it counts runs: a whole number of at least 1');
  }
  if (rate !== undefined) {
    if (!whole(rate.limit) || rate.limit > MAX_LIMITER_RATE) {
      refuse(
        'rate.limit',
        rate.limit,
        `and it counts starts: a whole number from 1 to ${MAX_LIMITER_RATE} (more is the same budget over a shorter window)`,
      );
    }
    if (!whole(rate.windowMs)) {
      refuse(
        'rate.windowMs',
        rate.windowMs,
        'and a window is a whole number of milliseconds, 1 or more',
      );
    }
  }

  const value: JobLimiter = Object.freeze({
    kind: 'limiter',
    name,
    rate:
      rate === undefined
        ? undefined
        : Object.freeze({ limit: rate.limit, windowMs: rate.windowMs }),
    concurrency,
  });
  // The same numbers twice is one budget declared in two files a module graph reached twice; other
  // numbers on one name would share lease rows and disagree about the ceiling they count to.
  const seen = declared.get(name);
  if (seen !== undefined && seen !== fingerprint(value)) {
    refuse(
      'a second, different declaration',
      options,
      `and limiter "${name}" is already declared as ${seen} (rate.limit, rate.windowMs, concurrency)`,
    );
  }
  declared.set(name, fingerprint(value));
  return value;
}

/** Test seam: forget every declared name, as `resetJobs()` forgets every job. */
export function resetLimiters(): void {
  declared.clear();
}
