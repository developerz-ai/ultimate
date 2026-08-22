// The inbox channel: one topic per user, and the guard that decides who may join it.
//
// A notification is addressed to exactly one person, so the topic is scoped to a user id and the
// guard is an identity comparison. No database read is needed — the fact is the topic name itself.

import type { ChannelHub, Topic, TopicGuard } from '@ultimat3/realtime/server';
import { topic } from '@ultimat3/realtime/server';

/** `notifications.<userId>`. */
export const INBOX_PATTERN = 'notifications.*';

export const inboxTopic = (userId: string): Topic => topic('notifications', userId);

/**
 * Your own inbox and nobody else's. An admin is not exempted: `admin:read` is a moderation grant
 * over content, not a licence to watch a person's notifications arrive in real time.
 */
export const inboxGuard: TopicGuard = ({ actor, segments }) => {
  const userId = segments[1];
  if (userId === undefined) return { allowed: false, reason: 'topic names no user' };
  if (actor === null) return { allowed: false, reason: 'an inbox has no anonymous audience' };
  return { allowed: actor.id === userId, reason: `${actor.id} is not ${userId}` };
};

export const guardInboxes = (hub: ChannelHub): ChannelHub => hub.guard(INBOX_PATTERN, inboxGuard);
