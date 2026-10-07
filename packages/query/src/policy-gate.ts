/**
 * The single point of contact with @ultimat3/policy. A live query evaluates its
 * policy **per subscriber**, never once at subscribe time for everyone — so this
 * gate is called on every fanout decision and its result is never cached.
 */

import type { Actor, Ctx } from '@ultimat3/core';
import { assertNever } from '@ultimat3/core';
import type { Policy, Surface as PolicySurface } from '@ultimat3/policy';
import { enforce, enforceBeforeInput } from '@ultimat3/policy';
import { QueryDeniedError } from './errors';

/** Policies are opaque here: we evaluate them, we never introspect their rules. */
export type QueryPolicy = Policy<unknown>;

/**
 * Where a read came from. `'mcp'` is an agent's tool call — named so a declared `rateLimit:`
 * spends for it (`'server'`, in-process app code, does not) — and is judged by the policy exactly
 * as `'server'` always judged it, so no MCP read's authz answer moved.
 */
export type QuerySurface = 'server' | 'http' | 'live' | 'mcp';

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

export function guardQuery(
  policy: QueryPolicy,
  subject: QuerySubject,
  surface: QuerySurface,
): void {
  const denial = enforce(policySurface(surface), policy, {
    input: subject.input,
    actor: subject.actor,
    row: subject.row,
    ctx: subject.ctx,
  });
  if (denial !== undefined) throw new QueryDeniedError(subject.query, denial);
}

/**
 * The actor-only half of `guardQuery`, run BEFORE the input is parsed — the twin of
 * `@ultimat3/action`'s. A reader the policy refuses whatever they send is answered 403 (or 401),
 * never `X_INPUT_INVALID` with the read's input schema in it. Undecided passes to `guardQuery`.
 */
export function guardQueryBeforeInput(
  policy: QueryPolicy,
  subject: Omit<QuerySubject, 'input' | 'row'>,
  surface: QuerySurface,
): void {
  const denial = enforceBeforeInput(policySurface(surface), policy, {
    actor: subject.actor,
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
    case 'mcp':
      return 'job';
    default:
      return assertNever(surface);
  }
}
