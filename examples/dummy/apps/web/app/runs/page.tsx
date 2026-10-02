/**
 * The run console. The events are LIVE — they arrive over the sync node's socket as the job
 * writes them — so the page renders none of them: it renders what the server knows (the org's
 * connections, every label) and the island's loading shell, and `run-console.island.tsx` takes
 * over once a browser has booted it.
 *
 * `render: 'ssr'`: the one read here is the connection list, resolved in `load` through the typed
 * query client before the document is written — nothing on this page is a promise to stream, and
 * `stream` with no `<Suspense>` is `X_ROUTE_MODE_INVALID`. A route never touches the database.
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
import type { RunConsoleLabels } from './run-console.island';
import styles from './run-console.module.scss';

/** Declared ABOVE `defineRoute` so the route can drain it. `props` are the browser's keys. */
const Console = island({
  src: './run-console.island.tsx',
  props: ['orgId', 'locale', 'zone', 'connections', 'labels', 'ui'],
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
   */
  budget: { js: '130.5kb', lcp: 2000 },
  load: () => memberQueries.runConnections({ orgId: useActor().orgId }),
  meta: ({ t }) => ({ title: t('app.runs.metaTitle'), robots: { index: false } }),
});

type Connections = Awaited<ReturnType<typeof memberQueries.runConnections>>;

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
  },
  events: t('app.runs.events'),
  accounts: pluralFormsOf(t, 'app.runs.accounts'),
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

export function Page(props: { readonly data: Connections }): JSX.Element {
  const t = useT();
  const actor = useActor();
  const viewer = useViewer();

  return (
    <Layout banner={Banner}>
      <div class={styles.page}>
        <h1>{t('app.runs.heading')}</h1>
        <Text tone="muted">{t('app.runs.intro')}</Text>
        {/* The island's wrapper, and what the server puts inside it: the loading state. */}
        <Console
          orgId={actor.orgId}
          locale={t.locale}
          zone={viewer.zone}
          connections={props.data.map((row) => ({ id: row.id, label: row.label }))}
          labels={consoleLabels(t)}
          ui={uiStringsFor(t)}
        >
          <Skeleton lines={3} />
        </Console>
      </div>
    </Layout>
  );
}
