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
import { memberQueries } from '../../shared/client';
import { pluralFormsOf } from '../../shared/plural-forms';
import { uiStringsFor } from '../../shared/ui-strings-server';
import { Layout, updateBannerIsland } from '../layout';
import { useViewer } from '../viewer-context';
import styles from './page.module.scss';

/**
 * The page's one island, declared ABOVE `defineRoute` so the route can drain it — the same shape
 * `/settings` uses. `props` are the exact keys the browser receives, as JSON and already
 * translated: a catalog cannot cross the wire and neither can a callback.
 */
const LiveFeed = island({
  src: './feed.island.tsx',
  props: ['orgId', 'locale', 'zone', 'labels', 'ui'],
});

/** The layout's update banner — an island of THIS route, so it is declared here. */
const Banner = updateBannerIsland('../update-banner.island.tsx');

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
   * measured: 125,056 B (2026-09-22; `x build`'s `buildIslands`, `buildPageBoot`,
   * `hydrateRuntimeBytes`) — the island chunk 92,973 + the update banner 712 + the page boot
   * 29,627 + the `idle` runtime 1,744, against 125,952.
   * Counted the way the `budgets` step sums a document (`packages/cli/src/budgets.ts`): every
   * executable `<script src>` it carries — the page boot included, only `/x-sw-register.js` is
   * exempt (`FRAMEWORK_SCRIPTS`) — plus every island chunk and the inline hydration runtime.
   * why: the feed is records of the page's one store over the page's one socket — the store and
   * the socket host in the island, the IndexedDB restore and the outbox in the page boot (`posts`
   * is `persist: true`, so a reload offline still shows the feed) — `@ultimat3/ui`'s
   * `AsyncRegion` for its four states, each row's date in the member's zone and a like control
   * (`useMutation(LIKE_POST)`), which the feed had before #271 and lost with it, and the socket's
   * "a new build is live" notice. The layout's update banner is its own 712 B island
   * (`@ultimat3/core/page`). Down from 133,009 when the outbox left the island for the boot
   * (8,288 B). Each island still carries its own copy of the page's realtime (`splitting:
   * false`); the shared runtime is #505, and this number comes DOWN again when it lands.
   */
  budget: { js: '123kb', lcp: 2000 },
  /** The badge's count is a read, so it is resolved here — the only place this page fetches. */
  load: () => memberQueries.feedActivity({ orgId: useActor().orgId }),
  meta: ({ t }) => ({ title: t('app.feed.metaTitle'), robots: { index: false } }),
});

/** The rows the read answered: one synthetic row per org, or none before the first post. */
type FeedActivity = Awaited<ReturnType<typeof memberQueries.feedActivity>>;

export function Page(props: { readonly data: FeedActivity }): JSX.Element {
  const t = useT();
  const actor = useActor();
  const viewer = useViewer();

  return (
    <Layout banner={Banner}>
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
        orgId={actor.orgId}
        locale={t.locale}
        zone={viewer.zone}
        labels={{
          empty: t('app.feed.empty'),
          offline: t('app.feed.offlineNotice'),
          likes: pluralFormsOf(t, 'app.post.likes'),
          like: t('app.post.like'),
          queued: t('errors.offlineQueued'),
          update: t('errors.updateAvailable'),
          reload: t('errors.updateAction'),
        }}
        ui={uiStringsFor(t)}
      >
        <Skeleton lines={4} />
      </LiveFeed>
    </Layout>
  );
}
