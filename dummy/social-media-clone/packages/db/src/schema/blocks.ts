// A block. Stored directionally, applied symmetrically: if either person blocked the other,
// neither sees the other's content. Every visibility decision consults this before anything else,
// so it is deliberately the cheapest possible row — two ids and a timestamp.

import { entity, timestamp, uuid } from '@ultimat3/entity';
import { users } from './users';

export const blocks = entity('blocks', {
  columns: {
    blockerId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    blockedId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp().defaultNow(),
  },
  primaryKey: ['blockerId', 'blockedId'],
  /**
   * Indexed on the reverse direction too. The forward direction comes free with the primary key,
   * but "who has blocked me" is the half a viewer's own feed needs, and without this it is a scan
   * on every request — the query that runs most often is the one the primary key does not serve.
   */
  indexes: [{ on: ['blockedId'] }],
});

export type Block = typeof blocks.$row;
