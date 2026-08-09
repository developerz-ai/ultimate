/**
 * A like. Deliberately keyless apart from `(postId, memberId)`: that composite primary key is
 * what makes a `likePost` replayed from the offline queue idempotent at the storage layer,
 * rather than idempotent because the client remembered to de-duplicate.
 */

import { entity, timestamp, uuid } from '@ultimat3/entity';
import { members } from './members';
import { orgs } from './orgs';
import { posts } from './posts';

export const likes = entity('likes', {
  columns: {
    orgId: uuid()
      .references(() => orgs.id, { onDelete: 'cascade' })
      .tenant(),
    postId: uuid().references(() => posts.id, { onDelete: 'cascade' }),
    memberId: uuid().references(() => members.id, { onDelete: 'cascade' }),
    createdAt: timestamp().defaultNow(),
  },
  primaryKey: ['postId', 'memberId'],
  indexes: [{ on: ['memberId'] }],
});

export type Like = typeof likes.$row;
