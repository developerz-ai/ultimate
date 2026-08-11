// Every read and write the auth slice makes. No rules here — `service.ts` decides what to do,
// this file decides how to ask. Only this file may import `db` in the auth slice.

import { db, type schema, type User } from '@social-media-clone/db';

/**
 * Derived rather than imported: `@social-media-clone/db`'s index re-exports `User` and five other
 * row types by name but not `Session` (`packages/db/src/index.ts:11`), and that package is not
 * this slice's to edit. `schema` is the namespace it does export, so the row type still comes from
 * the entity declaration and cannot drift from the columns.
 */
type Session = typeof schema.sessions.$row;

/**
 * Explicit bounds on every graph read, because the builder's default limit is 50
 * (`packages/entity/src/query.ts:47`) — an unbounded-looking `.all()` silently truncates the
 * friend set at fifty, and a truncated friend set is a friends-only post that vanishes for no
 * visible reason. A viewer past this bound is a product decision, not a query that quietly lies.
 */
export const GRAPH_LIMIT = 5000;

export const userByHandle = (handle: string): Promise<User | null> =>
  db.users.where({ handle }).one();

export const userById = (id: string): Promise<User | null> => db.users.where({ id }).one();

export const credentialFor = (userId: string): Promise<{ passwordHash: string } | null> =>
  db.credentials.where({ userId }).select({ passwordHash: true }).one();

export const putCredential = async (userId: string, passwordHash: string): Promise<void> => {
  await db.credentials.insert({ userId, passwordHash });
};

export interface NewUser {
  readonly handle: string;
  readonly email: string;
  readonly displayName: string;
}

export const insertUser = (values: NewUser): Promise<User> =>
  db.users.insert({ ...values, role: 'member' });

export interface NewSession {
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export const insertSession = (values: NewSession): Promise<Session> => db.sessions.insert(values);

/** By hash, never by token: the token is not stored, so there is nothing here to compare against. */
export const sessionByTokenHash = (tokenHash: string): Promise<Session | null> =>
  db.sessions.where({ tokenHash }).one();

export const deleteSession = (id: string): Promise<void> => db.sessions.delete(id);

/**
 * Accepted friendships, in BOTH directions. The row is directional because who asked is part of
 * the fact, but friendship is not — so the two queries are unioned here rather than at each of the
 * call sites that would otherwise have to remember there are two.
 */
export const acceptedFriendIds = async (userId: string): Promise<readonly string[]> => {
  const [asRequester, asAddressee] = await Promise.all([
    db.friendships
      .where({ requesterId: userId, status: 'accepted' })
      .limit(GRAPH_LIMIT)
      .select({ addresseeId: true })
      .all(),
    db.friendships
      .where({ addresseeId: userId, status: 'accepted' })
      .limit(GRAPH_LIMIT)
      .select({ requesterId: true })
      .all(),
  ]);
  return [
    ...asRequester.map((row) => row.addresseeId),
    ...asAddressee.map((row) => row.requesterId),
  ];
};

/**
 * Everyone this user blocked AND everyone who blocked them, in one list.
 *
 * A block is stored one way and applied both ways. Unioning here is what lets `isBlocked` stay a
 * single set lookup inside a synchronous policy predicate — the alternative is every predicate
 * remembering to check the reverse, which is a predicate that will forget in exactly one place.
 */
export const blockedIdsBothWays = async (userId: string): Promise<readonly string[]> => {
  const [placed, received] = await Promise.all([
    db.blocks.where({ blockerId: userId }).limit(GRAPH_LIMIT).select({ blockedId: true }).all(),
    db.blocks.where({ blockedId: userId }).limit(GRAPH_LIMIT).select({ blockerId: true }).all(),
  ]);
  return [...placed.map((row) => row.blockedId), ...received.map((row) => row.blockerId)];
};
