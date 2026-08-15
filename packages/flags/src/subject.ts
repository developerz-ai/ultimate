// Single responsibility: what a flag decides ABOUT, and how a subject kind resolves to the one id
// that gets matched or hashed. A subject is any identified record — a tenant, a bank integration,
// a device — which is the generalisation of the actor axis, not a second mechanism beside it.

import type { Actor } from '@ultimat3/core';
import type { FlagSubjectVia } from './errors';
import { flagSubjectRequired } from './errors';

/**
 * The records in play at ONE evaluation, keyed by kind: `{ bank: 'bank_integration:bbva' }`.
 *
 * A map rather than a list of `{ kind, id }` because a single evaluation has a single bank, a
 * single project, a single device: the shape makes a duplicate kind unrepresentable instead of a
 * rule nothing enforces. The id is the app's — an opaque string, never parsed here.
 */
export type FlagSubjects = Readonly<Record<string, string>>;

/**
 * The two kinds every app has, and the two an `Actor` already carries. Everything else is the
 * app's own vocabulary and arrives in `FlagSubjects`.
 *
 * A built-in kind is resolved from the actor and NEVER from the map. That is what keeps this a
 * single mechanism rather than two: one source per kind, so there is no precedence rule to
 * remember and no second place a tenant can come from. Passing `org` at a call site is dead data,
 * and it cannot produce a wrong answer — without `actor.orgId` the evaluation raises, and the fix
 * line says to mint the actor with its org.
 */
export const BUILT_IN_SUBJECT_KINDS = ['actor', 'org'] as const;

export type BuiltInSubjectKind = (typeof BUILT_IN_SUBJECT_KINDS)[number];

export const isBuiltInSubjectKind = (kind: string): kind is BuiltInSubjectKind =>
  (BUILT_IN_SUBJECT_KINDS as readonly string[]).includes(kind);

/**
 * The id for `kind`, or a loud failure — never a fallback to the actor and never the declared
 * default. An answer about a record computed from whoever happened to be calling is the bug this
 * axis removes: it looks like it worked. An empty string is absent, not an id; it would otherwise
 * match an allow list entry or hash to a real bucket.
 *
 * The kind space is open, exactly like the flag key space. A typo'd kind raises here on the first
 * evaluation, which is the same loud failure an undeclared key already gets from `X_FLAG_UNKNOWN`
 * — a registry of kinds would be a second declaration surface buying a check this already makes.
 */
export function subjectIdOf(init: {
  readonly key: string;
  readonly kind: string;
  readonly actor: Actor;
  readonly subjects: FlagSubjects | undefined;
  readonly via: FlagSubjectVia;
}): string {
  const { key, kind, actor, subjects, via } = init;
  const id = resolve(kind, actor, subjects);
  if (id === undefined || id === '') {
    throw flagSubjectRequired({ key, kind, actorId: actor.id, via });
  }
  return id;
}

/**
 * Own properties only. `subjects['toString']` would otherwise walk the prototype chain and hand
 * back a function where an id belongs — a weird downstream failure instead of the clean
 * `X_FLAG_SUBJECT_REQUIRED` this package designed for exactly that case.
 *
 * The `typeof` re-check is for JS callers and store-shaped data: an id is a string or it is
 * nothing, and a number reaching `bucketOf` would hash to a real bucket rather than raise.
 */
function resolve(
  kind: string,
  actor: Actor,
  subjects: FlagSubjects | undefined,
): string | undefined {
  if (kind === 'actor') return actor.id;
  if (kind === 'org') return actor.orgId;
  if (subjects === undefined || !Object.hasOwn(subjects, kind)) return undefined;
  const id = subjects[kind];
  return typeof id === 'string' ? id : undefined;
}
