// The public feed. On `site/` because it is readable without a session — which is a POLICY
// decision written down (`canSeePost` with a null viewer), not the absence of one.
//
// The component is `async` because a route has no `load` seam: RouteDefinition carries render,
// offline, hydrate, budget, meta and policy, and nothing that fetches. The renderer awaits a
// promise, so an async component works — but it is a workaround, and a real `load` would also get
// caching, the prerender enumeration and `meta({ data })`. Recorded, not hidden.

import { db } from '@social-media-clone/db';
import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import { visibleFeed } from '../../app/posts/service';
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

export async function Page() {
  const authors = await db.users.limit(200).all();
  const byId = new Map(authors.map((user) => [user.id, user]));

  // A null viewer: anonymous. The audience ladder answers `public` and nothing else, so a
  // friends-only post, a private note and a soft-deleted row are all absent from this list
  // WITHOUT a `where` clause saying so — the policy is the only place that decides.
  const items = await visibleFeed(null, 20, (id) => byId.get(id));

  return (
    <main class={styles.feed}>
      <h1>{t('site.feed.title')}</h1>
      <p class={styles.lede}>{t('site.feed.description')}</p>

      <ul class={styles.list}>
        {items.map((item) => (
          <li class={styles.item}>
            <article>
              <header class={styles.byline}>
                <a href={`/u/${item.authorHandle}`}>{item.authorName}</a>
                <span class={styles.at}>@{item.authorHandle}</span>
                <time datetime={item.post.publishedAt.toISOString()}>
                  {day(item.post.publishedAt)}
                </time>
              </header>
              <p class={styles.body}>{item.post.body}</p>
              <footer class={styles.counts}>
                <span>{t('site.feed.likes', { count: item.post.likeCount })}</span>
                <span>{t('site.feed.comments', { count: item.post.commentCount })}</span>
              </footer>
            </article>
          </li>
        ))}
      </ul>
    </main>
  );
}
