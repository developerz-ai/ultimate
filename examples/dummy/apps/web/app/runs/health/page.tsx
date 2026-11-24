/**
 * `/runs/health`: how the org's syncs are going, at a glance and on a phone. The chart kit's run-
 * health page — a `HeatStrip` of every run by connection, a `LineChart` of events per run at each
 * run's true start (`at`), a `Gauge` whose `thresholds` pick its tone, an error tile that is bad
 * when it rises (`goodWhen="down"`) — in a `Grid`. Server-rendered and not live, so the
 * `LiveIndicator` says `paused` and the page says how to see newer runs: a refresh.
 *
 * Two reads through the typed query client, inside the request: the newest runs of the window a
 * `TimeRangePicker` holds in the URL (links and a GET form, 0 B of script), and the connections
 * that name the strip's rows. A route never touches the database.
 */

import { useT } from '@postly/i18n';
import { assertCoded, useContext } from '@ultimat3/core';
import { isEnabled } from '@ultimat3/flags';
import type { KnownPermission } from '@ultimat3/policy';
import { defineRoute } from '@ultimat3/render';
import {
  deltaOf,
  Gauge,
  Grid,
  HeatStrip,
  LineChart,
  LiveIndicator,
  Stack,
  StatTile,
  Text,
  TimeRangePicker,
} from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { useActor } from '../../../shared/actor';
import { memberQueries } from '../../../shared/client';
import { Layout, updateBannerIsland } from '../../layout';
import { runHealthEnabled } from './health-flag';
import { healthRange } from './health-range';
import type { RunHealthRow } from './health-view';
import { eventTrend, failureHalves, heatRows, successPercent } from './health-view';

/** The layout's update banner — an island of THIS route, so it is declared here. */
const Banner = updateBannerIsland('../../update-banner.island.tsx');

export interface RunHealthData {
  readonly runs: readonly RunHealthRow[];
  readonly connections: readonly { readonly id: string; readonly label: string }[];
  /** The request's URL and clock: the page re-reads the window `load` read, for its picker. */
  readonly url: string;
  readonly now: string;
}

export const config = defineRoute({
  render: 'ssr',
  // A run is not public: the coarse permission here, `runHealth`'s own `canRunRead` per row.
  policy: { permission: 'run:read' satisfies KnownPermission },
  offline: 'runtime',
  hydrate: 'idle',
  // measured: 33447 B (2026-11-06; x build --target static) — why: no island of its own — the
  // charts, the strip and the window picker are server markup, 0 B — so only what every `app/`
  // document carries: the client router 29,570, `/x-client-vitals.js` 1,202, the update banner
  // 710 and the inline runtime 1,965. The first budget this route has declared.
  // raised 33kb → 33.1kb. measured: 33822 B (2026-11-12; x build --target static) — why: the client
  // router grew 29,764 → 29,884 (+120 B): a stylesheet that fails to load on navigation now forces a
  // full load and keeps the old sheets, so a page is never left unstyled.
  // measured: 33993 B (2026-11-19; x build --target static) — why: +145 B, no island of its own:
  // the client router +45 B (29,910 → 29,955), a soft navigation to a malformed fragment (`#50%`)
  // still runs scripts and fires `ultimate:navigated`, and `navigate()` to a fragment of the page
  // on screen scrolls instead of refetching and disposing its islands; the inline hydration runtime
  // +100 B, an island boots with the props inside its own wrapper, not the first script in the
  // document with its id (a modal's island took the page's). Against 33,848, origin/main built the
  // same way. Raised 33.1kb → 33.2kb.
  // measured: 35942 B (2026-11-24; x build --target static) — why: the client router +1,949 B
  // (29,955 → 31,904): a soft visit to a `stream` page reads the answer as it arrives, swaps
  // the shell in at the server's flush mark and fills each hole as its chunk lands, so the page
  // paints before its slowest hole (65 ms p95 against 2,041 ms). Raised 33.2kb → 35.1kb.
  // measured: 36776 B (2026-11-24; x build --target static) — why: the client router +834 B
  // (31,904 → 32,738): a streamed soft visit scrolls to a fragment its hole brings, holds its
  // recovery while the next visit is on its way, reloads a fragment URL it must load for real,
  // and drops keep-alive frames as they arrive. Raised 35.1kb → 36kb.
  budget: { js: '36kb' },
  load: async ({ url }): Promise<RunHealthData> => {
    // The kill switch first: switched off, the page does not exist and neither read is sent.
    assertCoded(
      isEnabled(runHealthEnabled.key, useContext().actor),
      'X_NOT_FOUND',
      `/runs/health is switched off: the ${runHealthEnabled.key} flag answers false for this actor`,
      `applyFlagSnapshot({ '${runHealthEnabled.key}': { default: true } })   # from @ultimat3/flags`,
    );
    const actor = useActor();
    const now = new Date();
    const range = healthRange(url, { timeZone: actor.member.tz, now, label: (id) => id });
    const [runs, connections] = await Promise.all([
      memberQueries.runHealth({ orgId: actor.orgId, since: range.from, until: range.to }),
      memberQueries.runConnections({ orgId: actor.orgId }),
    ]);
    return {
      runs,
      connections: connections.map((row) => ({ id: row.id, label: row.label })),
      url,
      now: now.toISOString(),
    };
  },
  meta: ({ t }) => ({ title: t('app.runs.health.metaTitle'), robots: { index: false } }),
});

