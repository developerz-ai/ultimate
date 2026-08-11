// A comment. Part of the post aggregate, not a feature of its own — it is read with the post, it
// is invalidated with the post, and its authorization is the post's.

import { BODY_MAX } from '@social-media-clone/domain';
import { entity, invariant, text, timestamp, uuid } from '@ultimat3/entity';
import { posts } from './posts';
import { users } from './users';

export const comments = entity('comments', {
  columns: {
    id: uuid().primaryKey(),
    postId: uuid().references(() => posts.id, { onDelete: 'cascade' }),
    authorId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    body: text({ max: BODY_MAX }),
    /** Presence of this column turns on soft delete: a removed comment leaves its thread readable. */
    deletedAt: timestamp().nullable(),
    createdAt: timestamp().defaultNow(),
  },
  invariants: (c) => [invariant('comment_body_present', c.body.trimmed().minLength(1))],
  /**
   * `(postId, createdAt, id)` — the id is not decoration. A comment thread is a live query, and a
   * live matcher decides a row's position from the sort keys alone; `createdAt` alone is a partial
   * order, so two comments written in the same millisecond can swap places between evaluations and
   * a bounded page silently drops or repeats one at the boundary.
   */
  indexes: [{ on: ['postId', 'createdAt', 'id'] }],
});

export type Comment = typeof comments.$row;
