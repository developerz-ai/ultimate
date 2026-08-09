// The single seam between realtime and authz. It goes through `@ultimat3/query`'s `guard`, which
// is itself the only point of contact with `@ultimat3/policy` — one authz system, never two, and
// realtime does not get its own opinion about what a decision means.
//
// The row gate turns a denial into "not visible" instead of an error: a row that fails an actor's
// policy is dropped, never sent. That is the rule from the live-query pipeline, implemented once.

import type { Actor, Ctx } from '@ultimat3/core';
import { guard, type QueryPolicy, type QuerySubject } from '@ultimat3/query';
import type { JsonValue, Row } from './json';

export interface GateOptions {
  /** Query name, for the denial reason and the policy trace. */
  readonly query: string;
  readonly ctx: Ctx;
}

/** Subscribe-time gate for `LiveQueryDefinition.authorize`. Throws the policy's denial error. */
export function authorizeWithPolicy(
  policy: QueryPolicy,
  options: GateOptions,
): (args: { actor: Actor | null; input: JsonValue }) => Promise<void> {
  return async (args) => {
    // No row exists yet at subscribe time; `null` says so rather than leaving the predicate
    // to infer it from an absent field.
    await guard(policy, subjectOf(options, args.actor, args.input, null), 'live');
  };
}

/**
 * Row gate for `LiveQueryDefinition.visible`. Called once per subscriber per row — never once per
 * query. The row travels as `row`, the same field an HTTP or job row rule reads: a predicate is
 * written once as `({ actor, row }) => …` and works on every surface.
 */
export function visibleWithPolicy<R extends Row = Row>(
  policy: QueryPolicy,
  options: GateOptions,
): (args: { actor: Actor | null; row: R; input: JsonValue }) => Promise<boolean> {
  return async (args) => {
    try {
      await guard(policy, subjectOf(options, args.actor, args.input, args.row), 'live');
      return true;
    } catch {
      return false;
    }
  };
}

function subjectOf(
  options: GateOptions,
  actor: Actor | null,
  input: unknown,
  row: unknown,
): QuerySubject {
  return { actor, input, row, ctx: options.ctx, query: options.query };
}
