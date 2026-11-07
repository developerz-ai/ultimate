/**
 * The run console. The events are LIVE — they arrive over the sync node's socket as the job
 * writes them — so the page renders none of them: it renders what the server knows (the org's
 * connections, every label) and the island's loading shell, and `run-console.island.tsx` takes
 * over once a browser has booted it.
 *
 * `render: 'ssr'`: the one read here is the connection list, resolved in `load` through the typed
 * query client before the document is written — nothing on this page waits long enough to be a
 * `<Hole>`. A route never touches the database.
 */

import { useT } from '@postly/i18n';
import type { KnownPermission } from '@ultimat3/policy';
import { defineRoute, island } from '@ultimat3/render';
import { Link, Skeleton, Text, Tree, uiCatalog } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { useActor } from '../../shared/actor';
import { memberQueries } from '../../shared/client';
import { pluralFormsOf } from '../../shared/plural-forms';
import { Layout, updateBannerIsland } from '../layout';
import { useViewer } from '../viewer-context';
import {
  connectionsByDay,
  createdOn,
  createdRange,
  dayHref,
  withinCreated,
} from './connection-filter';
import { CreatedFilter, type CreatedFilterProps } from './created-filter';
import type { RunConsoleLabels } from './run-console.island';
import styles from './run-console.module.scss';

/**
 * Declared ABOVE `defineRoute` so the route can drain it. `props` are the browser's keys. The
 * "created between" filter rides in it (`filter`): one island, so one Solid on the page.
 */
const Console = island({
  src: './run-console.island.tsx',
  props: ['orgId', 'locale', 'zone', 'connections', 'labels', 'ui', 'filter'],
});

/** The layout's update banner — an island of THIS route, so it is declared here. */
const Banner = updateBannerIsland('../update-banner.island.tsx');

