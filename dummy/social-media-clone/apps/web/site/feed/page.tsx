// The public feed. On `site/` because it is readable without a session — which is a POLICY
// decision written down (`canSeePost` with a null viewer), not the absence of one.
//
// The component is `async` because a route has no `load` seam: RouteDefinition carries render,
// offline, hydrate, budget, meta and policy, and nothing that fetches. The renderer awaits a
// promise, so an async component works — but it is a workaround, and a real `load` would also get
// caching, the prerender enumeration and `meta({ data })`. Recorded, not hidden.

import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import { iconRss } from '@ultimat3/ui/icons/rss';
import { feedForPage } from '../../app/posts/service';
import { AppShell } from '../../shared/ui/app-shell';
import { EmptyState } from '../../shared/ui/empty-state';
import { PageHeading } from '../../shared/ui/page-heading';
import { PostCard } from '../../shared/ui/post-card';
import styles from './page.module.scss';

export const config = defineRoute({
  render: 'ssr',
  hydrate: 'never',
  offline: 'runtime',
  budget: { js: '0kb', lcp: 2000 },
  meta: () => ({
    title: t('site.feed.title'),
    description: t('site.feed.description'),
  }),
});

/** Formatted with an explicit zone. There is no ambient default, anywhere, on purpose. */
const day = (value: Date): string =>
  new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(value);

export async function Page(props: { readonly url?: string | undefined }) {
  // A null viewer: anonymous. The audience ladder answers `public` and nothing else, so a
  // friends-only post, a private note and a soft-deleted row are all absent from this list
  // WITHOUT a `where` clause saying so — the policy is the only place that decides.
  const items = await feedForPage(null, 20);

  return (
    <AppShell url={props.url}>
      <PageHeading
        eyebrow={t('site.feed.eyebrow')}
        title={t('site.feed.title')}
        lede={t('site.feed.description')}
      />

      {items.length === 0 ? (
        <EmptyState
          glyph={iconRss}
          title={t('site.feed.empty')}
          description={t('site.feed.emptyHelp')}
        />
      ) : (
        <ul class={styles.list}>
          {items.map((item) => (
            <li>
              <PostCard
                author={{ name: item.authorName, handle: item.authorHandle }}
                body={item.post.body}
                publishedAt={item.post.publishedAt}
                published={day(item.post.publishedAt)}
                likeCount={item.post.likeCount}
                commentCount={item.post.commentCount}
              />
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}
