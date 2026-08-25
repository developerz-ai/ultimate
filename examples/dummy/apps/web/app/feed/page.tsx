/**
 * The org feed. The rows are LIVE — they arrive over the sync node's socket, not from a resolving
 * promise — so the page itself renders none of them: it renders the header the server already
 * knows and the island's loading shell, and `feed.island.tsx` replaces that shell with the
 * subscription once a browser has booted it.
 *
 * That split is issue #271's other half. Until 2026-08-23 this page called `useConnection()` and
 * `useLiveFeed()` in its own body while declaring no `island()` — so no module of this route ever
 * ran in a browser, no `setLiveClient()` could happen, and the page server-rendered its loading
 * branch and stayed there, at 200, with `x verify` green. `X_LIVE_ROUTE_NO_ISLAND` is now the
 * build error that says so.
 *
 * `render: 'stream'` — the `app/` default — for the activity count, which IS a promise. The rows
 * are not a hole `<Suspense>` could fill: nothing on the server has them.
 */

import { useT } from '@postly/i18n';
import type { KnownPermission } from '@ultimat3/policy';
import { defineRoute, island } from '@ultimat3/render';
import { Skeleton, Text } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { useActor } from '../../shared/actor';
import { queries } from '../../shared/client';
import { Layout } from '../layout';
import styles from './page.module.scss';
import { syncUrlFrom } from './sync-url';

/**
 * The page's one island, declared ABOVE `defineRoute` so the route can drain it — the same shape
 * `/settings` uses. `props` are the exact keys the browser receives, as JSON and already
 * translated: a catalog cannot cross the wire and neither can a callback.
 */
const LiveFeed = island({
  src: './feed.island.tsx',
  props: ['syncUrl', 'buildId', 'actorId', 'orgId', 'labels'],
});

export const config = defineRoute({
  render: 'stream',
  /**
   * The org's feed is not public, and the route has to say so: a page declaring no `policy` is
   * registered `auth: 'public'` (`metaOf` in `packages/cli/src/dev-render.ts`), which also skips
   * `render-ssr`'s gated branch — so the response carries no `vary: cookie` and a shared cache may
   * hand one member's feed to the next visitor. The coarse permission only; `liveFeed`'s own
   * `feedRead` still decides the org, per subscriber, on every row.
   */
  policy: { permission: 'feed:read' satisfies KnownPermission },
  /**
   * Network-first for the document, cache-first for the content-hashed chunks. The feed's *rows*
   * are not cached by the service worker at all — they come from the live subscription.
   */
  offline: 'runtime',
  hydrate: 'idle',
  /**
   * Measured, not guessed: the island chunk is 42,714 bytes (`buildIslands` in
   * `feed.island.test.ts` reports it) plus the `idle` hydration runtime, against 61,440. Most of
   * it is the Solid runtime and `LiveClient`; the feed's own compiled markup is a few hundred
   * bytes, which is why this island renders plain elements rather than `@postly/ui`'s `PostCard`
   * — that component alone costs more than the headroom left here.
   */
  budget: { js: '60kb', lcp: 2000 },
  /** The badge's count is a read, so it is resolved here — the only place this page fetches. */
  load: () => queries.feedActivity({ orgId: useActor().orgId }),
  meta: ({ t }) => ({ title: t('app.feed.metaTitle'), robots: { index: false } }),
});

/** The rows the read answered: one synthetic row per org, or none before the first post. */
type FeedActivity = Awaited<ReturnType<typeof queries.feedActivity>>;

export function Page(props: { readonly data: FeedActivity }): JSX.Element {
  const t = useT();
  const actor = useActor();

  return (
    <Layout>
      <header class={styles.header}>
        <h1>{t('app.feed.heading', { org: actor.org.name })}</h1>
        <Text tone="muted" class={styles.activity}>
          {t('app.feed.activity', { count: props.data[0]?.publishedCount ?? 0 })}
        </Text>
        <a class={styles.new} href="/posts/new">
          {t('app.feed.newPost')}
        </a>
      </header>

      {/*
        The island's wrapper, and what the server puts inside it: the loading state, which is the
        honest thing for a server to say about rows only a socket has. `mount` replaces it.
      */}
      <LiveFeed
        syncUrl={syncUrlFrom(process.env)}
        buildId={process.env['BUILD_ID'] ?? 'dev'}
        actorId={actor.id}
        orgId={actor.orgId}
        labels={{
          loading: t('app.feed.loading'),
          empty: t('app.feed.empty'),
          offline: t('app.feed.offlineNotice'),
        }}
      >
        <Skeleton lines={4} />
      </LiveFeed>
    </Layout>
  );
}
