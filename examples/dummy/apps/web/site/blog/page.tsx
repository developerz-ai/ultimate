/**
 * The public blog index. ISR over the same `blog` tag as the article pages, so publishing one
 * post regenerates both in the same fanout — and unpublishing removes the card and the page and
 * the sitemap entry, in one build.
 */

import { tag } from '@postly/db';
import { useT } from '@postly/i18n';
import { PostCard } from '@postly/ui';
import { defineRoute } from '@ultimat3/render';
import { ld } from '@ultimat3/seo';
import type { JSX } from 'solid-js';
import { For } from 'solid-js';
import { queries } from '../../shared/client';
import { blogHref, toCardPost } from '../../shared/entities';
import { anonymousViewer } from '../../shared/viewer';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'isr',
  revalidate: { tags: [tag.blog] },
  offline: 'runtime',
  hydrate: 'never',
  budget: { js: '0kb', lcp: 1500 },
  // No `feed:` key: `defineRoute` takes the contract's nine keys and nothing else, so the one
  // that used to sit here declared three feed formats and emitted none. A feed is its own URL —
  // `buildFeed` from @ultimat3/seo, behind an `api/` route — never a flag on the HTML page.
  load: () => queries.publicPosts({}),
  meta: ({ t, url }) => ({
    title: t('site.blog.metaTitle'),
    description: t('site.blog.metaDescription'),
    og: { image: '/og/blog.png' },
    canonical: url,
    // Every crumb through `t()`: a breadcrumb is what a search result shows a reader, so it is a
    // user-facing string in the surface whose entire purpose is being read by strangers.
    ld: [
      ld.BreadcrumbList({
        items: [
          { name: t('common.appName'), url: '/' },
          { name: t('site.blog.metaTitle'), url },
        ],
      }),
    ],
  }),
});

/** A list route renders the page of rows the read answered, unwrapped by nothing. */
type BlogIndex = Awaited<ReturnType<typeof queries.publicPosts>>;

export function Page(props: {
  readonly data: BlogIndex;
  readonly request: { locale?: string; zone?: string };
}): JSX.Element {
  const t = useT();
  const viewer = () => anonymousViewer(props.request);

  return (
    <main class={styles.page}>
      <h1>{t('site.blog.metaTitle')}</h1>

      <ul class={styles.list}>
        <For each={props.data}>
          {(post) => (
            <li>
              <PostCard post={toCardPost(post)} href={blogHref(post)} zone={viewer().zone} />
            </li>
          )}
        </For>
      </ul>
    </main>
  );
}
