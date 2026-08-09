/**
 * The thing the app is about. `likeCount` is denormalised so the feed's live query stays
 * bounded and deterministic; the `toggleLike` mutator owns keeping it true.
 */

import {
  EXCERPT_MAX,
  hasCoherentPublishState,
  isValidSlug,
  POST_STATUSES,
  SLUG_MAX,
  TITLE_MAX,
} from '@postly/domain';
import {
  entity,
  enumerated,
  integer,
  invariant,
  text,
  timestamp,
  url,
  uuid,
} from '@ultimat3/entity';
import { members } from './members';
import { orgs } from './orgs';

export const posts = entity('posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id, { onDelete: 'cascade' })
      .tenant(),
    authorId: uuid().references(() => members.id, { onDelete: 'restrict' }),
    slug: text({ max: SLUG_MAX }),
    title: text({ max: TITLE_MAX }),
    excerpt: text({ max: EXCERPT_MAX }),
    body: text(),
    /** Nullable: a post without a cover renders the generated OG image instead. */
    coverUrl: url().nullable(),
    status: enumerated(POST_STATUSES).default('draft'),
    likeCount: integer().default(0),
    /** Nullable by contract: set exactly when status becomes `published`. */
    publishedAt: timestamp().nullable(),
    createdAt: timestamp().defaultNow(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
  invariants: [
    invariant('post_slug_shape', (c) => c.slug.matches(isValidSlug)),
    /**
     * Global, not per-org. The public blog URL is `/blog/{slug}` with no tenant anywhere in it,
     * and `repo.publishedBySlug` resolves it by slug alone — so a per-org constraint let two orgs
     * publish the same slug and made that page return whichever row the planner reached first.
     * The uniqueness a lookup needs is the uniqueness of the namespace the URL exposes, and that
     * namespace is global. Strictly stronger than the pair it replaces, so nothing that held
     * before stops holding; `createDraft` derives the slug from the title, so a cross-org title
     * collision is now a write that fails loudly instead of a public page that resolves at random.
     */
    invariant('post_slug_unique', (c) => c.unique(['slug'])),
    invariant('post_like_count_non_negative', (c) => c.likeCount.atLeast(0)),
    /** One declaration → one CHECK constraint → one runtime guard. */
    invariant('post_publish_coherent', (c) =>
      c.satisfies(hasCoherentPublishState, ['status', 'publishedAt']),
    ),
  ],
  indexes: [
    /** The feed's exact access path: tenant, then reverse chronological, bounded. */
    { on: ['orgId', 'publishedAt'], order: 'desc', where: (c) => c.status.eq('published') },
    { on: ['authorId'] },
  ],
});

export type Post = typeof posts.$row;
