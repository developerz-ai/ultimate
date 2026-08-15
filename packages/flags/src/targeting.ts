// Single responsibility: who a flag is on for. Pure and synchronous — this is the code that runs
// inside a policy predicate and a render pass, so it never awaits, never reads a store and never
// touches a clock. Loading the store is somebody else's job (`applyFlagSnapshot`).
import type { Actor } from '@ultimat3/core';
import { hasRole } from '@ultimat3/core';
import { BUCKETS, bucketOf } from './bucket';
import { flagTargetingInvalid } from './errors';
import type { FlagSubjects } from './subject';
import { BUILT_IN_SUBJECT_KINDS, isBuiltInSubjectKind, subjectIdOf } from './subject';

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
 * Declaration-time validation, the way `can()` validates its permission rather than waiting for a
 * request. Each rule closes a way for a flag to look wired and decide nothing:
 *
 * | Rejected | Why |
 * |---|---|
 * | `rollout: 0.5` | read as a fraction it means "half", read as a percentage it means "nobody" |
 * | `default: true` with a `rollout` | the two answer the same actors and disagree; there is no reading of "on for everyone, and also on for 10%" |
 * | `bucketBy` with no `rollout` | it names what a rollout divides, and there is no rollout to divide |
 * | a blank `bucketBy` | names no kind at all |
 * | `subjects.actor` / `subjects.org` | `actors` and `orgs` are the one spelling; two would disagree |
 * | a `subjects` entry that is not a list of non-empty ids | reachable from a store snapshot, and it matches nothing while reading as an allow list |
 *
 * The `subjects` checks narrow by hand rather than through a schema: this package's other runtime
 * re-checks (`Number.isInteger`, `Date.parse`) do the same, and a dependency here would buy one
 * validation on a path that must stay allocation-free.
 */
export function assertTargeting(key: string, targeting: FlagTargeting): void {
  const { bucketBy, rollout } = targeting;
  if (targeting.subjects !== undefined) assertSubjects(key, targeting.subjects);
  if (bucketBy !== undefined) {
    if (typeof bucketBy !== 'string' || bucketBy.trim() === '') {
      throw flagTargetingInvalid(
        key,
        `bucketBy is ${JSON.stringify(bucketBy)}, which names no subject kind`,
        `set bucketBy to a subject kind — '${BUILT_IN_SUBJECT_KINDS.join("', '")}', or one your call site passes — in defineFlag({ key: '${key}' })`,
      );
    }
    if (rollout === undefined) {
      throw flagTargetingInvalid(
        key,
        `bucketBy is '${bucketBy}' with no rollout, so it divides nothing`,
        `add a rollout to defineFlag({ key: '${key}' }), or remove bucketBy`,
      );
    }
  }
  if (rollout === undefined) return;
  if (!Number.isInteger(rollout)) {
    const problem = `rollout is ${rollout}; a rollout is a whole percentage, not a fraction`;
    throw flagTargetingInvalid(key, problem);
  }
  if (rollout < 0 || rollout > BUCKETS) {
    throw flagTargetingInvalid(key, `rollout is ${rollout}, outside 0-${BUCKETS}`);
  }
  if (targeting.default) {
    throw flagTargetingInvalid(key, `default is true and rollout is ${rollout}; the two disagree`);
  }
}

function assertSubjects(key: string, subjects: Readonly<Record<string, readonly string[]>>): void {
  const fix = `give each subjects entry a kind and a list of ids — { bank: ['bank_integration:bbva'] } — in defineFlag({ key: '${key}' })`;
  for (const [kind, ids] of Object.entries<unknown>(subjects)) {
    if (kind.trim() === '') throw flagTargetingInvalid(key, 'a subjects kind is blank', fix);
    if (isBuiltInSubjectKind(kind)) {
      throw flagTargetingInvalid(
        key,
        `subjects.${kind} restates a built-in kind`,
        `use ${kind === 'org' ? 'orgs' : 'actors'} instead of subjects.${kind} in defineFlag({ key: '${key}' })`,
      );
    }
    if (!Array.isArray(ids)) {
      throw flagTargetingInvalid(key, `subjects.${kind} is not a list of ids`, fix);
    }
    for (const id of ids as readonly unknown[]) {
      if (typeof id !== 'string' || id === '') {
        throw flagTargetingInvalid(key, `subjects.${kind} holds an id that is not a string`, fix);
      }
    }
  }
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
 * `subjectIdOf` is called only on the branches that need a subject, so a plain
 * `{ default, rollout }` flag still allocates nothing.
 */
export function evaluateTargeting(
  key: string,
  targeting: FlagTargeting,
  actor: Actor | null,
  subjects?: FlagSubjects | undefined,
): boolean {
  if (actor === null) return targeting.default;
  if (targeting.actors?.includes(actor.id) === true) return true;
  if (targeting.roles?.some((role) => hasRole(actor, role)) === true) return true;
  if (
    targeting.orgs?.includes(subjectIdOf({ key, kind: 'org', actor, subjects, via: 'orgs' })) ===
    true
  ) {
    return true;
  }
  if (targeting.subjects !== undefined) {
    // Every declared kind is resolved before any of them can answer, so a call site missing one
    // raises whatever order the keys sit in. Short-circuiting on the first match would make the
    // same inputs sometimes answer and sometimes throw, decided by declaration order.
    let matched = false;
    for (const [kind, ids] of Object.entries(targeting.subjects)) {
      const id = subjectIdOf({ key, kind, actor, subjects, via: 'subjects' });
      if (ids.includes(id)) matched = true;
    }
    if (matched) return true;
  }
  if (targeting.rollout === undefined) return targeting.default;
  const subjectId =
    targeting.bucketBy === undefined
      ? actor.id
      : subjectIdOf({ key, kind: targeting.bucketBy, actor, subjects, via: 'bucketBy' });
  return bucketOf(key, subjectId) < targeting.rollout;
}
