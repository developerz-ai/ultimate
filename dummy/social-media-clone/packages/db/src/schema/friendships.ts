// A friend request and its answer. Directional on purpose — who asked is part of the fact, and a
// symmetric table would lose it — but the PAIR is what must be unique, in either direction.

import { FRIENDSHIP_STATUSES, hasRespondedCoherently } from '@social-media-clone/domain';
import { entity, enumerated, invariant, timestamp, uuid } from '@ultimat3/entity';
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
    invariant(
      'friendship_responded_coherent',
      c.satisfies(hasRespondedCoherently, ['status', 'respondedAt']),
    ),
  ],
  // "Who wants to be my friend" — the inbox, which reads by addressee, not by requester.
  indexes: [{ on: ['addresseeId', 'status'] }],
});

export type Friendship = typeof friendships.$row;
