/**
 * Post invariants in one place. `packages/db` generates CHECK constraints from these, the
 * settings and editor UIs enforce the same limits, and nobody writes the rule twice.
 */

import { InvariantViolation } from './errors';

export const POST_STATUSES = ['draft', 'scheduled', 'published'] as const;

export type PostStatus = (typeof POST_STATUSES)[number];

export const TITLE_MAX = 120;
export const EXCERPT_MAX = 200;

/** Lowercase, digits, single hyphens, no leading/trailing hyphen. Slugs are URLs forever. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX = 80;

export const isValidSlug = (slug: string): boolean =>
  slug.length > 0 && slug.length <= SLUG_MAX && SLUG_PATTERN.test(slug);

export const isValidTitle = (title: string): boolean =>
  title.trim().length > 0 && title.length <= TITLE_MAX;

/** A published post must have a publish instant; a draft must not. Enforced as a CHECK too. */
export const hasCoherentPublishState = (status: PostStatus, publishedAt: Date | null): boolean =>
  (status === 'published') === (publishedAt !== null);

/**
 * A URL-safe slug from any text. Accents fold to their letter; a letter or digit with no ASCII form
 * (`日本語`) becomes its code point (`u65e5-u672c-u8a9e`), so a title in any script has a slug and two
 * different titles keep different ones. Text with no letter or digit at all is `post`: the slug's
 * unique index, not this function, decides a collision.
 */
export const slugify = (title: string): string =>
  title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{ASCII}]/gu, (char) =>
      /[\p{L}\p{N}]/u.test(char) ? `-u${(char.codePointAt(0) ?? 0).toString(16)}-` : '-',
    )
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '') || 'post';

/** Deterministic excerpt — no ellipsis heuristics per surface, no drift between site and app. */
export const excerptOf = (body: string): string => {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= EXCERPT_MAX) return flat;
  const cut = flat.slice(0, EXCERPT_MAX - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > EXCERPT_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
};

export const assertValidSlug = (slug: string): void => {
  if (!isValidSlug(slug)) {
    throw new InvariantViolation({
      invariant: 'post.slug',
      cause: `slug ${JSON.stringify(slug)} must match ${SLUG_PATTERN.source} and be <= ${SLUG_MAX} chars`,
      fix: 'derive it with slugify(title) instead of accepting user input verbatim',
    });
  }
};
