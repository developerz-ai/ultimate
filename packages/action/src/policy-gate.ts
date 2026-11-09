/**
 * The single point of contact with @ultimat3/policy. Every surface (HTTP, MCP, job, direct server
 * call) reaches authz here, through policy's `guardPrimitive` — the one gate `@ultimat3/query`
 * runs too, so the two primitives cannot drift on a surface rule.
 */

import type { Actor, Ctx } from '@ultimat3/core';
import type { GuardSubject, Policy, PrimitiveSurface } from '@ultimat3/policy';
import { guardPrimitive } from '@ultimat3/policy';
import { ActionDeniedError } from './errors';

/** Opaque here: evaluated, never introspected. `TRow` is what a row-level rule decides about. */
export type ActionPolicy<TRow = unknown> = Policy<unknown, TRow>;

/** Which projection is running. Selects the deny renderer, never the decision. */
export type Surface = PrimitiveSurface<'action'>;

export interface PolicySubject {
  readonly actor: Actor | null;
  readonly input: unknown;
  /** The loaded row a row-level rule decides about; `invoke` always passes it, `null` for none. */
  readonly row?: unknown;
  readonly ctx: Ctx;
  readonly action: string;
}

/** Evaluate once, render the denial per surface: one reason and one code on every surface. */
export function guardAction(policy: ActionPolicy, subject: PolicySubject, surface: Surface): void {
  const { action: name, ...rest } = subject;
  guard(policy, { stage: 'input', name, ...rest }, surface);
}

/**
 * The actor-only half, BEFORE the input parse: a caller refused whatever they send gets the 403
 * (or 401), never a 400 describing an input schema they may not call. Undecided passes.
 */
export function guardActionBeforeInput(
  policy: ActionPolicy,
  subject: Omit<PolicySubject, 'input' | 'row'>,
  surface: Surface,
): void {
  guard(
    policy,
    { stage: 'actor', name: subject.action, actor: subject.actor, ctx: subject.ctx },
    surface,
  );
}

function guard(policy: ActionPolicy, subject: GuardSubject, surface: Surface): void {
  const refused = guardPrimitive('action', policy, subject, surface);
  if (refused !== undefined) throw new ActionDeniedError(refused);
}
