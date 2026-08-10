/**
 * One public post. ISR: prerendered at build, regenerated in the background when anything tagged
 * `blog` is written — which is what `publishPost` declares in its `cache.invalidates`.
 *
 * The route never touches the database. `prerender` and the page body both go through the typed
 * client, so this file has no edge into `app/` and stays inside the 0kb budget.
 */

import { tag } from '@postly/db';
import { useT } from '@postly/i18n';
import { PostCard } from '@postly/ui';
import { defineRoute } from '@ultimat3/render';
import { ld } from '@ultimat3/seo';
import { DateTime } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { Show } from 'solid-js';
import { client } from '../../../shared/client';
import { blogHref, toCardPost } from '../../../shared/entities';
import { anonymousViewer } from '../../../shared/viewer';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'isr',
  revalidate: { tags: [tag.blog] },
  /** One page per published slug; unpublishing removes it from the sitemap in the same build. */
  prerender: () => client.publicPostSlugs({}),
  offline: 'runtime',
  hydrate: 'never',
  budget: { js: '0kb', lcp: 1800 },
  load: ({ params }) => client.publicPost({ slug: params.slug }),
  meta: ({ data, t, url }) => ({
    title: data.title,
    description: data.excerpt,
    og: { image: data.coverUrl ?? '/og/blog.png' },
    alternates: { canonical: url },
    breadcrumb: [{ name: t('site.blog.metaTitle'), url: '/blog' }],
    ld: ld.Article({
      headline: data.title,
      description: data.excerpt,
      image: data.coverUrl,
      datePublished: data.publishedAt,
      dateModified: data.updatedAt,
      author: { name: data.authorName },
    }),
  }),
});

type BlogPost = Awaited<ReturnType<typeof client.publicPost>>;

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
                <DateTime value={publishedAt()} zone={viewer().zone} format="long" />
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
