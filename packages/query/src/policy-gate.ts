/**
 * The single point of contact with @ultimat3/policy. A live query evaluates its
 * policy **per subscriber**, never once at subscribe time for everyone — so this
 * gate is called on every fanout decision and its result is never cached.
 */

import type { Actor, Ctx } from '@ultimat3/core';
import { assertNever, isAnonymous } from '@ultimat3/core';
import type { Policy, Surface as PolicySurface } from '@ultimat3/policy';
import { enforce, policyPermissions as flattenedPermissions } from '@ultimat3/policy';
import { QueryDeniedError } from './errors';

/** Policies are opaque here: we evaluate them, we never introspect their rules. */
export type QueryPolicy = Policy<unknown>;

export type QuerySurface = 'server' | 'http' | 'live';

export interface QuerySubject {
  readonly actor: Actor | null;
  readonly input: unknown;
  /**
   * The already-loaded row a row-level rule decides about — the live row gate supplies it
   * per subscriber per row. Omitted for a subscribe-time or whole-query decision. It is a
   * field of its own and never folded into `input`: the predicate reads `args.row`.
   */
  readonly row?: unknown;
  readonly ctx: Ctx;
  readonly query: string;
}

export function guard(policy: QueryPolicy, subject: QuerySubject, surface: QuerySurface): void {
  const denial = enforce(policySurface(surface), policy, {
    input: subject.input,
    actor: subject.actor,
    row: subject.row,
    ctx: subject.ctx,
  });
  if (denial !== undefined) throw new QueryDeniedError(subject.query, denial);
}

/** A direct server read is the job surface: no request, no socket to close. */
function policySurface(surface: QuerySurface): PolicySurface {
  switch (surface) {
    case 'http':
      return 'http';
    case 'live':
      return 'live';
    case 'server':
      return 'job';
    default:
      return assertNever(surface);
  }
}

/**
 * Core models "nobody" as an anonymous actor; policy models it as `null`, which is
 * what turns a missing session into `X_UNAUTHENTICATED` instead of a bare denial.
 */
export function actorOf(ctx: Ctx): Actor | null {
  return isAnonymous(ctx.actor) ? null : ctx.actor;
}

/** The capability a read requires, for manifests and the `/_x` dashboard. A DISPLAY label. */
export function policyCapability(policy: QueryPolicy): string {
  return policy.label;
}

/**
 * Every permission the policy tree references, flattened and deduped — and the only field a
 * compliance report may match a grant against. `label` renders a composite as
 * `or(feed:read, org:administer)`, which is a sentence and never equals a permission string, so
 * matching on it reported every read guarded by a composite as enforcing nothing. The mirror of
 * `@ultimat3/action`'s, because `x policy list` reads both lists the same way.
 */
export function policyPermissions(policy: QueryPolicy): readonly string[] {
  return flattenedPermissions(policy);
}
