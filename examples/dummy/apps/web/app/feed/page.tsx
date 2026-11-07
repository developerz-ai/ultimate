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
 * `render: 'stream'` — the `app/` default — for the activity count, a read the shell does not wait
 * for: it is the `<Hole>` below. The rows are not a hole: nothing on the server has them.
 */

import { useT } from '@postly/i18n';
import type { KnownPermission } from '@ultimat3/policy';
import { defineRoute, Hole, island } from '@ultimat3/render';
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
  props: ['orgId', 'locale', 'zone', 'labels', 'ui', 'commands'],
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
   * raised 158.5kb → 159kb (the reconnect double-paint fix). measured: 162,554 B (2026-10-14;
   * `x build --target static`), against the old 161,762. why: the channel's catch-up read and the
   * frames held behind it now land in one store update, so a replayed write's echo settles its
   * own overlay in the same paint (it flashed one like too many, `2 → 3 → 2`): the transport's
   * `adopt: false` request option and `catchUpRead` in the page boot.
   * raised 159kb → 162kb (#778, #777). measured: 165,111 B (2026-10-15; `x build --target static`),
   * against the old 162,554. why: +2,557 B — the page boot holds a channel's catch-up rows until the
   * page's in-flight writes are answered (`catch-up-hold.ts`, `record-landings.ts`), so a read
   * that lands before a write's echo never paints one like too many; and an offline tap reaches
   * the outbox on disk before it paints, so a reload at that instant keeps the write.
   * raised 162kb → 163kb (#855). measured: 166,122 B (2026-10-22; CI `x build --target static`),
   * against 165,888. why: the page boot's socket redials at once on `online` and a visible
   * `visibilitychange` (`LiveClient.wake()`), so a tab back from sleep is live before its armed
   * backoff runs out, and its curve resets on the node's first frame rather than on the open.
   * raised 163kb → 166kb (29.1.0). measured: 169,545 B (2026-10-29; `x build --target static`),
   * against 169,984. why: the client router grew 24,448 → 27,845 B (+3,397) — a route modal
   * opens on the click as a busy frame its document then fills (`ultimate-modals`, the frame,
   * aborting on close), opened with `show()` + `showPopover()` instead of `showModal()` and so
   * keeping focus, Tab and Escape itself; charged to every `app/` document, as the router is.
   * All of the +3,397 B over main's 166,148 B.
   * raised 166kb → 166.5kb (29.2.0, realtime read hooks). measured: 170,149 B (2026-10-29;
   * `x build --target static`), against main's 169,509 the same way. why: +640 B (page boot +359,
   * island +281) — a read hook answers the same object until what it shows moved (`keptAnswer`),
   * a `where` reader is told only of keys it shows or keeps, `useRecords`' opt-in `throttleMs`,
   * and the store's per-type index; on one adopter's run page 260 → 80 notifications.
   */
  /*
   * raised 166.5kb → 167.5kb (29.3.2), measured 171,472 B: a joined channel keeps the rows it
   * adopted until it is dropped, and a per-type cap bounds one joined for hours; page boot
   * 76,906 → 78,198 B (+1,292).
   */
  // measured: 171600 B (x build --target static) — why: the typed read client's `url()`, how a
  // `query({ download })` mints its signed URL — raised 167.5kb → 167.6kb: page boot 78,198 →
  // 78,326 B (+128), the one method every read's client carries and a download's type exposes.
  // measured: 171757 B (x build --target static) — why: a remote error carries the server's
  // `requestId` (core's `withRequestId`, in the transport the page boot holds) — raised 167.6kb →
  // 168kb (30.0.0): page boot 78,326 → 78,468 B (+142), island + inline runtime +51.
  // measured: 172705 B (2026-11-03; x build --target static, against main's 171,757) — why:
  // core's shared refusal-title table gained wave 3's 12 codes (`X_OUTBOUND_*`, `X_BREAKER_OPEN`,
  // `X_ERROR_DECLARATION_INVALID`, `X_SCHEMA_SENSITIVE_OUTPUT`: 878 B of titles), so a refusal
  // with one of them reaching the island is still titled — raised 168kb → 169kb (30.0.0): feed island +948 B.
  // measured: 176131 B (2026-11-05; x build --target static, against main's 172,761) — why: the
  // page boot +1,437 B: a pinned read's URL fill (`route-path-template.ts` 383, `http-pin-error.ts`
  // 348, `query/client.ts` 311) and the session flag (`session-lost.ts` 260, `record-sink.ts` 76,
  // `client-dispatch.ts` 57); the client router +1,409 B: `refresh()` keeps the same visitor's
  // focus (`navigation-refresh.ts`, `markFocus`/`restoreFocus`), never aborts a click in flight and
  // is asked its hold again at the swap; the feed island +524 B, `createRoot` and core's `./page`
  // additions — raised 169kb → 172.5kb (30.0.0).
  // measured: 180542 B (2026-11-05; x build --target static, against wave 5a's 176,131) — why: the
  // client router +327 B: a navigation given up at `NAVIGATION_TIMEOUT_MS`
  // (`navigation-deadline.ts`) and a timed-out `refresh()` that fails quietly
  // (`navigation-refresh.ts`); the page boot and the feed island +4,084 B together: the
  // server-stamped path pins read from `<meta name="ultimate-pins">` (`client-paths-pins.ts`) and
  // filled by `fill-wire.ts`, which refuses a `.`/`..` segment, and the session flag raised only
  // for a same-origin 401 (`session-lost.ts`) — raised 172.5kb → 177kb (30.0.0, plan 101 wave 5b).
  // measured: 182434 B (2026-11-06; x build --target static, against 181,077) — why:
  // `/x-client-vitals.js` +1,202 B, real-user timings beaconed on hide (`clientErrors.vitals`,
  // `app/` only), and the realtime client +155 B, a live subscribe's `traceparent` so its
  // snapshot joins the page's trace — raised 177kb → 178.5kb (plan 101, 41).
  // measured: 183252 B (2026-11-06; x build --target static, against 182,784) — why: the inline
  // time-zone script +153 B (`time.detect`, the visitor's own zone from the next request) and the
  // page boot +665 B (82,123 B), this wave's changes to the client runtime every `app/` page
  // boots — raised 178.5kb → 179kb (plan 101 wave 9).
  // measured: 206781 B (2026-11-06; x verify --only budgets, against 183,252) — why: the feed
  // island +23,529 B (90,751 B): the page's keyboard layer (`feed-commands.tsx` — the command
  // palette and its one ranker, the hotkey table, the `?` shortcut sheet over `Dialog`, and
  // `navigate()` through the router), the pull-to-refresh gesture and the toolbar's refresh
  // button — raised 179kb → 202kb (plan 101, 38-ui-commands, 38-ui-navigation).
  // measured: 212076 B (2026-11-06; x verify --only budgets, against 206,781) — why: the feed
  // island +5,295 B (96,046 B): the rows on `VirtualList` (`virtual-list-view.ts`, the one
  // `ResizeObserver`, the DOM anchor and the keyed rows), so a 10,000-post feed mounts what is on
  // screen and a live prepend moves nothing being read — raised 202kb → 208kb (plan 101, 38-ui-lists).
  // measured: 210084 B (2026-11-06; x build --target static, against 212,076) — why: ui's keys
  // tree-shaken per key (`ui-keys.ts`), −2,003 B; `VirtualList` re-pinning when its drawn range
  // moves (a follower settled 52 px short) and `mount` returning its disposer (the router lets
  // go of the hotkeys and the live read on a swap) — lowered 208kb → 205.5kb (plan 101 wave 10).
  // measured: 211146 B (2026-11-07, sweep 2; x build --target static) — why: the record envelope's `order` decode (+63 B, core/page) and the live refetch's retry (`LiveHandle.retry`, use-query + client) — a newest-first list stays newest-first and pull-to-refresh re-asks a refused subscription. Sweep 1, 210815 B: the router 29,570 → 29,692 and
  // core's `clientStream` unwrapping a JSON answer as `call()` does (`settleAnswer`, records and
  // dates), +731 B over 210,084.
  budget: { js: '207kb' },
  meta: ({ t }) => ({ title: t('app.feed.metaTitle'), robots: { index: false } }),
});

