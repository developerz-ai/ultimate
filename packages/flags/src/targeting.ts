// Single responsibility: who a flag is on for. Pure and synchronous — this is the code that runs
// inside a policy predicate and a render pass, so it never awaits, never reads a store and never
// touches a clock. Loading the store is somebody else's job (`applyFlagSnapshot`).
import type { Actor } from '@ultimat3/core';
import { hasRole } from '@ultimat3/core';
import { bucketOf } from './bucket';
import type { FlagSubjects } from './subject';
import { subjectIdOf } from './subject';

export interface FlagTargeting {
  /** The answer when no allow list and no rollout claims this actor. `false` is off, `true` is on. */
  readonly default: boolean;
  /** Actor ids that are always on, ahead of any rollout — shorthand for the `actor` subject kind. */
  readonly actors?: readonly string[] | undefined;
  /** Actor roles that are always on. NOT a subject: a role is a predicate, not an identified record. */
  readonly roles?: readonly string[] | undefined;
  /** Org ids that are always on — shorthand for the `org` subject kind, read from `actor.orgId`. */
  readonly orgs?: readonly string[] | undefined;
  /**
   * Allow lists for the app's own record kinds: `{ bank: ['bank_integration:bbva'] }`. One rank
   * with `actors`, `roles` and `orgs` — any hit is `true`, which is the same OR Flipper applies
   * across the actors handed to one `enabled?` call.
   *
   * Built-in kinds are refused here: `actors` and `orgs` are their one spelling.
   */
  readonly subjects?: Readonly<Record<string, readonly string[]>> | undefined;
  /** Percentage of the bucketing subject, 0-100 inclusive. Stable: one subject, one answer. */
  readonly rollout?: number | undefined;
  /**
   * Which subject kind the `rollout` divides — `'actor'` (the default), `'org'`, or any kind the
   * call site carries. The kind space is open on purpose, like the flag key space.
   *
   * Bucketing by a record is what keeps it whole: an org whose members share documents, or a bank
   * integration whose connections share a scraper, must be entirely on the new path or entirely
   * on the old one. `'actor'` stays the default, so every flag declared before this axis existed
   * answers exactly as it did.
   */
  readonly bucketBy?: string | undefined;
}

/**
 * Allow lists first, rollout second, declared default last. That order is the contract: a subject
 * an operator explicitly named must not depend on where a hash happened to put it, which is the
 * whole reason an allow list exists. `actors`, `roles`, `orgs` and `subjects` are ONE rank — any
 * hit is `true`, so their order among themselves is not observable, which is the same OR Flipper
 * applies across the actors passed to a single `enabled?` call.
 *
 * A `null` actor gets the default and nothing else. There is no id to hash, so a rollout could
 * only be answered by re-rolling per call — the one thing this file refuses to do. An anonymous
 * `Actor` DOES have an id (`anonymous`), so every anonymous visitor shares one bucket: one
 * identity, one answer, which is what the anonymous actor already means everywhere else. `null`
 * does NOT raise `X_FLAG_SUBJECT_REQUIRED`: it says there is no evaluation context at all, and
 * every such call gets the same answer, so no single subject is split — which is the failure being
 * designed out. A context that exists but lacks the kind is the ambiguous case, and that throws.
 *
 * Every kind the targeting declares resolves before any branch answers, so whether a call raises
 * `X_FLAG_SUBJECT_REQUIRED` depends only on the flag and the context — never on which allow list
 * happened to match first, nor on the order the keys sit in.
 */
export function evaluateTargeting(
  key: string,
  targeting: FlagTargeting,
  actor: Actor | null,
  subjects?: FlagSubjects | undefined,
): boolean {
  if (actor === null) return targeting.default;
  // Nothing answers until every declared kind has resolved. Returning early on an allow-list hit
  // would hide a missing record from exactly the callers who are on the list: the call site ships
  // green, and raises later only for everybody else. `allowed` accumulates instead of returning.
  let allowed = targeting.actors?.includes(actor.id) === true;
  if (targeting.roles?.some((role) => hasRole(actor, role)) === true) allowed = true;
  if (targeting.orgs !== undefined) {
    const orgId = subjectIdOf({ key, kind: 'org', actor, subjects, via: 'orgs' });
    if (targeting.orgs.includes(orgId)) allowed = true;
  }
  if (targeting.subjects !== undefined) {
    // `for…in` + `Object.hasOwn` rather than `Object.entries`: own keys only, and no array pair
    // allocated per declared kind on a path that runs inside policy predicates.
    for (const kind in targeting.subjects) {
      if (!Object.hasOwn(targeting.subjects, kind)) continue;
      const id = subjectIdOf({ key, kind, actor, subjects, via: 'subjects' });
      if (targeting.subjects[kind]?.includes(id) === true) allowed = true;
    }
  }
  if (targeting.rollout === undefined) return allowed || targeting.default;
  const subjectId =
    targeting.bucketBy === undefined
      ? actor.id
      : subjectIdOf({ key, kind: targeting.bucketBy, actor, subjects, via: 'bucketBy' });
  return allowed || bucketOf(key, subjectId) < targeting.rollout;
}
