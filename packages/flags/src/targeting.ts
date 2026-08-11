// Single responsibility: who a flag is on for. Pure and synchronous — this is the code that runs
// inside a policy predicate and a render pass, so it never awaits, never reads a store and never
// touches a clock. Loading the store is somebody else's job (`applyFlagSnapshot`).
import type { Actor } from '@ultimat3/core';
import { hasRole } from '@ultimat3/core';
import { BUCKETS, bucketOf } from './bucket';
import { flagTargetingInvalid } from './errors';

export interface FlagTargeting {
  /** The answer when no allow list and no rollout claims this actor. `false` is off, `true` is on. */
  readonly default: boolean;
  /** Actor ids that are always on, ahead of any rollout. */
  readonly actors?: readonly string[] | undefined;
  /** Actor roles that are always on, ahead of any rollout. */
  readonly roles?: readonly string[] | undefined;
  /** Percentage of actors, 0-100 inclusive. Stable: one actor, one answer, every call. */
  readonly rollout?: number | undefined;
}

/**
 * Declaration-time validation, the way `can()` validates its permission rather than waiting for a
 * request. Two rules, each closing a way for a flag to look wired and decide nothing:
 *
 * | Rejected | Why |
 * |---|---|
 * | `rollout: 0.5` | read as a fraction it means "half", read as a percentage it means "nobody" |
 * | `default: true` with a `rollout` | the two answer the same actors and disagree; there is no reading of "on for everyone, and also on for 10%" |
 */
export function assertTargeting(key: string, targeting: FlagTargeting): void {
  const { rollout } = targeting;
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

/**
 * Allow lists first, rollout second, declared default last. That order is the contract: an actor
 * an operator explicitly named must not depend on where a hash happened to put them, which is the
 * whole reason an allow list exists.
 *
 * A `null` actor gets the default and nothing else. There is no id to hash, so a rollout could
 * only be answered by re-rolling per call — the one thing this file refuses to do. An anonymous
 * `Actor` DOES have an id (`anonymous`), so every anonymous visitor shares one bucket: one
 * identity, one answer, which is what the anonymous actor already means everywhere else.
 */
export function evaluateTargeting(
  key: string,
  targeting: FlagTargeting,
  actor: Actor | null,
): boolean {
  if (actor === null) return targeting.default;
  if (targeting.actors?.includes(actor.id) === true) return true;
  if (targeting.roles?.some((role) => hasRole(actor, role)) === true) return true;
  if (targeting.rollout === undefined) return targeting.default;
  return bucketOf(key, actor.id) < targeting.rollout;
}
