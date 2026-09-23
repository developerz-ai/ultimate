// A declared channel's policy, asked on subscribe: the params are the input and the row is what
// the channel's own loader answered. Through `@ultimat3/query`'s `guard`, the package's one authz
// seam — the same call `policy-gate.ts` makes for a live query.

import { type Actor, type Ctx, createContext, runWithContext } from '@ultimat3/core';
import { guard, QueryDeniedError } from '@ultimat3/query';
import type { Channel } from './channel-decl';
import { TopicForbiddenError } from './errors';

/**
 * A denial is `X_TOPIC_FORBIDDEN`. A loader or a rule that RAISED is not a denial and leaves as it
 * came, so the caller can tell an outage from a decision — `onActorChange` keeps the topic on one.
 */
export async function authorizeChannel(
  channel: Channel,
  ctx: Ctx,
  actor: Actor | null,
  topic: string,
  params: Readonly<Record<string, string>>,
): Promise<void> {
  // The loader and the rule run AS the subscriber, never as the node. Under the node's context — no
  // actor, no tenant — a repository read inside the loader was scoped by nothing but what the
  // loader happened to name, and `@ultimat3/entity`'s tenancy seam had no actor to hold it to.
  // Services are rebuilt for this actor by `createContext`, the rule `withChildContext` follows.
  const scoped = actor === null ? ctx : subscriberContext(ctx, actor);
  const row =
    channel.row === undefined
      ? null
      : await runWithContext(scoped, async () => await channel.row?.({ params, ctx: scoped }));
  try {
    guard(channel.policy, { actor, input: params, row, ctx: scoped, query: channel.name }, 'live');
  } catch (error) {
    if (!(error instanceof QueryDeniedError)) throw error;
    throw new TopicForbiddenError({
      topic,
      actorId: actor === null ? null : actor.id,
      reason: `channel "${channel.name}" policy denied the subscribe`,
    });
  }
}

/** The node's context, re-made for one subscriber: same deploy, role and clock, their actor. */
function subscriberContext(node: Ctx, actor: Actor): Ctx {
  return createContext({
    actor,
    role: node.role,
    buildId: node.buildId,
    clock: node.clock,
    locale: node.locale,
    tz: node.tz,
  });
}
