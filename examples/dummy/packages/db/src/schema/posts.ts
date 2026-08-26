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
     * **The database has it, since 2026-08-26.** `0001_init.sql` created
     * `post_slug_unique_per_org UNIQUE (org_id, slug)` — per-org, so two orgs COULD publish the
     * same slug and `/blog/{slug}` served whichever row the planner reached first. The generated
     * migration creates `posts_post_slug_unique_key` over `(slug)` alone and drops the per-org
     * constraint, in that order.
     *
     * The order is not cosmetic: the new index is NARROWER, so it cannot be created over an
     * existing cross-org collision. On a populated database, look first —
     * `select slug from posts group by slug having count(*) > 1` — and resolve every row it
     * returns before applying, or the migration fails at that statement with `23505`.
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
