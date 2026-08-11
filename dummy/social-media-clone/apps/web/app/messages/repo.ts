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
 * Display names for a set of ids. A screen never renders a bare uuid at a person: the id is the
 * authorization fact, the name is what a reader is owed.
 */
export const displayNamesOf = async (
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> => {
  if (ids.length === 0) return new Map();
  const rows = await db.users
    .andWhere('id', 'in', [...ids])
    .orderBy('id')
    .limit(MEMBERS_MAX)
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

export const addParticipant = (conversationId: string, userId: string): Promise<Participant> =>
  db.participants.insert({ conversationId, userId });
