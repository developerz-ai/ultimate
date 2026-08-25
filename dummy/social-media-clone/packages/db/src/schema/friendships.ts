// A friend request and its answer. Directional on purpose — who asked is part of the fact, and a
// symmetric table would lose it — but the PAIR is what must be unique, in either direction.

import { FRIENDSHIP_STATUSES } from '@social-media-clone/domain';
import { entity, enumerated, iff, invariant, timestamp, uuid } from '@ultimat3/entity';
import { users } from './users';

export const friendships = entity('friendships', {
  columns: {
    requesterId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    addresseeId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    status: enumerated(FRIENDSHIP_STATUSES).default('pending'),
    /** Null exactly while `pending`. The invariant below is what keeps that true. */
    respondedAt: timestamp().nullable(),
    createdAt: timestamp().defaultNow(),
  },
  /**
   * The composite key IS the idempotency mechanism: sending the same request twice is a no-op at
   * the storage layer rather than a duplicate row the app has to remember to look for.
   *
   * It does NOT stop the mirror row — (a→b) and (b→a) are different keys. That is a real hole and
   * the service closes it by always reading both directions before inserting; a partial unique
   * index cannot express "either order" without a generated column, and inventing one here would
   * hide the rule in the schema instead of stating it where the write happens.
   */
  primaryKey: ['requesterId', 'addresseeId'],
  invariants: (c) => [
    /**
     * `iff`, not `c.satisfies(hasRespondedCoherently, …)`. A JS predicate reports `sql: null`, so
     * this table had NO such constraint in Postgres while both the declaration and the domain
     * helper's own comment read as though it did — a row inserted by a migration, a seed or a psql
     * session could contradict it freely. This renders
     * `(status = 'pending') = (responded_at is null)`.
     */
    invariant('friendship_responded_coherent', iff(c.status.eq('pending'), c.respondedAt.isNull())),
  ],
  // "Who wants to be my friend" — the inbox, which reads by addressee, not by requester.
  indexes: [{ on: ['addresseeId', 'status'] }],
});

export type Friendship = typeof friendships.$row;
