// Business logic for chat, composed from the repo. A page calls this; it never calls the repo and
// it never sees `db`.
//
// Every entry point takes the viewer's id and refuses before it reads anything a non-participant
// must not learn — including whether the conversation exists at all.

import { NotAParticipantError } from './errors';
import { isParticipant } from './policy';
import type { Message } from './repo';
import * as repo from './repo';

/** One row of the conversation list. */
export interface ThreadSummary {
  readonly conversationId: string;
  readonly kind: 'direct' | 'group';
  /** Null for a direct thread: its name is whoever else is in it. */
  readonly title: string | null;
  /** Everyone but the viewer, by display name. A direct thread has exactly one. */
  readonly otherNames: readonly string[];
  readonly latest: Message | null;
  /**
   * Derived from the participants row, never stored: `lastReadAt` is null until the thread is
   * opened, so a thread with any message at all reads as unread.
   */
  readonly unread: boolean;
}

export interface Thread {
  readonly conversationId: string;
  readonly title: string | null;
  readonly participantIds: readonly string[];
  /** Display name per participant id, so a byline is never a bare uuid. */
  readonly namesById: ReadonlyMap<string, string>;
  /** Newest first, exactly as the live query and the index order it. */
  readonly messages: readonly Message[];
}

/**
 * Every thread the viewer is in, most recently active first.
 *
 * The members and the names are read for the WHOLE list, not per thread. This loop used to make
 * three round trips per conversation — members, latest message, names — so a 50-thread list was
 * ~152 statements to render one screen, and every one of them waited for the one before it. Only
 * `latestMessage` is still per thread: "the newest row per group" is not something the query
 * builder can express in one statement, and reading N messages across every thread to find them
 * would be one chatty conversation's page and nothing else's.
 */
export const threadsFor = async (viewerId: string): Promise<readonly ThreadSummary[]> => {
  const memberships = await repo.membershipsOf(viewerId);
  const conversationIds = memberships.map((membership) => membership.conversationId);
  const [conversations, membersByConversation] = await Promise.all([
    repo.conversationsByIds(conversationIds),
    repo.membersOfMany(conversationIds),
  ]);
  const otherIdsOf = (conversationId: string): readonly string[] =>
    (membersByConversation.get(conversationId) ?? [])
      .map((row) => row.userId)
      .filter((id) => id !== viewerId);
  // One name lookup for the whole screen, from the members the call above already resolved.
  const names = await repo.displayNamesOf(
    conversations.flatMap((conversation) => otherIdsOf(conversation.id)),
  );
  const summaries: ThreadSummary[] = [];
  for (const conversation of conversations) {
    const membership = memberships.find((row) => row.conversationId === conversation.id);
    if (membership === undefined) continue;
    const latest = await repo.latestMessage(conversation.id);
    const otherIds = otherIdsOf(conversation.id);
    summaries.push({
      conversationId: conversation.id,
      kind: conversation.kind,
      title: conversation.title,
      otherNames: otherIds.map((id) => names.get(id)).filter((name) => name !== undefined),
      latest,
      unread: isUnread(latest, membership.lastReadAt),
    });
  }
  // Newest activity first; a thread nobody has written in sorts by its own id so the order is
  // total and two empty threads cannot swap between renders.
  return [...summaries].sort(compareByActivity);
};

/**
 * One thread. Throws `X_NOT_A_PARTICIPANT` before touching the messages table — the refusal is the
 * same for a conversation that does not exist, so the id space stays unenumerable.
 */
export const threadFor = async (
  viewerId: string | null,
  conversationId: string,
): Promise<Thread> => {
  const row = await repo.threadRowOf(conversationId);
  if (!isParticipant(viewerId, row)) {
    throw new NotAParticipantError({ conversationId, actorId: viewerId });
  }
  const conversations = await repo.conversationsByIds([conversationId]);
  return {
    conversationId,
    title: conversations[0]?.title ?? null,
    participantIds: row.participantIds,
    namesById: await repo.displayNamesOf(row.participantIds),
    messages: await repo.threadPage(conversationId),
  };
};

const isUnread = (latest: Message | null, lastReadAt: Date | null): boolean =>
  latest !== null && (lastReadAt === null || latest.createdAt > lastReadAt);

const compareByActivity = (left: ThreadSummary, right: ThreadSummary): number => {
  const a = left.latest?.createdAt.getTime() ?? 0;
  const b = right.latest?.createdAt.getTime() ?? 0;
  return b === a ? left.conversationId.localeCompare(right.conversationId) : b - a;
};
