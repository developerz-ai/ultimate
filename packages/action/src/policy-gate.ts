/**
 * The single point of contact with @ultimat3/policy. Every surface (HTTP, MCP,
 * job, direct server call) reaches authz through `guard()` — there is no second
 * code path, which is what makes "one authz system" true rather than aspirational.
 */

import type { Actor, Ctx } from '@ultimat3/core';
import { assertNever, isAnonymous } from '@ultimat3/core';
import type { Policy, Surface as PolicySurface } from '@ultimat3/policy';
import { enforce, policyPermissions as flattenedPermissions } from '@ultimat3/policy';
import { ActionDeniedError } from './errors';

/**
 * Policies are opaque here: we evaluate them, we never introspect their rules.
 * `TRow` is what a row-level rule decides about, defaulted so the bare
 * `ActionPolicy` keeps meaning "decides on input, any row or none".
 */
export type ActionPolicy<TRow = unknown> = Policy<unknown, TRow>;

/** Which projection is running. Selects the deny renderer, never the decision. */
export type Surface = 'server' | 'http' | 'mcp' | 'job';

export interface PolicySubject {
  readonly actor: Actor | null;
  readonly input: unknown;
  /**
   * The already-loaded row a row-level rule decides about; `null` when the action
   * declared no loader. Optional here and required in `PolicyArgs` for the same
   * reason `EvaluateArgs.row` is: a surface deciding on input alone should not have
   * to write `row: null`, but the predicate it reaches must still see the field.
   * `invoke` always passes it, so the gap closes before any rule runs.
   */
  readonly row?: unknown;
  readonly ctx: Ctx;
  readonly action: string;
}

/**
 * Evaluate once, render the denial per surface. `enforce` runs the same policy
 * object for every surface, so an actor denied over HTTP is denied over MCP with
 * the same reason and the same code.
 */
export function guard(policy: ActionPolicy, subject: PolicySubject, surface: Surface): void {
  const denial = enforce(policySurface(surface), policy, {
    input: subject.input,
    actor: subject.actor,
    // `evaluate()` normalises a missing row to `null`, so an input-only rule and a
    // row rule reach the predicate through one shape rather than two.
    row: subject.row,
    ctx: subject.ctx,
  });
  if (denial !== undefined) throw new ActionDeniedError(subject.action, denial);
}

/** A direct server call is the job surface: no request, no response to shape. */
function policySurface(surface: Surface): PolicySurface {
  switch (surface) {
    case 'http':
      return 'http';
    case 'mcp':
      return 'mcp';
    case 'job':
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

/** The capability an action requires, for manifests and OpenAPI metadata. A DISPLAY label. */
export function policyCapability(policy: ActionPolicy): string {
  return policy.label;
}

/**
 * Every permission the policy tree references, flattened and deduped — and the only field a
 * compliance report may match a grant against. `label` renders a composite as
 * `and(post:publish, org:administer)`, which is a sentence and never equals a permission string,
 * so matching on it reported every action guarded by a composite as enforcing nothing: `x policy
 * list` showed real grants as dead. The two are kept side by side rather than one replacing the
 * other — the label is what a human reads, this is what a machine compares.
 */
export function policyPermissions(policy: ActionPolicy): readonly string[] {
  return flattenedPermissions(policy);
}
