// The chat channel: one topic per conversation, and the guard that decides who may join it.
//
// This is where membership is checked for real. A `TopicGuard` is ASYNC — unlike a policy
// predicate — so it may load the participants row the synchronous rule needs, which makes tier 1
// the one realtime surface in this app that can enforce chat authorization end to end today.

import type { ChannelHub, Topic, TopicGuard } from '@ultimat3/realtime';
import { topic } from '@ultimat3/realtime';
import { isParticipant } from './policy';
import * as repo from './repo';

/** `messages.<conversationId>`. Segments are validated by `topic()`, never escaped. */
export const CONVERSATION_PATTERN = 'messages.*';

export const conversationTopic = (conversationId: string): Topic =>
  topic('messages', conversationId);

/**
 * Deny by default is the hub's rule; this guard is what turns "declared" into "correct". It
 * refuses a signed-out socket, a malformed topic and a non-participant with three distinct
 * reasons, because a socket told only "forbidden" cannot tell a bug from a policy.
 */
export const conversationGuard: TopicGuard = async ({ actor, segments }) => {
  const conversationId = segments[1];
  if (conversationId === undefined) {
    return { allowed: false, reason: 'topic names no conversation' };
  }
  if (actor === null) {
    return { allowed: false, reason: 'a conversation topic has no anonymous audience' };
  }
  const row = await repo.threadRowOf(conversationId);
  return {
    allowed: isParticipant(actor.id, row),
    // Identical for "no such conversation" and "not yours", deliberately: a reason that told the
    // two apart would let a socket enumerate the id space one subscribe at a time.
    reason: `${actor.id} has no participants row for conversation ${conversationId}`,
  };
};

export const guardConversations = (hub: ChannelHub): ChannelHub =>
  hub.guard(CONVERSATION_PATTERN, conversationGuard);
