// A like. Deliberately keyless apart from the pair: that composite primary key is what makes a
// like replayed from the offline queue idempotent AT THE STORAGE LAYER, rather than idempotent
// because the client remembered to de-duplicate. Replay is the normal case here, not the edge.

import { entity, timestamp, uuid } from '@ultimat3/entity';
import { posts } from './posts';
import { users } from './users';

export const likes = entity('likes', {
  columns: {
    postId: uuid().references(() => posts.id, { onDelete: 'cascade' }),
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp().defaultNow(),
  },
  primaryKey: ['postId', 'userId'],
  // "Everything I liked" reads by user; the primary key only serves the other direction.
  indexes: [{ on: ['userId', 'createdAt'], order: 'desc' }],
});

export type Like = typeof likes.$row;
