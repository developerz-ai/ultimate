// The before-input gate: the part of a policy that reads only WHO is asking, decided before the
// caller's payload is parsed. Without it a caller who may never call an operation learns its input
// schema from the 400 (`X_INPUT_INVALID` lists every field it wanted) instead of getting the 403
// the policy would give — a staff operation's shape, told to any customer who sends `{}`.
//
// Exact, not a heuristic: a clause is decided here only when no predicate would have to run
// (`can()` without one, `allow()`, `deny()`, and the combinators over them — plus `can(p, pred)`
// for an actor WITHOUT `p`, whose predicate never runs either). Everything else is "undecided",
// the surface parses the input, and the full `evaluate()` decides as it always did.

import { ALLOWED, type Policy, type PolicyDecision } from './policy';
import { type PreInputArgs, preInputRun } from './pre-input-brand';
import { enforce, type Surface, type SurfaceDenial } from './surfaces';

export type { PreInputArgs } from './pre-input-brand';

/**
 * What the policy decides for this actor whatever the input is; `undefined` when the answer
 * depends on the input (or on a row). A policy this package did not build is always `undefined`.
 */
export const decideBeforeInput = <I, R>(
  policy: Policy<I, R>,
  args: PreInputArgs,
): PolicyDecision | undefined => preInputRun(policy, args, undefined, 0);

/**
 * The surface adapter for the gate: a denial shaped exactly like `enforce()`'s for the same
 * surface, or `undefined` — for an allowance AND for "undecided", because either way the full
 * evaluation still runs after the parse. A denial goes through `enforce()` itself, so it is traced
 * and reaches the `DecisionSink` once, like any other; a caller let through here emits nothing,
 * which keeps one decision event per call.
 */
export const enforceBeforeInput = <I, R>(
  surface: Surface,
  policy: Policy<I, R>,
  args: PreInputArgs,
): SurfaceDenial | undefined => {
  const decision = decideBeforeInput(policy, args);
  if (decision === undefined || decision.allowed) return undefined;
  // The same tree, answering only what it can decide without input. `run` is re-entered by
  // `evaluate()` with a recorder, so the trace names the clause that refused.
  const projected: Policy<I, R> = {
    kind: policy.kind,
    label: policy.label,
    permissions: policy.permissions,
    children: policy.children,
    run: (runArgs, recorder, depth = 0) =>
      preInputRun(policy, { actor: runArgs.actor, ctx: runArgs.ctx }, recorder, depth) ?? ALLOWED,
  };
  return enforce(surface, projected, {
    // Never read: every clause the projection answers ignores the input by construction.
    input: undefined as I,
    actor: args.actor,
    ...(args.ctx === undefined ? {} : { ctx: args.ctx }),
  });
};
