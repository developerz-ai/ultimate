// Single responsibility: what a flag IS — the two kinds, and the normalisation from a declaration
// to the frozen record everything else reads.
//
// The two kinds are the whole answer to "N flags = 2^N untested states". A `permanent` flag is a
// product or ops switch that legitimately outlives the change that introduced it. A `temporary`
// flag is scaffolding, so it carries an expiry and an owner, and past that date every evaluation
// reports it (see `evaluate.ts`). The state space stays bounded because the temporary half is
// forced to shrink.

import { isIsoDateTime } from '@ultimat3/core';
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
 * `isIsoDateTime` is the framework's one rule for "a string whose instant is the same on every
 * host and is the one written" — `t.date`, the HTTP coercion and `@ultimat3/time`'s `fromIso` all
 * ask it. This file used to restate two of its three patterns, and the missing one was the shape:
 * `'December 1, 2026'` and `'12/01/2026'` carry no clock time, so they passed the zone screen and
 * `Date.parse` read them at the HOST's local midnight — the deadline moved with the pod's `TZ` —
 * and `'2026-02-30'` rolled over to March 2nd. A clock time with no `Z` or offset is refused by
 * the same predicate: `2026-12-01T00:00:00` measured fourteen hours apart between
 * America/New_York and Asia/Tokyo. A date-only form is UTC by specification, so it passes.
 *
 * `typeof` first: a snapshot pushed from a store, or a plain-JS caller, has no types to be checked
 * by. `flag.test.ts` spawns a `TZ=` subprocess per zone, because `scripts/test-setup.ts` pins the
 * runner to UTC and the failure is invisible in process.
 */
function expiryMsOf(key: string, expiresAt: string): number {
  if (typeof expiresAt !== 'string' || !isIsoDateTime(expiresAt)) {
    throw flagExpiryInvalid(key, expiresAt);
  }
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) throw flagExpiryInvalid(key, expiresAt);
  return ms;
}
