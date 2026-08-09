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

export interface DefinePolicyInput<I, R = unknown> {
  /**
   * Message key rendered when the rule denies. A key rather than a sentence so the denial is
   * translatable and so two surfaces cannot word the same refusal differently.
   */
  readonly deny: string;
  /**
   * Pure decision over the actor, the already-loaded input and the already-loaded row.
   * Returning `false` denies with `deny`; return a `PolicyDecision` for a more specific reason.
   *
   * Must not perform I/O — see the file header. A rule that needs a row reads `args.row`,
   * which the surface loaded and passed in; `row` is `null` when the rule decides on input
   * alone. Never reach for a row through `input` — that is the drift this signature ended.
   */
  readonly check?: (args: PolicyArgs<I, R>) => boolean | PolicyDecision;
}

/**
 * Decides on input alone — `row` stays `null`:
 *
 * ```ts
 * export const postCreate = definePolicy<{ orgId: string }>('post:create', {
 *   deny: 'errors.policyDenied',
 *   check: ({ actor, input }) => actor?.orgId === input.orgId,
 * });
 * ```
 *
 * Decides about a row the surface already loaded — second type argument, read `row`:
 *
 * ```ts
 * export const postPublish = definePolicy<{ postId: string }, Post>('post:publish', {
 *   deny: 'errors.policyDenied',
 *   check: ({ actor, row }) => row !== null && row.authorId === actor?.id,
 * });
 * ```
 *
 * Identical in behaviour to `can(permission, predicate)` — the same `Policy` object, so the
 * same instance is evaluated by HTTP, live queries, jobs, MCP and the admin UI.
 */
export const definePolicy = <I = unknown, R = unknown>(
  permission: KnownPermission,
  input: DefinePolicyInput<I, R>,
): Policy<I, R> => {
  const { deny, check } = input;
  if (check === undefined) return can<I, R>(permission);
  return can<I, R>(permission, (args) => {
    const outcome = check(args);
    if (outcome === true) return true;
    if (outcome === false) return denied(deny);
    return outcome;
  });
};
