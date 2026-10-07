/**
 * The single point of contact with @ultimat3/policy. Every surface (HTTP, MCP,
 * job, direct server call) reaches authz through `guardAction()` — there is no second
 * code path, which is what makes "one authz system" true rather than aspirational.
 */

import type { Actor, Ctx } from '@ultimat3/core';
import { assertNever } from '@ultimat3/core';
import type { Policy, Surface as PolicySurface } from '@ultimat3/policy';
import { enforce, enforceBeforeInput } from '@ultimat3/policy';
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
export function guardAction(policy: ActionPolicy, subject: PolicySubject, surface: Surface): void {
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

/**
 * The actor-only half of `guardAction`, run BEFORE the input is parsed: a caller the policy refuses
 * whatever they send gets the 403 (or 401) here, and never the 400 whose issue list describes
 * the input schema of an operation they may not call. Undecided — a predicate that reads the input
 * or the row — passes, and `guardAction` decides after the parse exactly as before. Same denial
 * class, same code, same surface rendering as `guardAction`'s.
 */
export function guardActionBeforeInput(
  policy: ActionPolicy,
  subject: Omit<PolicySubject, 'input' | 'row'>,
  surface: Surface,
): void {
  const denial = enforceBeforeInput(policySurface(surface), policy, {
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