export const config = defineRoute({
  render: 'ssr',
  /**
   * A run is not public, and the route has to say so: a page declaring no `policy` is registered
   * `auth: 'public'`. The coarse permission only; `liveRunEvents`' own `canRunRead` still decides
   * the org, per subscriber, on every row.
   */
  policy: { permission: 'run:read' satisfies KnownPermission },
  offline: 'runtime',
  hydrate: 'idle',
  /**
   * measured: 132,330 B (2026-10-02; `x build --target static`'s `.x/build-stats.json`), against
   * 133,632 (`130.5kb`) — the island chunk + the update banner + the client router, the page boot
   * and the `idle` runtime every live `app/` document carries. Was 130,686 against `129kb`: of the
   * +1,644 B, 915 were already on main when plan 101's slice 08 began (131,601 measured before
   * its first edit) and 729 are that slice's client: the beat the node names
   * (`hello.heartbeatMs`), a channel that leaves `joining` on the node's answer, null-prototype
   * frame maps, and a queued write the outbox refuses taken back off the screen.
   * why: the console is a live read over the page's one socket (`useQuery(liveRunEvents)` — the
   * record store and the socket host in the island, as on `/feed`), `@ultimat3/ui`'s `AsyncRegion`
   * for the read's own states with its `Button`, `Input` and `DateTime`, the typed action client
   * for the four writes a run takes (connect, start, answer, cancel), and what an ended run used.
   * The 1,302 B over the measurement is Bun's tree-shaker flap (`island-bytes.test.ts`): a chunk is
   * up to 1,124 B larger on a run that keeps `schema-error-codes.ts`. It comes DOWN with the shared
   * island runtime (#505), as `/feed` does.
   * raised 130.5kb → 131kb, measured 133,717 B (2026-10-05, plan 101 sweep 1c; CI's
   * `x build --target static`): +1,387 B over 132,330, of which the client-reachable realtime error
   * registry is the new part. `X_SOCKET_LIMIT` (the per-principal socket cap) and the `actor` scope
   * of `X_SUBSCRIPTION_LIMIT`, each with the fix a refused client renders, plus 1b's retry-after
   * wait on a rate-limited subscribe.
   * raised 131kb → 162.5kb (plan 101 sweep 9, #505). measured: 164,827 B (2026-10-05;
   * `x build --target static`, which now weighs this page AS SERVED — scoped, with its page boot),
   * against 166,400. The document: the run console 73,444, the page boot 68,980 (now carrying the
   * page runtime), the client router 19,940, the update banner 710, the inline runtime 1,753.
   * why: the runtime left the island (111,554 → 73,444 B) for the boot, once per page, and the
   * served document went 171,244 → 164,827 B (−6,417). 131kb never counted the boot: the static
   * step rendered this page unscoped (an interim 146kb measured 148,220 B the same way, the runtime
   * chunk charged in the boot's place). +1,573 B of headroom is Bun's tree-shaker flap, as above.
   * raised 162.5kb → 164kb (plan 101 sweep 9, #506). measured: 166,600 B (2026-10-05;
   * `x build --target static`), against 167,936. why: +794 B for the offline reload's first paint,
   * as on `/feed` — the held-island runtime (+417 B), `catchUp`'s let-go after a mount it did not
   * flush (+59 B) and `holdFirstPaint` in the run console (+318 B). The other +979 B is the page
   * boot (68,980 → 69,531) and the console's own growth from the rest of sweep 9.
   * raised 164kb → 167kb (sweep 14, #648 row 19). measured: 169,390 B (2026-10-07; was 167,815).
   * +1,575 B is the page boot carrying the outbox's pending count (`OutboxHandle.size`/`subscribe`/
   * `refresh`, read by `useOutbox()`) and its cross-tab sync, which every page's islands share; this
   * route's own island is unchanged.
   * raised 167kb → 170kb (26.1.0, route-presented modals). measured: 173,474 B (2026-10-08;
   * `x build --target static`), against 174,080. why: the client router grew 19,966 → 24,058 B
   * (+4,092): `navigation: 'modal'` — a hash-addressed `<dialog>` over the page, reopened by a
   * reload, Back/Forward or a pasted URL, its forms posted through the router, and the router's
   * `refresh`/`openModal`/`closeModal` for navigating from code; charged to every
   * `app/` document, as the router is. Of the +4,084 B over 169,390, the router is
   * +4,092; −8 B is main's own drift between that measurement and 26.0.0.
   * raised 170kb → 172.5kb (#710, owner decision 19). measured: 176,018 B (2026-10-09;
   * `x build --target static`), against 176,640; main measured 173,623 the same way. why: +699 B
   * page boot — `reviveWireDates`, a read's `Date` revived as a `Date`; +1,696 B run console —
   * the same revival in its typed action client's transport (+699) and `subsetTranslator` over the
   * server-resolved `ui.*` strings (+997), which replaced the app's `shared/ui-strings.ts`.
   * raised 172.5kb → 173kb (the reconnect double-paint fix). measured: 176,826 B (2026-10-14;
   * `x build --target static`), against the old 176,018. why: the channel's catch-up read and the
   * frames held behind it now land in one store update, so a replayed write's echo settles its
   * own overlay in the same paint (it flashed one like too many, `2 → 3 → 2`): the transport's
   * `adopt: false` request option and `catchUpRead` in the page boot.
   * raised 173kb → 175kb (#778, #777). measured: 179,141 B (2026-10-15; `x build --target static`),
   * against the old 176,826. why: +2,315 B — the page boot holds a channel's catch-up rows until the
   * page's in-flight writes are answered (`catch-up-hold.ts`, `record-landings.ts`), so a read
   * that lands before a write's echo never paints one like too many; and an offline tap reaches
   * the outbox on disk before it paints, so a reload at that instant keeps the write.
   */
  // measured: 179711 B (x build --target static) — why: the page store now compares a re-read row by
  // content (`sameJson`), so a catch-up after a sync roll no longer redraws every row (#852).
  // raised 176kb → 180kb (29.1.0). measured: 183575 B (2026-10-29; x build --target static),
  // against 184320. why: the client router grew 24,448 → 27,845 B (+3,397) — a route modal opens
  // on the click as a busy frame its document then fills, opened with show() + showPopover()
  // instead of showModal(); charged to every app/ document. All of the +3,397 B over main's 180178.
  // measured: 185502 B (x build --target static) — why: bounded page record store (no leak) —
  // raised 180kb → 181.5kb (29.3.2): a joined channel keeps the rows it adopted until it is
  // dropped, and a per-type cap bounds one joined for hours; page boot 76,906 → 78,198 B (+1,292).
  // measured: 186157 B (x build --target static) — why: a remote error carries the server's
  // `requestId` (core's `withRequestId`, in both the page boot and the console's own action
  // decoder) and the read client's `url()` — raised 181.5kb → 182kb (30.0.0): page boot
  // 78,198 → 78,468 B (+270), the run-console island + inline runtime +421.
  // measured: 187401 B (2026-11-03; x build --target static, against main's 186,157) — why:
  // core's shared refusal-title table gained wave 3's 12 codes (`X_OUTBOUND_*`, `X_BREAKER_OPEN`,
  // `X_ERROR_DECLARATION_INVALID`, `X_SCHEMA_SENSITIVE_OUTPUT`: 878 B of titles), so a refusal
  // with one of them reaching the island is still titled, and a refusal's issues carry the `rule` and `params` a form translates
  // on (plan 101 slice 10) — raised 182kb → 183.5kb (30.0.0): run-console island +1,244 B.
  // measured: 192768 B (2026-11-05; x build --target static, against main's 187,457) — why: the
  // run-console island +2,465 B: `action.client()` filling a pinned URL (`action/client.ts` +536,
  // `errors-http.ts` 443, `route-path-template.ts` 385), 5a's titles (+499) and the session flag
  // (+392) and +203 B for `useQuery`'s and ui's changes; the page boot +1,437 B: a
  // pinned read's URL fill (`route-path-template.ts` 383, `http-pin-error.ts` 348,
  // `query/client.ts` 311) and the session flag (`session-lost.ts` 260, `record-sink.ts` 76,
  // `client-dispatch.ts` 57); the client router +1,409 B: `refresh()` keeps the same visitor's
  // focus (`navigation-refresh.ts`, `markFocus`/`restoreFocus`), never aborts a click in flight and
  // is asked its hold again at the swap — raised 183.5kb → 188.5kb (30.0.0).
  // measured: 196449 B (2026-11-05; x build --target static, against wave 5a's 192,768) — why: the
  // client router +327 B: a navigation given up at `NAVIGATION_TIMEOUT_MS`
  // (`navigation-deadline.ts`) and a timed-out `refresh()` that fails quietly
  // (`navigation-refresh.ts`); the page boot and the run-console island +3,354 B together: the
  // server-stamped path pins read from `<meta name="ultimate-pins">` (`client-paths-pins.ts`) and
  // filled by `fill-wire.ts`, which refuses a `.`/`..` segment, and the session flag raised only
  // for a same-origin 401 (`session-lost.ts`) — raised 188.5kb → 192kb (30.0.0, plan 101 wave 5b).
  // measured: 196744 B (2026-11-05; CI's x build --target static, against 196,449) — why: the
  // page boot +255 B, a replayed write's stored pin checked as a same-origin path before it is
  // sent (`pinned-wire.ts`), and the router +25 B, a navigation whose request throws at once
  // still clears its deadline (`navigation-deadline.ts`) — raised 192kb → 192.5kb (30.0.0).
  // measured: 198101 B (2026-11-06; x build --target static, against 196,744) — why:
  // `/x-client-vitals.js` +1,202 B, real-user timings beaconed on hide (`clientErrors.vitals`,
  // `app/` only), and the realtime client +155 B, a live subscribe's `traceparent` so its
  // snapshot joins the page's trace — raised 192.5kb → 194kb (plan 101, 41).
  // measured: 201102 B (2026-11-06; `x verify --only budgets`, against 198,101) — why: the
  // run console's `rpc` +2,068 B, every typed-client method carrying `.stream(input)` (core's
  // `clientStream`, plan 101 slice 41: a stream-declaring action read as it is written); the other
  // +933 B is the page boot, 82,123 B here, not this change — raised 194kb → 196.5kb.
  // measured: 223574 B (2026-11-06; 201,102 + the run-console island's own growth measured by
  // `buildIslands`, 85,911 → 108,383 B, against main's console built the same way) — why: plan
  // 101 slice 38: the log beside the run (`SplitPane`, the separator gesture `drag/pointer-drag.ts`),
  // the events as a filterable, following `LogViewer` on `VirtualList` (+`log-viewer-view.ts`),
  // the transcript as `TerminalView` (`content/ansi.ts`) and the usage record as `JsonView`
  // (+22,472 B) — raised 196.5kb → 219kb. The coordinator's `budgets` step weighs the document.
  // measured: 287222 B (2026-11-06; x verify --only budgets) — why: the "created between" filter
  // island, 58,159 B: `DateRangePicker`'s calendar (`Calendar`, `calendar-view.ts`, `Popover`,
  // `@ultimat3/time`'s plain dates) on a fine pointer, over the GET form of two native date inputs
  // the server renders; its own island, so it carries its own Solid and `UiProvider` — raised
  // 219kb → 281kb (plan 101, 38-ui-pickers). The `Tree` of connections is server markup, 0 B.
  // measured: 245551 B (2026-11-06; x build --target static, against 287,402) — why: the filter
  // is drawn inside the run console, so the page carries ONE Solid and one `UiProvider`: the
  // console 113,213 → 131,443 B (+18,230, the calendar and the form) and no 58,159 B island
  // beside it (−39,929 B); `islands.sharedChunks` measured 254,863 here and +0.9–7 kB on four
  // other routes. Then −1,922 B: ui's keys tree-shaken per key (`ui-keys.ts`), and `mount`
  // returning its disposer — lowered 281kb → 240kb (plan 101 wave 10).
  // measured: 246537 B (2026-11-07, sweep 1; x build --target static) — why: core's `clientStream` sharing
  // `call()`'s unwrap (`settleAnswer`), `VirtualList` pruning heights of rows that left, the
  // router +122 B.
  budget: { js: '241kb' },
  // The URL rides along: the "created between" filter is read off it, in the member's zone.
  load: async ({ url }) => ({
    connections: await memberQueries.runConnections({ orgId: useActor().orgId }),
    url,
  }),
  meta: ({ t }) => ({ title: t('app.runs.metaTitle'), robots: { index: false } }),
});