export function Page(props: { readonly data: RunHealthData }): JSX.Element {
  const t = useT();
  const zone = useActor().member.tz;
  const range = healthRange(props.data.url, {
    timeZone: zone,
    now: new Date(props.data.now),
    label: (id) => t(`app.runs.health.range.${id}`),
  });
  const clock = new Intl.DateTimeFormat(t.locale, { timeZone: zone, timeStyle: 'short' });
  const time = (at: Date): string => clock.format(at);
  const labels = new Map(props.data.connections.map((row) => [row.id, row.label] as const));
  const count = new Intl.NumberFormat(t.locale);
  const success = successPercent(props.data.runs);
  const failures = failureHalves(props.data.runs);
  const trend = eventTrend(props.data.runs, time);
  const rows = heatRows(props.data.runs, {
    connection: (id) => labels.get(id) ?? id,
    time,
    cell: (at, status) =>
      t('app.runs.health.cell', { time: at, status: t(`app.runs.health.status.${status}`) }),
  });

  return (
    <Layout banner={Banner} here="/runs">
      <Stack gap={6}>
        <header>
          <h1>{t('app.runs.health.heading')}</h1>
          <Text tone="muted">{t('app.runs.health.intro')}</Text>
          <LiveIndicator state="paused" />
          <Text tone="muted">{t('app.runs.health.snapshot')}</Text>
        </header>
        <TimeRangePicker range={range} timeZone={zone} label={t('app.runs.health.range.label')} />
        {/* 10rem: two tiles side by side on a phone, four across a monitor. */}
        <Grid minColumn="10rem">
          <StatTile
            stat="runs-total"
            label={t('app.runs.health.total')}
            value={count.format(props.data.runs.length)}
          />
          <StatTile
            stat="runs-failed"
            label={t('app.runs.health.failed')}
            value={count.format(failures.newer)}
            delta={deltaOf(failures.newer, failures.older, { absoluteBelow: 10 })}
            goodWhen="down"
            hint={t('app.runs.health.failedHint')}
          />
          <Gauge
            label={t('app.runs.health.success')}
            value={success}
            max={100}
            target={95}
            tone="danger"
            thresholds={[
              { at: 80, tone: 'warning' },
              { at: 95, tone: 'success' },
            ]}
          />
        </Grid>
        <HeatStrip label={t('app.runs.health.strip')} showCaption rows={rows} />
        <LineChart
          label={t('app.runs.health.trend')}
          showCaption
          focusable
          keys={trend.keys}
          at={trend.at}
          keyLabel={t('app.runs.health.trendKey')}
          series={[{ label: t('app.runs.health.trendSeries'), values: trend.values }]}
        />
      </Stack>
    </Layout>
  );
}
