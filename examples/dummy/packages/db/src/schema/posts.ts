/**
 * The thing the app is about. `likeCount` is denormalised so the feed's live query stays
 * bounded and deterministic; the `likePost` mutator owns keeping it true.
 */

import { EXCERPT_MAX, POST_STATUSES, SLUG_MAX, SLUG_PATTERN, TITLE_MAX } from '@postly/domain';
import {
  entity,
  enumerated,
  iff,
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
  invariants: (c) => [
    /**
     * The PATTERN, not the predicate — `matches(SLUG_PATTERN)` renders `slug ~ '…'` into a real
     * CHECK, where `matches(isValidSlug)` reported `sql: null` and reached no database. One
     * declaration feeds both engines: `pattern.source` is the string `.test()` runs AND the
     * string spliced into the constraint, so the two cannot drift.
     *
     * `isValidSlug`'s `length <= SLUG_MAX` clause is not carried here — `text({ max })` above
     * enforces length in SQL, and `createDraft` still calls `isValidSlug` at its own call site.
     */
    invariant('post_slug_shape', c.slug.matches(SLUG_PATTERN)),
    /**
     * Global, not per-org. The public blog URL is `/blog/{slug}` with no tenant anywhere in it,
     * and `repo.publishedBySlug` resolves it by slug alone — so a per-org constraint let two orgs
     * publish the same slug and made that page return whichever row the planner reached first.
     * The uniqueness a lookup needs is the uniqueness of the namespace the URL exposes, and that
     * namespace is global. Strictly stronger than the pair it replaces, so nothing that held
     * before stops holding; `createDraft` derives the slug from the title, so a cross-org title
     * collision is now a write that fails loudly instead of a public page that resolves at random.
     *
     * **This database does not have it yet**, and since 2026-08-25 that is a finding rather than a
     * note: `0001_init.sql` created `post_slug_unique_per_org UNIQUE (org_id, slug)`, no migration
     * has replaced it, and the newest migration's sidecar records what the SQL did — so `x verify`'s
     * `drift` step reports `posts_post_slug_unique_key` unmigrated beside `post_slug_unique_per_org`
     * undeclared. Until one `x db gen` closes it, two orgs CAN publish the same slug and
     * `/blog/{slug}` serves whichever row the planner reaches first. Check for an existing
     * collision before generating: the index cannot be created over one.
     */
    invariant('post_slug_unique', c.unique(['slug'])),
    invariant('post_like_count_non_negative', c.likeCount.atLeast(0)),
    /**
     * One declaration → one CHECK constraint → one runtime guard, and now literally so: `iff`
     * renders `(status = 'published') = (published_at is not null)`, which is `0001_init.sql:67`
     * byte for byte. `c.satisfies(hasCoherentPublishState, …)` was the same rule as a JS function,
     * and a function reports `sql: null` — so the constraint here was hand-written and `x db gen`
     * would have dropped it.
     *
     * `=` and not `is not distinct from`: both operands are total (`status` is not nullable,
     * `IS NOT NULL` never yields NULL), so the two spellings agree on this table — and where they
     * would not, `=` leaves the CHECK permissive while the total form makes Postgres refuse rows
     * TypeScript accepted, which reaches a caller as a raw 23514 instead of X_INVARIANT_VIOLATED.
     */
    invariant('post_publish_coherent', iff(c.status.eq('published'), c.publishedAt.isNotNull())),
  ],
  indexes: [
    /** The feed's exact access path: tenant, then reverse chronological, bounded. */
    { on: ['orgId', 'publishedAt'], order: 'desc', where: (c) => c.status.eq('published') },
    { on: ['authorId'] },
  ],
});

export type Post = typeof posts.$row;
