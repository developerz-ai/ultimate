// A declared channel's policy, asked on subscribe: the params are the input and the row is what
// the channel's own loader answered. Through `@ultimat3/query`'s `guardQuery`, the package's one
// authz seam — the same call `policy-gate.ts` makes for a live query.

import { type Actor, type Ctx, ctxOf, runWithContext } from '@ultimat3/core';
import { guardQuery, QueryDeniedError } from '@ultimat3/query';
import type { Channel } from './channel-decl';
import { isTenancyDenial, TopicForbiddenError } from './errors';

/**
 * A denial is `X_TOPIC_FORBIDDEN`. A loader or a rule that RAISED is not a denial and leaves as it
 * came, so the caller can tell an outage from a decision — `onActorChange` suspends the topic on one.
 *
 * Two answers are denials before any rule runs, because neither is an outage:
 * - **nobody, on a channel that decides on a row.** A loader runs AS the subscriber; with no actor
 *   it would run as the node, and a row is not something nobody is entitled to.
 * - **a loader the tenant guard refused** (`TENANCY_DENIAL_CODES`): the actor has no org, or names
 *   another one. That is the verdict about a removed member, not a store that could not answer.
 */
export async function authorizeChannel(
  channel: Channel,
  ctx: Ctx,
  actor: Actor | null,
  topic: string,
  params: Readonly<Record<string, string>>,
): Promise<void> {
  const loader = channel.row;
  if (loader === undefined) return decide(channel, ctx, actor, topic, params, null);
  if (actor === null) {
    throw new TopicForbiddenError({
      topic,
      actorId: null,
      reason: `channel "${channel.name}" decides on a row, and an anonymous socket has no actor to load one as`,
    });
  }
  // The loader and the rule run AS the subscriber, never as the node. Services are rebuilt for
  // this actor by `ctxOf`, the rule `withChildContext` follows.
  const scoped = subscriberContext(ctx, actor);
  let row: unknown;
  try {
    row = await runWithContext(scoped, async () => await loader({ params, ctx: scoped }));
  } catch (error) {
    if (!isTenancyDenial(error)) throw error;
    throw new TopicForbiddenError({
      topic,
      actorId: actor.id,
      reason: `channel "${channel.name}" reads a row outside this actor's tenant`,
    });
  }
  decide(channel, scoped, actor, topic, params, row);
}

function decide(
  channel: Channel,
  ctx: Ctx,
  actor: Actor | null,
  topic: string,
  params: Readonly<Record<string, string>>,
  row: unknown,
): void {
  try {
    guardQuery(channel.policy, { actor, input: params, row, ctx, query: channel.name }, 'live');
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
  return ctxOf({
    actor,
    role: node.role,
    buildId: node.buildId,
    clock: node.clock,
    locale: node.locale,
    tz: node.tz,
  });
}
