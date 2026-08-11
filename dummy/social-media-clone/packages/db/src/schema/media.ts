// An uploaded image or video. `postId` is nullable, and that is the whole design: the bytes are
// uploaded BEFORE the post exists, so a row starts unattached and is claimed when the post is
// created. Requiring a post here would force the client to create the post first and then fail
// halfway through an upload with a published post nobody meant to publish.

import { MEDIA_KINDS, MEDIA_STATES } from '@social-media-clone/domain';
import { entity, enumerated, integer, invariant, text, timestamp, uuid } from '@ultimat3/entity';
import { posts } from './posts';
import { users } from './users';

export const media = entity('media', {
  columns: {
    id: uuid().primaryKey(),
    /** Null until the post that owns it is created. See `state`. */
    postId: uuid()
      .references(() => posts.id, { onDelete: 'cascade' })
      .nullable(),
    ownerId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    /** A storage key, never a URL — the bucket and the CDN host are deploy config, not data. */
    key: text({ max: 512 }).unique(),
    kind: enumerated(MEDIA_KINDS),
    /** Sniffed from the bytes on arrival, never trusted from the client's Content-Type. */
    contentType: text({ max: 128 }),
    bytes: integer(),
    width: integer().nullable(),
    height: integer().nullable(),
    /**
     * `pending` → `attached` → (`orphan`). A state column rather than an inference from
     * `postId IS NULL`, because "waiting to be claimed" and "abandoned" are different facts and
     * the hourly sweep must be able to tell them apart without guessing from a timestamp.
     */
    state: enumerated(MEDIA_STATES).default('pending'),
    createdAt: timestamp().defaultNow(),
  },
  invariants: (c) => [
    invariant('media_bytes_positive', c.bytes.atLeast(1)),
    invariant('media_key_unique', c.unique(['key'])),
  ],
  indexes: [
    { on: ['postId'] },
    // The orphan sweep's exact access path: oldest pending first, and only pending rows in the index.
    { on: ['createdAt'], where: (c) => c.state.eq('pending') },
  ],
});

export type Media = typeof media.$row;
