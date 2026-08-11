/** A comment on a post. Cascades with its post; carries the tenant column of its own. */

import { entity, invariant, text, timestamp, uuid } from '@ultimat3/entity';
import { members } from './members';
import { orgs } from './orgs';
import { posts } from './posts';

export const COMMENT_MAX = 2000;

export const comments = entity('comments', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id, { onDelete: 'cascade' })
      .tenant(),
    postId: uuid().references(() => posts.id, { onDelete: 'cascade' }),
    authorId: uuid().references(() => members.id, { onDelete: 'restrict' }),
    body: text({ max: COMMENT_MAX }),
    createdAt: timestamp().defaultNow(),
  },
  invariants: (c) => [invariant('comment_body_present', c.body.trimmed().minLength(1))],
  indexes: [{ on: ['postId', 'createdAt'] }],
});

export type Comment = typeof comments.$row;
