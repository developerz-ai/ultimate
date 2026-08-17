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

/** The union `friendsScreen` asks for: three PAGE-bounded lists — inbox, outbox, blocks. */
const PEOPLE_MAX = PAGE * 3;

/**
 * One read for every name a screen renders, keyed for the caller. Never one query per row.
 *
 * The bound is the caller's own id list, not `PAGE`. `friendsScreen` unions those three lists into
 * ONE call, so up to 300 ids arrived at a `limit(100)` and the other 200 were dropped with no error
 * anywhere: `viewOf` cannot find those people, returns null, and the rows vanish off the screen. A
 * screen silently missing two thirds of its rows is worse than a slow one.
 */
export const peopleByIds = async (ids: readonly string[]): Promise<ReadonlyMap<string, User>> => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.users
    .andWhere('id', 'in', unique)
    .limit(Math.min(unique.length, PEOPLE_MAX))
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
 * Writing `(a→b)` twice replaces the row rather than adding one, so asking, answering and
 * re-answering all land on the same fact. `upsertAll`, not `insert`: an insert on an existing
 * primary key is an overwrite ONLY in the memory driver — Postgres answers `23505` — and every
 * caller here writes a row the pair may already have. It is also the only write path available:
 * `Table.update(id, …)` is id-addressed and refuses a two-column key.
 */
export const saveFriendship = async (row: Friendship): Promise<Friendship> => {
  const [written] = await db.friendships.upsertAll([row], {
    onConflict: ['requesterId', 'addresseeId'],
  });
  // `upsertAll` resolves with the rows it wrote; `onMatch` defaults to `update`, so there is one.
  return written ?? row;
};

export const blocksBy = (blockerId: string): Promise<readonly Block[]> =>
  db.blocks.where({ blockerId }).orderBy('createdAt', 'desc').limit(PAGE).all();

export const blockEdge = (blockerId: string, blockedId: string): Promise<Block | null> =>
  db.blocks.where({ blockerId, blockedId }).one();

/** Same shape, same reason as `saveFriendship`: blocking twice is one row, on either driver. */
export const saveBlock = async (row: Block): Promise<Block> => {
  const [written] = await db.blocks.upsertAll([row], { onConflict: ['blockerId', 'blockedId'] });
  return written ?? row;
};

/**
 * Lift a block. `deleteWhere` is the only way to remove a composite-key row — `Table.delete(id)`
 * cannot name one — and it answers with a count rather than throwing, so "there was no block"
 * reaches the service as `0` and not as an error about a row nobody asked to exist.
 */
export const removeBlock = (blockerId: string, blockedId: string): Promise<number> =>
  db.blocks.deleteWhere({ blockerId, blockedId });
