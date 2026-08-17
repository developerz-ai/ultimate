// Every read and write the messages feature makes. No business rules here — the service decides
// what to do, this file decides how to ask. Only this file and a query's `sql` may touch `db`; a
// route or a component importing it is X_BOUNDARY_VIOLATION.

import { db, type schema } from '@social-media-clone/db';
import type { ThreadRow } from './policy';

// Derived from the entities, never re-declared. `@social-media-clone/db`'s index re-exports the
// row types for posts and friends but not yet for chat (packages/db/src/index.ts:11), and that
// file belongs to another slice — so the derivation goes through the `schema` namespace it does
// export. Rename a column and this breaks here, which is the whole point of the chain.
export type Conversation = typeof schema.conversations.$row;
export type Message = typeof schema.messages.$row;
export type Participant = typeof schema.participants.$row;

/** One page is bounded everywhere, so no read here can degrade into a table scan. */
export const THREAD_PAGE = 50;
const MEMBERS_MAX = 100;
const THREADS_MAX = 50;

/**
 * The authorization fact, loaded once per surface call and handed to the synchronous predicate.
 * Returns a row even when the conversation does not exist — an empty participant set denies, and
 * denying identically for "absent" and "not yours" is what stops the id space being enumerable.
 */
export const threadRowOf = async (conversationId: string): Promise<ThreadRow> => ({
  conversationId,
  participantIds: (await membersOf(conversationId)).map((member) => member.userId),
});

export const membersOf = (conversationId: string): Promise<readonly Participant[]> =>
  db.participants.where({ conversationId }).orderBy('userId').limit(MEMBERS_MAX).all();

/**
 * The members of many conversations, grouped — one statement for a whole thread list.
 *
 * `threadsFor` asked `membersOf` once per conversation, so a list of 50 threads was 50 statements
 * before it had rendered a single name. Bounded by the same two caps the per-thread calls carry:
 * at most `THREADS_MAX` conversations, at most `MEMBERS_MAX` rows each.
 */
export const membersOfMany = async (
  conversationIds: readonly string[],
): Promise<ReadonlyMap<string, readonly Participant[]>> => {
  const ids = [...new Set(conversationIds)].slice(0, THREADS_MAX);
  const grouped = new Map<string, Participant[]>();
  if (ids.length === 0) return grouped;
  const rows = await db.participants
    .andWhere('conversationId', 'in', ids)
    .orderBy('conversationId')
    .orderBy('userId')
    .limit(ids.length * MEMBERS_MAX)
    .all();
  for (const row of rows) {
    const bucket = grouped.get(row.conversationId);
    if (bucket === undefined) grouped.set(row.conversationId, [row]);
    else bucket.push(row);
  }
  return grouped;
};

export const membershipsOf = (userId: string): Promise<readonly Participant[]> =>
  db.participants.where({ userId }).orderBy('conversationId').limit(THREADS_MAX).all();

export const conversationsByIds = async (
  ids: readonly string[],
): Promise<readonly Conversation[]> =>
  ids.length === 0
    ? []
    : db.conversations
        .andWhere('id', 'in', [...ids])
        .orderBy('id')
        .limit(THREADS_MAX)
        .all();

/**
 * One page of a thread, newest first.
 *
 * Ordered `(createdAt desc, id)` and bounded, and the tail key is not decoration: a live matcher
 * decides a row's position from the sort keys alone, so `createdAt` on its own is a partial order
 * and two messages sent in the same millisecond can swap between evaluations — which makes a
 * bounded page silently drop or repeat one at its boundary. The entity carries the matching index
 * (`packages/db/src/schema/messages.ts:19`).
 */
export const threadPage = (
  conversationId: string,
  limit: number = THREAD_PAGE,
): Promise<readonly Message[]> =>
  db.messages
    .where({ conversationId })
    .orderBy('createdAt', 'desc')
    .orderBy('id')
    .limit(limit)
    .all();

/**
 * The ceiling on one name lookup: everyone in every thread of one list. The bound that matters is
 * the caller's own — its ids come from `membersOf` (≤ MEMBERS_MAX) over `membershipsOf`
 * (≤ THREADS_MAX) — and this is the worst case those two allow.
 */
const NAMES_MAX = THREADS_MAX * MEMBERS_MAX;

/**
 * Display names for a set of ids. A screen never renders a bare uuid at a person: the id is the
 * authorization fact, the name is what a reader is owed.
 *
 * Bounded by how many ids were asked about, not by `MEMBERS_MAX`: a thread list unions the members
 * of up to 50 conversations into one call, and a fixed 100 answered for the first hundred and left
 * the rest nameless — `otherNames` drops a name it cannot find, silently.
 */
export const displayNamesOf = async (
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.users
    .andWhere('id', 'in', unique)
    .orderBy('id')
    .limit(Math.min(unique.length, NAMES_MAX))
    .all();
  return new Map(rows.map((user) => [user.id, user.displayName]));
};

export const latestMessage = (conversationId: string): Promise<Message | null> =>
  db.messages.where({ conversationId }).orderBy('createdAt', 'desc').orderBy('id').limit(1).one();

export interface NewMessage {
  readonly conversationId: string;
  readonly authorId: string;
  readonly body: string;
}

/**
 * `id` and `createdAt` are left to the column defaults. A blank body is refused HERE, by the
 * entity's `message_body_present` invariant — one declaration, enforced in the app on every write
 * and as a Postgres CHECK, rather than a `body.trim()` guard that only one of the two paths runs.
 */
export const insertMessage = (message: NewMessage): Promise<Message> => db.messages.insert(message);

/**
 * Adding someone who is already in the thread is a no-op, not a collision: `onMatch: 'nothing'`
 * rather than `update`, because the stored row carries `joinedAt` and `lastReadAt` and re-adding a
 * member must not move either — it would mark a read thread unread. The composite key is why this
 * cannot be `insert`: an insert on an existing pair overwrites in memory and is `23505` on Postgres.
 */
export const addParticipant = async (conversationId: string, userId: string): Promise<void> => {
  // `void`: `onMatch: 'nothing'` omits a row it left alone, so returning "the row, unless it was
  // already there" would mean a second read for a value no caller uses.
  await db.participants.upsertAll([{ conversationId, userId }], {
    onConflict: ['conversationId', 'userId'],
    onMatch: 'nothing',
  });
};
