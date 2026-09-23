// A declared channel's policy, asked on subscribe: the params are the input and the row is what
// the channel's own loader answered. Through `@ultimat3/query`'s `guard`, the package's one authz
// seam — the same call `policy-gate.ts` makes for a live query.

import type { Actor, Ctx } from '@ultimat3/core';
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
  if (channel.policy === undefined) return;
  const row = channel.row === undefined ? null : await channel.row({ params, ctx });
  try {
    guard(channel.policy, { actor, input: params, row, ctx, query: channel.name }, 'live');
  } catch (error) {
    if (!(error instanceof QueryDeniedError)) throw error;
    throw new TopicForbiddenError({
      topic,
      actorId: actor === null ? null : actor.id,
      reason: `channel "${channel.name}" policy denied the subscribe`,
    });
  }
}
