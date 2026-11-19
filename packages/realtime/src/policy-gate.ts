// The single seam between realtime and authz. It goes through `@ultimat3/query`'s `guardQuery`,
// which is itself the only point of contact with `@ultimat3/policy` — one authz system, never two,
// and realtime does not get its own opinion about what a decision means.
//
// The row gate turns a denial into "not visible" instead of an error: a row that fails an actor's
// policy is dropped, never sent. That is the rule from the live-query pipeline, implemented once.
// A *denial* only — a gate that could not reach a decision raises, because "denied" and "the
// database is down" are different facts and one of them has to page someone.
// Both gates decide in the SUBSCRIBER's context: `ctx.actor` is who asked, as it is over HTTP.

import { type Actor, anonymousActor, type Ctx, ctxOf } from '@ultimat3/core';
import { guardQuery, QueryDeniedError, type QueryPolicy, type QuerySubject } from '@ultimat3/query';
import type { JsonValue, LiveRow } from './json';

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
    guardQuery(policy, subjectOf(options, args.actor, args.input, null), 'live');
  };
}

/**
 * Row gate for `LiveQueryDefinition.visible`. Called once per subscriber per row — never once per
 * query. The row travels as `row`, the same field an HTTP or job row rule reads: a predicate is
 * written once as `({ actor, row }) => …` and works on every surface.
 */
export function visibleWithPolicy<R extends LiveRow = LiveRow>(
  policy: QueryPolicy,
  options: GateOptions,
): (args: { actor: Actor | null; row: R; input: JsonValue }) => Promise<boolean> {
  return async (args) => {
    try {
      guardQuery(policy, subjectOf(options, args.actor, args.input, args.row), 'live');
      return true;
    } catch (error) {
      // `guardQuery` throws `QueryDeniedError` for a decision and for nothing else, so that class is
      // the whole of "not visible". A rule that reached for a row and timed out throws something
      // else, and answering `false` to it would report an outage as a permission change: the rows
      // leave the subscriber's screen, `live.rows_denied` counts the drop, and no error reaches
      // the node. The registry is the one that decides what a failure costs — see `deliver`.
      if (error instanceof QueryDeniedError) return false;
      throw error;
    }
  };
}

function subjectOf(
  options: GateOptions,
  actor: Actor | null,
  input: unknown,
  row: unknown,
): QuerySubject {
  // Anonymous is the anonymous actor, as over HTTP — never the node's own, which may be a system one.
  const ctx =
    actor === null ? subscriberContext(options.ctx, anonymousActor()) : ctxFor(options.ctx, actor);
  return { actor, input, row, ctx, query: options.query };
}

/**
 * Keyed by the actor OBJECT a socket holds — a re-auth puts a new one there — so no other actor
 * can be answered from it; a row gate runs per subscriber per row, and `ctxOf` builds services.
 */
const contexts = new WeakMap<Ctx, WeakMap<Actor, Ctx>>();

function ctxFor(node: Ctx, actor: Actor): Ctx {
  let byActor = contexts.get(node);
  if (byActor === undefined) {
    byActor = new WeakMap();
    contexts.set(node, byActor);
  }
  const known = byActor.get(actor);
  if (known !== undefined) return known;
  const made = subscriberContext(node, actor);
  byActor.set(actor, made);
  return made;
}

/** The node's context, re-made for one subscriber: same deploy, role and clock, their actor. */
export function subscriberContext(node: Ctx, actor: Actor): Ctx {
  return ctxOf({
    actor,
    role: node.role,
    buildId: node.buildId,
    clock: node.clock,
    locale: node.locale,
    tz: node.tz,
  });
}
