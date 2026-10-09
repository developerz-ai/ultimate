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
import { Skeleton, Text, uiCatalog } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { useActor } from '../../shared/actor';
import { memberQueries } from '../../shared/client';
import { pluralFormsOf } from '../../shared/plural-forms';
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
   * registered `auth: 'public'` (`metaOf` in `packages/cli/src/runtime-render.ts`), which also skips
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
  // Fetched on hover as well as on click: this page's GET only renders — it records nothing, so a
  // guess that never becomes a visit costs one read. The server refuses a prefetch of any page
  // that does not say this (`@ultimat3/http`'s navigation gate).
  navigation: 'prefetch',
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
   *
   * raised 123kb → 149kb (plan 101 sweep 9, #505). measured: 151,095 B (2026-10-05;
   * `x build --target static`'s `.x/build-stats.json`, which now weighs this page AS SERVED — scoped,
   * with its page boot), against 152,576. The document: the page boot 68,980 (the page runtime —
   * store, socket host, channel book, query client, transport — moved INTO it), the feed island
   * 59,712, the client router 19,940, the update banner 710, the inline hydration runtime 1,753.
   * why: the runtime left the island (103,382 → 59,712 B) for the boot, once per page, and the
   * served document went 163,072 → 151,095 B (−11,977). The 123kb budget was a number about a
   * document no browser downloads: the static step rendered this page UNSCOPED, so it never weighed
   * the boot (37,287 B then) — an interim 132.5kb measured 134,488 B the same way, with
   * `/islands/page-runtime.<id>.js` charged in the boot's place. +1,481 B of headroom is Bun's
   * tree-shaker flap (`island-bytes.test.ts`, up to 1,124 B).
   * raised 149kb → 150.5kb (plan 101 sweep 9, #506). measured: 152,795 B (2026-10-05;
   * `x build --target static`), against 154,112. why: +794 B is the offline reload's first paint —
   * the inline runtime 1,753 → 2,229 (+417 B for the held-island part: hide the server's stale
   * count until every held island mounted, a 3 s cap, a CSS reveal with no script; +59 B for
   * `catchUp` letting go of a press after a mount it did not flush, so it never runs twice) and
   * +318 B in the feed island for `holdFirstPaint` (its mount waits for the restored records and the
   * open outbox, capped at 1 s). The other +906 B is the page boot (68,980 → 69,531) and the feed
   * island's own growth from the rest of sweep 9, measured here and stated here.
   * raised 150.5kb → 153.5kb (sweep 14, #648 row 19). measured: 155,900 B (2026-10-07; was 154,004).
   * +1,896 B is real function: `useOutbox()` — the queued-writes notice reads the page outbox's own
   * count and clears when the server takes the write — and the outbox's cross-tab sync (one
   * `BroadcastChannel`, a read-only `refresh()`, so another tab's drain clears this tab's count and
   * a write never overtakes one another tab queued): +321 B feed island, +1,575 B page boot.
   * `shared/queued-writes.ts`, the app's workaround, is deleted.
   * raised 153.5kb → 157kb (26.1.0, route-presented modals). measured: 159,988 B (2026-10-08;
   * `x build --target static`), against 160,768. why: the client router grew 19,966 → 24,058 B
   * (+4,092): `navigation: 'modal'` — a hash-addressed `<dialog>` over the page, reopened by a
   * reload, Back/Forward or a pasted URL, its forms posted through the router, and the router's
   * `refresh`/`openModal`/`closeModal` for navigating from code; charged to every
   * `app/` document, as the router is. Of the +4,088 B over 155,900, the router is
   * +4,092; −4 B is main's own drift between that measurement and 26.0.0.
   * raised 157kb → 158.5kb (#710, owner decision 19). measured: 161,762 B (2026-10-09;
   * `x build --target static`), against 162,304; main measured 160,066 the same way. why: +699 B
   * page boot — `reviveWireDates`, so a read's `Date` reaches every island as a `Date` (the app's
   * `shared/wire.ts` is deleted); +997 B feed island — `subsetTranslator` over the `ui.*` strings
   * the server resolved (`uiCatalog`), interpolation and the CLDR plural pick included, where the
   * app's `shared/ui-strings.ts` looked a key up and nothing else.
   */
  budget: { js: '158.5kb' },
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
        ui={uiCatalog(t)}
      >
        <Skeleton lines={4} />
      </LiveFeed>
    </Layout>
  );
}