type RunsData = {
  readonly connections: Awaited<ReturnType<typeof memberQueries.runConnections>>;
  readonly url: string;
};

/** Every word the island shows, translated here: a catalog cannot cross the wire. */
const consoleLabels = (t: ReturnType<typeof useT>): RunConsoleLabels => ({
  states: {
    pending: t('app.runs.state.pending'),
    streaming: t('app.runs.state.streaming'),
    awaiting: t('app.runs.state.awaiting'),
    failed: t('app.runs.state.failed'),
    done: t('app.runs.state.done'),
  },
  kinds: {
    prompt: t('app.runs.kind.prompt'),
    answered: t('app.runs.kind.answered'),
    navigated: t('app.runs.kind.navigated'),
    extracted: t('app.runs.kind.extracted'),
    done: t('app.runs.kind.done'),
    failed: t('app.runs.kind.failed'),
  },
  busy: t('app.runs.busy'),
  usage: {
    heading: t('app.runs.usage.heading'),
    browser: t('app.runs.usage.browser'),
    navigations: t('app.runs.usage.navigations'),
    requests: t('app.runs.usage.requests'),
    bytes: t('app.runs.usage.bytes'),
    prompts: t('app.runs.usage.prompts'),
    raw: t('app.runs.usage.raw'),
  },
  events: t('app.runs.events'),
  accounts: pluralFormsOf(t, 'app.runs.accounts'),
  output: t('app.runs.output'),
  log: t('app.runs.log'),
  resize: t('app.runs.resize'),
  connection: t('app.runs.connection'),
  start: t('app.runs.start'),
  cancel: t('app.runs.cancel'),
  idle: t('app.runs.idle'),
  connectHeading: t('app.runs.connect.heading'),
  connectName: t('app.runs.connect.name'),
  connectCredential: t('app.runs.connect.credential'),
  connectSubmit: t('app.runs.connect.submit'),
  promptLabel: t('app.runs.prompt.label'),
  promptSubmit: t('app.runs.prompt.submit'),
  faults: {
    connect: t('app.runs.fault.connect'),
    start: t('app.runs.fault.start'),
    answer: t('app.runs.fault.answer'),
    cancel: t('app.runs.fault.cancel'),
  },
});

