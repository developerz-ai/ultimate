import { tag } from '@postly/db';
import { publicPostRead } from '@postly/web/shared/policies';
import { from, query, t } from '@ultimat3/query';
import type { PublishedSlug } from '../repo';
import * as repo from '../repo';

/**
 * Feeds `prerender()` on the blog route: one row per page the build must emit. The tail key is
 * `slug`, not `id` — this projection has no `id` column to sort on, and `slug` is unique across
 * every org by invariant, which is the same property the public URL relies on.
 */
export const publicPostSlugs = query({
  input: t.object({}),
  policy: publicPostRead,
  cache: { tags: [tag.blog], ttlMs: 3_600_000 },
  sql: () =>
    from<PublishedSlug>('posts', repo.publishedSlugs)
      .where({ status: 'published' })
      .orderBy('publishedAt', 'desc')
      .orderBy('slug')
      .limit(1000),
});
