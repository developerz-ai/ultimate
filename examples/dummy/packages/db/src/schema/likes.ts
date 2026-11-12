/**
 * A like. Deliberately keyless apart from `(postId, memberId)`: that composite primary key is
 * what makes a `likePost` replayed from the offline queue idempotent at the storage layer,
 * rather than idempotent because the client remembered to de-duplicate.
 *
 * `posts.likeCount` is kept by the database: a trigger on this table moves it by one in the like's
 * own transaction (`countedIn`), on every path — `upsertAll`, `deleteWhere`, a cascade, raw SQL.
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
    postId: uuid().references(() => posts.id, {
      onDelete: 'cascade',
      countedIn: () => posts.likeCount,
    }),
    memberId: uuid().references(() => members.id, { onDelete: 'cascade' }),
    createdAt: timestamp().defaultNow(),
  },
  primaryKey: ['postId', 'memberId'],
  indexes: [{ on: ['memberId'] }],
});

export type Like = typeof likes.$row;
