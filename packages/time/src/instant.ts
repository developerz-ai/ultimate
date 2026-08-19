/**
 * An `Instant` is a point on the UTC timeline. **All storage is UTC** — columns are
 * `timestamptz`, wire format is ISO-8601 with `Z`, and no zone is attached to a stored
 * value. Zones exist only at the edge, in `format.ts` and `zoned.ts`.
 */

import { type Clock, systemClock } from '@ultimat3/core';
import { instantInvalid } from './errors';

declare const instantBrand: unique symbol;

/** A `Date` that has been proven valid and is documented as UTC. */
export type Instant = Date & { readonly [instantBrand]: 'utc' };

/**
 * Wrap a `Date` from an untrusted source (a DB driver, a parsed payload).
 *
 * A **copy**, never the caller's own object: `value as Instant` handed back a `Date` the caller
 * still holds and can `setTime()` after the brand is applied, so a value this function certified
 * as valid could stop being the value it certified.
 */
export function instant(value: Date): Instant {
  if (Number.isNaN(value.getTime())) throw instantInvalid(String(value));
  return new Date(value.getTime()) as Instant;
}

/**
 * A time of day, and the zone it is stated in. `2026-03-14T09:00` without one is resolved by
 * `new Date` through the PROCESS's zone, so the guard has to see both halves: a string carrying
 * a clock time is refused unless it also carries `Z` or an offset. A date-only form carries no
 * clock time and is UTC by specification, so it passes.
 */
const CLOCK_TIME = /[t ]\d{1,2}:\d{2}/i;
const UTC_OFFSET = /(?:z|[+-]\d{2}:?\d{2})$/i;

/** ISO-8601 in, `Instant` out. An offset or `Z` is required — a bare local string is refused. */
export function fromIso(iso: string): Instant {
  // Enforced, not documented: this header asked for an offset for three releases while the body
  // accepted a bare local string and answered a different instant per deployment timezone.
  if (CLOCK_TIME.test(iso) && !UTC_OFFSET.test(iso)) throw instantInvalid(iso);
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) throw instantInvalid(iso);
  return parsed as Instant;
}

/** The only serialization: `2026-03-14T09:00:00.000Z`. */
export function toIso(at: Instant): string {
  return at.toISOString();
}

/** Date-only ISO form in UTC. Use `formatIsoDate` when you need it in a zone. */
export function toIsoDateUtc(at: Instant): string {
  return at.toISOString().slice(0, 10);
}

export function fromEpochMs(ms: number): Instant {
  if (!Number.isFinite(ms)) throw instantInvalid(String(ms));
  return new Date(ms) as Instant;
}

export function toEpochMs(at: Instant): number {
  return at.getTime();
}

export function fromEpochSeconds(seconds: number): Instant {
  return fromEpochMs(seconds * 1000);
}

/**
 * The clock is always injected. Tests freeze time by passing a fake clock; nothing in
 * the framework calls `Date.now()` directly.
 */
export function now(clock: Clock = systemClock): Instant {
  return fromEpochMs(epochMsOf(clock.now()));
}

export function addMs(at: Instant, ms: number): Instant {
  return fromEpochMs(at.getTime() + ms);
}

export function subtractMs(at: Instant, ms: number): Instant {
  return fromEpochMs(at.getTime() - ms);
}

/** Signed milliseconds from `from` to `to`. */
export function differenceMs(from: Instant, to: Instant): number {
  return to.getTime() - from.getTime();
}

export function isBefore(left: Instant, right: Instant): boolean {
  return left.getTime() < right.getTime();
}

export function isAfter(left: Instant, right: Instant): boolean {
  return left.getTime() > right.getTime();
}

export function compareInstants(left: Instant, right: Instant): -1 | 0 | 1 {
  if (left.getTime() < right.getTime()) return -1;
  return left.getTime() > right.getTime() ? 1 : 0;
}

export function isInstant(value: unknown): value is Instant {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * A fresh instant at the Unix epoch, per call.
 *
 * Replaces the `EPOCH` constant, which was one shared mutable `Date` exported from a tier-1
 * package: a single `EPOCH.setUTCFullYear(...)` anywhere in the process corrupted it for every
 * other consumer, permanently and silently. A `Date` cannot be frozen — `Object.freeze` does not
 * close `setTime`, because the value lives in an internal slot — so the only safe shape is a
 * function. **Breaking: `EPOCH` is removed**; it had no callers in this repo.
 */
export function epoch(): Instant {
  return new Date(0) as Instant;
}

/** Tolerates a `Clock` whose `now()` returns either a `Date` or epoch milliseconds. */
function epochMsOf(value: Date | number): number {
  return typeof value === 'number' ? value : value.getTime();
}
