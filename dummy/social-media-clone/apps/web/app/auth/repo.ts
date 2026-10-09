// Every read and write the auth slice makes of the app's own tables. No rules here — `service.ts`
// decides what to do, this file decides how to ask. Credentials and sessions are `@ultimat3/auth`'s
// (`auth.ts`); only this file may import `db` in the auth slice.

import { db, type User } from '@social-media-clone/db';

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

/**
 * The auth user a handle names — `defineAuth({ handles })`'s lookup. The auth user carries the
 * `users` row's id, so the id IS the link. `null` for nobody, and for an account that may no longer
 * act: a soft-deleted user is not a handle anyone signs in as.
 */
export const userIdByHandle = async (handle: string): Promise<string | null> => {
  const user = await userByHandle(handle);
  return user === null || user.deletedAt !== null ? null : user.id;
};

export const userByEmail = (email: string): Promise<User | null> => db.users.where({ email }).one();

export interface NewUser {
  readonly id: string;
  readonly handle: string;
  readonly email: string;
  readonly displayName: string;
}

export const insertUser = (values: NewUser): Promise<User> =>
  db.users.insert({ ...values, role: 'member' });

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
