/**
 * The single point of contact with @ultimat3/policy, through `guardPrimitive` — the one gate
 * `@ultimat3/action` runs too. A live query evaluates its policy **per subscriber**: this gate is
 * called on every fanout decision and its result is never cached.
 */

import type { Actor, Ctx } from '@ultimat3/core';
import type { GuardSubject, Policy, PrimitiveSurface } from '@ultimat3/policy';
import { guardPrimitive } from '@ultimat3/policy';
import { QueryDeniedError } from './errors';

/** Policies are opaque here: we evaluate them, we never introspect their rules. */
export type QueryPolicy = Policy<unknown>;

/**
 * Where a read came from. `'mcp'` is an agent's tool call: it spends a declared `rateLimit:` and,
 * since v31, is judged on policy's `mcp` surface exactly as an MCP action is.
 */
export type QuerySurface = PrimitiveSurface<'query'>;

export interface QuerySubject {
  readonly actor: Actor | null;
  readonly input: unknown;
  /** The loaded row a row-level rule decides about — never folded into `input`. */
  readonly row?: unknown;
  readonly ctx: Ctx;
  readonly query: string;
}

export function guardQuery(
  policy: QueryPolicy,
  subject: QuerySubject,
  surface: QuerySurface,
): void {
  const { query: name, ...rest } = subject;
  guard(policy, { stage: 'input', name, ...rest }, surface);
}

/** The actor-only half, BEFORE the input parse: refused is 403/401, never `X_INPUT_INVALID`. */
export function guardQueryBeforeInput(
  policy: QueryPolicy,
  subject: Omit<QuerySubject, 'input' | 'row'>,
  surface: QuerySurface,
): void {
  guard(
    policy,
    { stage: 'actor', name: subject.query, actor: subject.actor, ctx: subject.ctx },
    surface,
  );
}

function guard(policy: QueryPolicy, subject: GuardSubject, surface: QuerySurface): void {
  const refused = guardPrimitive('query', policy, subject, surface);
  if (refused !== undefined) throw new QueryDeniedError(refused);
}
