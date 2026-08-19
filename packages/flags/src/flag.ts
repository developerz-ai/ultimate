// Single responsibility: what a flag IS — the two kinds, and the normalisation from a declaration
// to the frozen record everything else reads.
//
// The two kinds are the whole answer to "N flags = 2^N untested states". A `permanent` flag is a
// product or ops switch that legitimately outlives the change that introduced it. A `temporary`
// flag is scaffolding, so it carries an expiry and an owner, and past that date every evaluation
// reports it (see `evaluate.ts`). The state space stays bounded because the temporary half is
// forced to shrink.

import { flagExpiryInvalid } from './errors';
import type { FlagTargeting } from './targeting';
import { assertTargeting } from './targeting-assert';

export const FLAG_KINDS = ['permanent', 'temporary'] as const;

export type FlagKind = (typeof FLAG_KINDS)[number];

export interface PermanentFlagDef {
  readonly kind: 'permanent';
  readonly key: string;
  /** What the switch means. The projection prints it; it is all a reader has to go on. */
  readonly description: string;
  readonly targeting: FlagTargeting;
}

export interface TemporaryFlagDef {
  readonly kind: 'temporary';
  readonly key: string;
  readonly description: string;
  readonly targeting: FlagTargeting;
  /** ISO-8601 date the scaffolding is due to come down. Required — see `FlagExpiryIsMandatory`. */
  readonly expiresAt: string;
  /** Who takes it down. A temporary flag with no owner is one nobody removes. */
  readonly owner: string;
}

export type FlagDef = PermanentFlagDef | TemporaryFlagDef;

type Assert<T extends true> = T;

/**
 * Compile-time proof that `kind: 'temporary'` cannot be declared without an expiry: a temporary
 * shape missing `expiresAt` must NOT be assignable to `FlagDef`. Loosen the union and the
 * conditional yields `false`, `Assert<false>` fails its constraint, and `tsc -b packages/flags`
 * goes red here. Axiom 3 — the rule is a build error, not a comment in a style guide.
 */
export type FlagExpiryIsMandatory = Assert<
  {
    readonly kind: 'temporary';
    readonly key: string;
    readonly description: string;
    readonly targeting: FlagTargeting;
    readonly owner: string;
  } extends FlagDef
    ? false
    : true
>;

/** The normalised record. Both kinds share one shape so nothing downstream branches on kind. */
export interface Flag {
  readonly key: string;
  readonly kind: FlagKind;
  readonly description: string;
  readonly targeting: FlagTargeting;
  /** ISO-8601 as declared, `null` for a permanent flag. */
  readonly expiresAt: string | null;
  /** Epoch ms of `expiresAt`, precomputed so evaluation never parses a date. */
  readonly expiresAtMs: number | null;
  readonly owner: string | null;
}

/**
 * Declaration → `Flag`, with both invariants enforced here rather than at the first evaluation.
 * The expiry is re-checked at runtime even though the type already demands it: a snapshot pushed
 * from a store, or a plain-JS caller, has no types to be checked by.
 */
export function toFlag(def: FlagDef): Flag {
  assertTargeting(def.key, def.targeting);
  if (def.kind === 'permanent') {
    return Object.freeze({
      key: def.key,
      kind: def.kind,
      description: def.description,
      targeting: def.targeting,
      expiresAt: null,
      expiresAtMs: null,
      owner: null,
    });
  }
  const expiresAtMs = expiryMsOf(def.key, def.expiresAt);
  return Object.freeze({
    key: def.key,
    kind: def.kind,
    description: def.description,
    targeting: def.targeting,
    expiresAt: def.expiresAt,
    expiresAtMs,
    owner: def.owner,
  });
}

/** Re-target a declared flag without re-declaring it — how `applyFlagSnapshot` lands an override. */
export function withTargeting(flag: Flag, targeting: FlagTargeting): Flag {
  assertTargeting(flag.key, targeting);
  return Object.freeze({ ...flag, targeting });
}

/**
 * A time of day, and the zone it is stated in. `2026-12-01T00:00:00` without one is resolved by
 * `Date.parse` through the PROCESS's zone: measured, that one string is 1796083200000 in UTC,
 * 1796101200000 in America/New_York and 1796050800000 in Asia/Tokyo — fourteen hours of spread
 * across a fleet, so `X_FLAG_EXPIRED` starts on a different DAY on different pods. A date-only
 * form carries no clock time and is UTC by specification, so it passes.
 *
 * The same two patterns as `@ultimat3/time`'s `fromIso`, restated rather than imported: this
 * package is tier 1 and may import `@ultimat3/core` only — a deadline is one date, and one date is
 * not worth a tier edge. `flag.test.ts` spawns a `TZ=` subprocess per zone, because
 * `scripts/test-setup.ts` pins the runner to UTC and the failure is invisible in process.
 */
const CLOCK_TIME = /[t ]\d{1,2}:\d{2}/i;
const UTC_OFFSET = /(?:z|[+-]\d{2}:?\d{2})$/i;

function expiryMsOf(key: string, expiresAt: string): number {
  if (CLOCK_TIME.test(expiresAt) && !UTC_OFFSET.test(expiresAt)) {
    throw flagExpiryInvalid(key, expiresAt);
  }
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) throw flagExpiryInvalid(key, expiresAt);
  return ms;
}
