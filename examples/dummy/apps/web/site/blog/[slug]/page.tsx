/**
 * One public post. ISR: prerendered at build, regenerated in the background when anything tagged
 * `blog` is written — which is what `publishPost` declares in its `cache.invalidates`.
 *
 * The route never touches the database. `prerender` and the page body both go through the typed
 * read client — `Api['queries']` is a type, so this file has no edge into `app/` and stays inside
 * the 0kb budget.
 */

import { useT } from '@postly/i18n';
import { PostCard } from '@postly/ui';
import { defineRoute } from '@ultimat3/render';
import { ld } from '@ultimat3/seo';
import { DateTime } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { Show } from 'solid-js';
import { queries } from '../../../shared/client';
import { blogHref, toCardPost } from '../../../shared/entities';
import { oneRow } from '../../../shared/rows';
import { tag } from '../../../shared/tags';
import { anonymousViewer } from '../../../shared/viewer';
import { wireDate } from '../../../shared/wire';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'isr',
  revalidate: { tags: [tag.blog] },
  /**
   * One page per published slug; unpublishing removes it from the sitemap in the same build. A
   * read answers rows and a prerender answers params, so the slug is projected out — a bare
   * string fills this route's single dynamic segment, and handing the row over whole would put
   * its `updatedAt` in the param map as a second segment nothing routes.
   */
  prerender: async () => (await queries.publicPostSlugs({})).map((post) => post.slug),
  offline: 'runtime',
  hydrate: 'never',
  budget: { js: '0kb', lcp: 1800 },
  /**
   * `publishedAt` is rehydrated here and nowhere else: the read answered over HTTP, so the
   * instant arrived as the string `JSON.stringify` wrote, and `meta` below calls `toISOString()`
   * on it. One conversion at the loader, rather than a `Date` cast at each render.
   */
  load: async ({ params }) => {
    const slug = params.slug ?? '';
    const post = oneRow(await queries.publicPost({ slug }), slug);
    return { ...post, publishedAt: wireDate(post.publishedAt) };
  },
  /**
   * `dateModified` is deliberately absent: `PostView` excludes `updatedAt` (`app/posts/entity.ts`)
   * because a row's storage mtime is not an editorial fact, and `ld.Article` already defaults it
   * to `datePublished`. An `Article` needs a published instant, so a row without one — which this
   * read cannot return, since it filters `status: 'published'` — emits no node rather than a node
   * a crawler rejects.
   */
  meta: ({ data, t, url }) => ({
    title: data.title,
    description: data.excerpt,
    og: { image: data.coverUrl ?? '/og/blog.png' },
    canonical: url,
    ld: [
      ld.BreadcrumbList({
        items: [
          { name: t('common.appName'), url: '/' },
          { name: t('site.blog.metaTitle'), url: '/blog' },
          { name: data.title, url },
        ],
      }),
      ...(data.publishedAt === null
        ? []
        : [
            ld.Article({
              headline: data.title,
              description: data.excerpt,
              ...(data.coverUrl === null ? {} : { image: data.coverUrl }),
              datePublished: data.publishedAt.toISOString(),
              author: { name: data.authorName },
            }),
          ]),
    ],
  }),
});

/** The row the loader unwrapped, not the page of rows the read answered. */
type BlogPost = Awaited<ReturnType<typeof queries.publicPost>>[number];

export function Page(props: {
  readonly data: BlogPost;
  readonly request: { locale?: string; zone?: string };
}): JSX.Element {
  const t = useT();
  // Anonymous readers have no member row; the zone comes from the request hint, never the server.
  const viewer = () => anonymousViewer(props.request);

  return (
    <main class={styles.page}>
      <article>
        <header class={styles.header}>
          <h1>{props.data.title}</h1>
          <p class={styles.meta}>
            {t('site.blog.by', { name: props.data.authorName })}
            <Show when={props.data.publishedAt}>
              {(publishedAt) => (
                <DateTime value={publishedAt()} timeZone={viewer().zone} dateStyle="long" />
              )}
            </Show>
          </p>
        </header>

        <div class={styles.body}>{props.data.body}</div>
      </article>

      <aside class={styles.related}>
        <a href="/blog">{t('site.blog.backToBlog')}</a>
        {/* Same card component the authed feed uses — one mapping, two surfaces, zero JS here. */}
        <PostCard post={toCardPost(props.data)} href={blogHref(props.data)} zone={viewer().zone} />
      </aside>
    </main>
  );
}
