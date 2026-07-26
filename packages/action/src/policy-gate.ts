/**
 * The single point of contact with @ultimat3/policy. Every surface (HTTP, MCP,
 * job, direct server call) reaches authz through `guard()` — there is no second
 * code path, which is what makes "one authz system" true rather than aspirational.
 */

import type { Actor, Ctx } from '@ultimat3/core';
import { assertNever, isAnonymous } from '@ultimat3/core';
import type { Policy, Surface as PolicySurface } from '@ultimat3/policy';
import { enforce } from '@ultimat3/policy';
import { ActionDeniedError } from './errors';

/** Policies are opaque here: we evaluate them, we never introspect their rules. */
export type ActionPolicy = Policy<unknown>;

/** Which projection is running. Selects the deny renderer, never the decision. */
export type Surface = 'server' | 'http' | 'mcp' | 'job';

export interface PolicySubject {
  readonly actor: Actor | null;
  readonly input: unknown;
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

/** The capability an action requires, for manifests and OpenAPI metadata. */
export function policyCapability(policy: ActionPolicy): string {
  return policy.label;
}