/**
 * The badge's count: the only place this page fetches, and it starts after the first flush. The
 * read answers one synthetic row per org, or none before the first post.
 */
async function activityLine(): Promise<string> {
  const t = useT();
  const rows = await memberQueries.feedActivity({ orgId: useActor().orgId });
  return t('app.feed.activity', { count: rows[0]?.publishedCount ?? 0 });
}

export function Page(): JSX.Element {
  const t = useT();
  const actor = useActor();
  const viewer = useViewer();

  return (
    <Layout banner={Banner} here="/feed">
      <header class={styles.header}>
        <h1>{t('app.feed.heading', { org: actor.org.name })}</h1>
        <Text tone="muted" class={styles.activity}>
          <Hole fallback={<Skeleton lines={1} />}>{activityLine}</Hole>
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
          list: t('app.nav.feed'),
          offline: t('app.feed.offlineNotice'),
          likes: pluralFormsOf(t, 'app.post.likes'),
          like: t('app.post.like'),
          queued: t('errors.offlineQueued'),
          update: t('errors.updateAvailable'),
          reload: t('errors.updateAction'),
          refresh: t('app.feed.refresh'),
        }}
        ui={uiCatalog(t)}
        commands={{
          labels: {
            title: t('app.commands.title'),
            filterLabel: t('app.commands.filterLabel'),
            filterPlaceholder: t('app.commands.filterPlaceholder'),
            emptyText: t('app.commands.empty'),
            escHint: t('app.commands.esc'),
            goTo: t('app.commands.goTo'),
            posts: t('app.commands.posts'),
          },
          destinations: [
            { label: t('app.nav.feed'), href: '/feed' },
            { label: t('app.nav.runs'), href: '/runs' },
            { label: t('app.nav.settings'), href: '/settings' },
            { label: t('app.feed.newPost'), href: '/posts/new' },
          ],
        }}
      >
        <Skeleton lines={4} />
      </LiveFeed>
    </Layout>
  );
}
