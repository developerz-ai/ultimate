// Every read and write the friends feature makes. No business rules here — the service decides what
// to do, this file decides how to ask. Only this file may touch `db`; a route or a component
// importing it is X_BOUNDARY_ROUTE_TO_DB.
//
// The inbox reads by `addresseeId` and the outbox by `requesterId`, and that asymmetry is the
// point: who asked is part of the fact, so one symmetric query would have to invent it back.

import { type Block, db, type Friendship, type User } from '@social-media-clone/db';

/** Bounded by default. An unbounded read of a social graph is a table scan waiting for a popular user. */
const PAGE = 100;

export type { Block, Friendship, User };

export const personById = (id: string): Promise<User | null> => db.users.where({ id }).one();

export const personByHandle = (handle: string): Promise<User | null> =>
  db.users.where({ handle }).one();

/** One read for every name a screen renders, keyed for the caller. Never one query per row. */
export const peopleByIds = async (ids: readonly string[]): Promise<ReadonlyMap<string, User>> => {
  if (ids.length === 0) return new Map();
  const rows = await db.users
    .andWhere('id', 'in', [...new Set(ids)])
    .limit(PAGE)
    .all();
  return new Map(rows.map((user) => [user.id, user]));
};

/**
 * "Who wants to be my friend" — the index on `(addresseeId, status)` exists for exactly this.
 * Newest first, and the composite primary key is appended as the tail sort key by the query plan,
 * so the order is total and a bounded page cannot drop or repeat a row at its boundary.
 */
export const inbox = (userId: string): Promise<readonly Friendship[]> =>
  db.friendships.where({ addresseeId: userId }).orderBy('createdAt', 'desc').limit(PAGE).all();

export const outbox = (userId: string): Promise<readonly Friendship[]> =>
  db.friendships.where({ requesterId: userId }).orderBy('createdAt', 'desc').limit(PAGE).all();

/** One direction, addressed by the composite key. `null` means the row is not there — never a pass. */
export const friendshipEdge = (
  requesterId: string,
  addresseeId: string,
): Promise<Friendship | null> => db.friendships.where({ requesterId, addresseeId }).one();

/**
 * The composite key IS the upsert: writing `(a→b)` twice replaces the row rather than adding one,
 * so answering a request and re-answering it land on the same fact. It is also the only write path
 * available — `Table.update(id, …)` is id-addressed and refuses a two-column key.
 */
export const saveFriendship = (row: Friendship): Promise<Friendship> => db.friendships.insert(row);

export const blocksBy = (blockerId: string): Promise<readonly Block[]> =>
  db.blocks.where({ blockerId }).orderBy('createdAt', 'desc').limit(PAGE).all();

export const blockEdge = (blockerId: string, blockedId: string): Promise<Block | null> =>
  db.blocks.where({ blockerId, blockedId }).one();

export const saveBlock = (row: Block): Promise<Block> => db.blocks.insert(row);