export function Page(props: { readonly data: RunsData }): JSX.Element {
  const t = useT();
  const actor = useActor();
  const viewer = useViewer();
  const range = createdRange(props.data.url);
  const shown = withinCreated(props.data.connections, range, viewer.zone);
  const dayOf = new Map(shown.map((row) => [row.id, createdOn(row, viewer.zone)]));
  const filter: CreatedFilterProps = {
    from: range.from ?? null,
    to: range.to ?? null,
    labels: { legend: t('app.runs.created'), submit: t('app.runs.filter') },
  };

  return (
    <Layout banner={Banner} here="/runs">
      <div class={styles.page}>
        <h1>{t('app.runs.heading')}</h1>
        <Text tone="muted">{t('app.runs.intro')}</Text>
        {/* How the org's runs have gone over a window, as charts: a page of its own, 0 B of script. */}
        <Link href="/runs/health">{t('app.runs.healthLink')}</Link>
        {/*
          The connections by the day they were made: `<details>` and links, 0 B of script. A leaf
          filters the page to its day; the open branch is the day the filter already shows.
        */}
        <Tree
          label={t('app.runs.connection')}
          nodes={connectionsByDay(shown, viewer.zone, t.locale)}
          open={range.from !== undefined && range.from === range.to ? [`day:${range.from}`] : []}
          hrefFor={(node) => {
            const day = dayOf.get(node.id);
            return day === undefined ? '/runs' : dayHref(day);
          }}
        />
        {/* The island's wrapper; the server fills it with the filter, then the loading state. */}
        <Console
          orgId={actor.orgId}
          locale={t.locale}
          zone={viewer.zone}
          connections={shown.map((row) => ({ id: row.id, label: row.label }))}
          labels={consoleLabels(t)}
          ui={uiCatalog(t)}
          filter={filter}
        >
          {/* A GET form of two native date inputs, which filters with scripting off. */}
          <CreatedFilter {...filter} />
          <Skeleton lines={3} />
        </Console>
      </div>
    </Layout>
  );
}
