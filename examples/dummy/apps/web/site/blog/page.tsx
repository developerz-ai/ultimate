/**
 * The public blog index. ISR over the same `blog` tag as the article pages, so publishing one
 * post regenerates both in the same fanout — and withdrawing one removes the card and the page.
 *
 * `onInvalidate: 'purge'`: a withdrawn post has to come DOWN. Under the default a bust keeps the
 * stored page for one more serve, so the next reader would still be handed the card. The `ttl` is
 * the purge's own bound — a replica that never hears the bust serves its copy for five minutes at
 * most, and nothing stale after that. `query: []`
 * says out loud what an `isr` page is by default — no query parameter is part of it, so
 * `/blog?utm_source=…` is this one stored page and no visitor can mint another.
 */

import { useT } from '@postly/i18n';
import { PostCard } from '@postly/ui';
import { defineRoute } from '@ultimat3/render';
import { ld } from '@ultimat3/seo';
import type { JSX } from 'solid-js';
import { For } from 'solid-js';
import { queries } from '../../shared/client';
import { blogHref, toCardPost } from '../../shared/entities';
import { tag } from '../../shared/tags';
import { anonymousViewer } from '../../shared/viewer';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'isr',
  revalidate: { tags: [tag.blog], ttl: '5m', onInvalidate: 'purge', query: [] },
  offline: 'runtime',
  hydrate: 'never',
  budget: { js: '0kb' },
  // No `feed:` key: `defineRoute` takes the contract's nine keys and nothing else, so the one
  // that used to sit here declared three feed formats and emitted none. A feed is its own URL —
  // `buildFeed` from @ultimat3/seo, behind an `api/` route — never a flag on the HTML page.
  // The cards render `publishedAt` through `<DateTime>`: a `Date`, revived by the query client.
  load: async () => await queries.publicPosts({}),
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

export function Page(props: { readonly data: BlogIndex }): JSX.Element {
  const t = useT();
  // An ISR document is ONE page for every reader, so it renders in the default zone — never one
  // reader's, and never the server's. The locale is the render's own. There is no `request` prop:
  // no renderer passes one, and reading it crashed this page as soon as a post was published.
  const viewer = () => anonymousViewer({ locale: t.locale });

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
