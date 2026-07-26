// `definePolicy` — the authoring form apps use. Sugar over `can()`, deliberately synchronous.
//
// Why sync, when an async `check` would let a rule fetch what it needs and no surface could
// forget to load it: a live query evaluates policy PER SUBSCRIBER on every change event. That
// is the design — it is why two actors watching one query see different rows. An async check
// that reads a row turns one insert into one round-trip per subscriber, so a hot feed with
// 10k watchers costs 10k reads per write and the fanout the realtime tier is built on stops
// working. HTTP and jobs would tolerate async fine; live queries have the least slack, so they
// set the constraint.
//
// The cost is real and belongs in the open: the caller loads the row first and passes it in.
// That is more boilerplate than `check: async () => db.posts.find(...)`, and it is the same
// trade as cursor-only pagination — the more ergonomic option is correct right up until
// concurrency arrives.

import type { KnownPermission } from './permissions';
import type { Policy, PolicyArgs, PolicyDecision } from './policy';
import { can, denied } from './policy';

export interface DefinePolicyInput<I> {
  /**
   * Message key rendered when the rule denies. A key rather than a sentence so the denial is
   * translatable and so two surfaces cannot word the same refusal differently.
   */
  readonly deny: string;
  /**
   * Pure decision over the actor and the already-loaded input. Returning `false` denies with
   * `deny`; return a `PolicyDecision` to supply a more specific reason.
   *
   * Must not perform I/O — see the file header. If a rule needs a row, the surface loads it
   * and passes it through `input`.
   */
  readonly check?: (args: PolicyArgs<I>) => boolean | PolicyDecision;
}

/**
 * ```ts
 * export const postPublish = definePolicy('post:publish', {
 *   deny: 'errors.policyDenied',
 *   check: ({ actor, input }) => input.post.authorId === actor.memberId,
 * });
 * ```
 *
 * Identical in behaviour to `can(permission, predicate)` — the same `Policy` object, so the
 * same instance is evaluated by HTTP, live queries, jobs, MCP and the admin UI.
 */
export const definePolicy = <I = unknown>(
  permission: KnownPermission,
  input: DefinePolicyInput<I>,
): Policy<I> => {
  const { deny, check } = input;
  if (check === undefined) return can<I>(permission);
  return can<I>(permission, (args) => {
    const outcome = check(args);
    if (outcome === true) return true;
    if (outcome === false) return denied(deny);
    return outcome;
  });
};
