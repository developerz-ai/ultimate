// `/admin/jobs` — the overview: depth tiles from one `stats()`, done-vs-failed over a chosen range,
// and per job name its volume, failure rate and mean duration. A plain read with a declared refresh
// (`<meta http-equiv="refresh">`): no socket, no script, the admin's zero-JS rule kept.

import { t } from '@ultimat3/i18n';
import { BarChart, Card, DataTable, Link, StatTile } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import type { AdminApp, AdminRoute } from '../admin';
import styles from '../admin.module.scss';
import { listHref } from '../list-request';
import { type AdminScreen, guardedScreen, widgetContextOf } from '../screen-frame';
import { JOB_ENTITY } from './job-entities';
import {
  type NameRow,
  OVERVIEW_RANGES,
  type OverviewData,
  type OverviewRange,
  overviewData,
  RANGE_PARAM,
  rangeOf,
} from './overview-data';

/** Seconds between the browser's own re-reads of the overview. A measurement, not a live feed. */
export const OVERVIEW_REFRESH_SECONDS = 30;

const TILE_STATES = ['ready', 'running', 'delayed', 'suspended', 'dead'] as const;

export interface JobsOverviewProps {
  readonly data: OverviewData;
  readonly range: OverviewRange;
  readonly locale: string;
  readonly timeZone: string;
  /** The runs list in one state, the workers list, the overview at a range: links, never calls. */
  readonly hrefs: {
    readonly state: (state: string) => string;
    readonly name: (name: string) => string;
    readonly workers: string;
    readonly range: (range: OverviewRange) => string;
  };
}

/** What the overview draws, from data alone — the `/_x` jobs tab renders this same component. */
export function JobsOverview(props: JobsOverviewProps): JSX.Element {
  const count = new Intl.NumberFormat(props.locale);
  const percent = new Intl.NumberFormat(props.locale, {
    style: 'percent',
    maximumFractionDigits: 1,
  });
  const bucket = new Intl.DateTimeFormat(props.locale, {
    timeZone: props.timeZone,
    ...(OVERVIEW_RANGES[props.range].ms > 86_400_000
      ? { month: 'short', day: 'numeric' }
      : { hour: '2-digit', minute: '2-digit' }),
  });
  const tile = (key: string, value: string, href: string): JSX.Element => (
    <li>
      <a href={href}>
        <StatTile label={t(`admin.jobs.tile.${key}`)} value={value} stat={key} />
      </a>
    </li>
  );
  const columns = [
    {
      key: 'name',
      header: t('admin.jobs.byName.name'),
      cell: (row: NameRow) => <Link href={props.hrefs.name(row.name)}>{row.name}</Link>,
    },
    {
      key: 'volume',
      header: t('admin.jobs.byName.volume'),
      numeric: true,
      cell: (row: NameRow) => <span>{count.format(row.volume)}</span>,
    },
    {
      key: 'failureRate',
      header: t('admin.jobs.byName.failureRate'),
      numeric: true,
      cell: (row: NameRow) => (
        <span>
          {row.failureRate === null ? t('admin.value.empty') : percent.format(row.failureRate)}
        </span>
      ),
    },
    {
      key: 'meanMs',
      header: t('admin.jobs.byName.meanMs'),
      numeric: true,
      cell: (row: NameRow) => (
        <span>
          {row.meanMs === null
            ? t('admin.value.empty')
            : t('admin.jobs.ms', { ms: count.format(Math.round(row.meanMs)) })}
        </span>
      ),
    },
  ];
  return (
    <>
      <ul class={styles['tiles']}>
        {TILE_STATES.map((state) =>
          tile(state, count.format(props.data.totals[state]), props.hrefs.state(state)),
        )}
        {tile('workers', count.format(props.data.workers), props.hrefs.workers)}
        {tile(
          'oldestReady',
          t('admin.jobs.seconds', {
            seconds: count.format(Math.round(props.data.oldestReadyMs / 1000)),
          }),
          props.hrefs.state('ready'),
        )}
      </ul>
      <nav aria-label={t('admin.jobs.range.label')}>
        <ul class={styles['scopes']}>
          {(Object.keys(OVERVIEW_RANGES) as OverviewRange[]).map((range) => (
            <li>
              <Link
                href={props.hrefs.range(range)}
                {...(range === props.range ? { 'aria-current': 'page' } : {})}
              >
                {t(`admin.jobs.range.${range}`)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <Card header={<h2>{t('admin.jobs.chart.title')}</h2>}>
        <BarChart
          label={t('admin.jobs.chart.label', { range: t(`admin.jobs.range.${props.range}`) })}
          points={props.data.bars.map((bar) => ({
            key: bucket.format(new Date(bar.startMs)),
            value: bar.done,
            secondary: bar.failed,
          }))}
          seriesLabels={{
            primary: t('admin.jobs.chart.done'),
            secondary: t('admin.jobs.chart.failed'),
          }}
        />
      </Card>
      <DataTable
        caption={t('admin.jobs.byName.caption')}
        columns={columns}
        rows={props.data.names}
        rowKey={(row) => row.name}
        emptyTitle={t('admin.jobs.byName.empty')}
      />
    </>
  );
}

/** The overview screen: decided by the route's own pair (`admin:read` + `job:read`) first. */
export function jobsOverviewScreen(app: AdminApp, route: AdminRoute): AdminScreen {
  return guardedScreen(app, route, async (request) => {
    const runs = app.resource(JOB_ENTITY.jobs);
    const refresh = <meta http-equiv="refresh" content={String(OVERVIEW_REFRESH_SECONDS)} />;
    // The fleet's numbers are every tenant's: an org-scoped operator is sent to their own rows.
    if (request.ctx.actor.orgId !== undefined) {
      return (
        <p class={styles['note']}>
          {t('admin.jobs.scoped')}{' '}
          <Link href={listHref(app.basePath, runs)}>{t(runs.titleKey)}</Link>
        </p>
      );
    }
    const url = new URL(request.url);
    // An unknown `?range=` is refused by name — the frame answers it 400, as a list's filter is.
    const range = rangeOf(url);
    const ctx = widgetContextOf(app, request.ctx);
    const data = await overviewData(range, Date.now());
    return (
      <>
        {refresh}
        <JobsOverview
          data={data}
          range={range}
          locale={ctx.locale}
          timeZone={ctx.timeZone}
          hrefs={{
            state: (state) => listHref(app.basePath, runs, { scope: state }),
            name: (name) =>
              listHref(app.basePath, runs, { filters: [{ field: 'name', op: 'eq', value: name }] }),
            workers: listHref(app.basePath, app.resource(JOB_ENTITY.workers)),
            range: (next) => `${url.pathname}?${RANGE_PARAM}=${next}`,
          }}
        />
      </>
    );
  });
}
