// The `--example` dashboard: the seeded `post` slice from above. Real rows through the slice's own
// query — never its repo, which the `boundaries` step refuses a route (X_BOUNDARY_ROUTE_TO_DB) —
// aggregated by a pure view module this file also emits, so the numbers are testable without a
// database. The page's route declaration and its island come from `scaffold-dashboard-shared.ts`.

import { sortedImports } from './imports';
import type { GeneratedFile, NameSet } from './naming';
import { examplePageTest, exampleViewTest } from './scaffold-dashboard-example-tests';
import { DASHBOARD_DIR, routeConfig, themeActions, themeIsland } from './scaffold-dashboard-shared';

// Plain strings for the framework lines, never template literals: the workspace-dependency scanner
// blanks a string's contents but not a nested template's, so a template here would bill the CLI
// for the imports of the app it writes.
const examplePage = (
  app: NameSet,
): string => `// The authed dashboard: what the seeded \`post\` slice looks like from above. Real rows, read
// through the slice's own query and aggregated by \`dashboard-view.ts\`, which is pure so the
// numbers are testable without a database. Every chart is server markup — an svg and a hidden data table —
// so the page's only script is still the theme toggle.
//
// \`useT()\`, not \`t\` from @ultimat3/i18n — see apps/web/site/page.tsx for why.
${sortedImports([
  `import { useT } from '@${app.kebab}/i18n';`,
  "import { isUltimateError } from '@ultimat3/core';",
  "import { currentLocale } from '@ultimat3/i18n';",
  "import { formatMoney } from '@ultimat3/money';",
  "import { defineRoute, island } from '@ultimat3/render';",
  [
    'import {',
    '  AreaChart,',
    '  DataTable,',
    '  DonutChart,',
    '  Gauge,',
    '  Grid,',
    '  InlineBar,',
    '  PageHeader,',
    '  RelativeTime,',
    '  Section,',
    '  StatTile,',
    '  ThemeToggle,',
    "} from '@ultimat3/ui';",
  ].join('\n'),
])}
import { Shell } from '../../shared/shell';
import { postList } from '../post/live/post-list';
import {
  bucketByDay,
  CHART_DAYS,
  formatCount,
  type PostRow,
  postStats,
  priceCeilings,
  priceMix,
  toPostRow,
} from './dashboard-view';
import styles from './page.module.scss';

/** The stat row counts what it can see. Past this many posts, write an aggregate query. */
const ROW_LIMIT = 500;

/** How many of the newest posts the table shows. */
const TABLE_ROWS = 10;

export interface DashboardData {
  /** Newest first, as the query orders them. */
  readonly rows: readonly PostRow[];
  /** The instant the windows were cut at, so server and test agree on "the last 7 days". */
  readonly now: string;
}

/**
 * What \`load\` answers, with the read as a parameter. The one branch a running app never takes is
 * the build's: \`x build --target static\` renders every route once to measure its JS budget with
 * no database wired, and that render gets the real empty branches — which weigh the same markup —
 * instead of a route the budget step cannot measure. Any other failure still propagates.
 */
export async function dashboardData(
  read: () => Promise<readonly Parameters<typeof toPostRow>[0][]>,
): Promise<DashboardData> {
  const now = new Date().toISOString();
  try {
    return { rows: (await read()).map(toPostRow), now };
  } catch (error) {
    if (isUltimateError(error) && error.code === 'X_DB_UNAVAILABLE') return { rows: [], now };
    throw error;
  }
}

/**
 * Whose posts: the ACTOR's org, and only for an actor \`post:read\` admits. Through the query, never
 * the repo: \`dashboard:read\` lets a viewer onto this page and says nothing about posts, and the
 * query is where the read's policy, order and bound live. The typed handle under it scopes every
 * read to the request's actor, so the viewer \`auth/dev-actor.ts\` resolves sees the rows
 * \`packages/db/src/seed.ts\` wrote, and a real session sees its own org's the day one exists.
 */
const load = (): Promise<DashboardData> => dashboardData(() => postList({ limit: ROW_LIMIT }));

${themeIsland}

${routeConfig('\n  load,')}

export interface PageProps {
  readonly data: DashboardData;
}

export function Page(props: PageProps) {
  const t = useT();
  const locale = currentLocale();
  const now = new Date(props.data.now);
  const stats = postStats(props.data.rows, now);
  const points = bucketByDay(props.data.rows, now, CHART_DAYS);
  const mix = priceMix(props.data.rows);
  const latest = props.data.rows.slice(0, TABLE_ROWS);
  // Per currency: a bar is a share of the dearest post IN ITS CURRENCY, never of another's minor units.
  const ceilings = priceCeilings(latest);

  return (
    <Shell
      nav="dashboard"
      actions={
        ${themeActions}
      }
    >
      <div class={styles.page}>
        <PageHeader title={t('app.dashboard.title')} description={t('app.dashboard.subtitle')} />
        {/* 10rem, not the catalog's 16rem default: two tiles sit side by side on a phone and four
            across a monitor, instead of one alone on a row. */}
        <Grid minColumn="10rem">
          <StatTile
            stat="posts-total"
            label={t('app.dashboard.statTotal')}
            value={formatCount(stats.total, locale)}
            hint={t('app.dashboard.hintTotal')}
          />
          <StatTile
            stat="posts-week"
            label={t('app.dashboard.statWeek')}
            value={formatCount(stats.lastWeek, locale)}
            delta={stats.delta}
            hint={t('app.dashboard.hintVsPriorWeek')}
          />
          <StatTile
            stat="posts-today"
            label={t('app.dashboard.statToday')}
            value={formatCount(stats.today, locale)}
            hint={t('app.dashboard.hintToday')}
          />
          <StatTile
            stat="posts-paid"
            label={t('app.dashboard.statPaid')}
            value={formatCount(mix.paid, locale)}
            hint={t('app.dashboard.hintPaid')}
          />
        </Grid>
        <div class={styles.charts}>
          <Section
            title={t('app.dashboard.chartTitle')}
            description={t('app.dashboard.chartRange')}
          >
            <AreaChart
              label={t('app.dashboard.chartLabel')}
              keys={points.map((point) => point.key)}
              series={[
                { label: t('app.dashboard.chartSeries'), values: points.map((p) => p.value) },
              ]}
              keyLabel={t('app.dashboard.chartKey')}
            />
          </Section>
          <Section title={t('app.dashboard.mixTitle')}>
            <div class={styles.side}>
              <DonutChart
                label={t('app.dashboard.mixLabel')}
                segments={[
                  { label: t('app.dashboard.mixFree'), value: mix.free },
                  { label: t('app.dashboard.mixPaid'), value: mix.paid },
                ]}
                centreLabel={t('app.dashboard.mixTotal')}
                keyLabel={t('app.dashboard.mixKey')}
                valueLabel={t('app.dashboard.statTotal')}
              />
              <Gauge
                label={t('app.dashboard.gaugeLabel')}
                value={stats.lastWeek}
                max={stats.total}
              />
            </div>
          </Section>
        </div>
        <Section title={t('app.dashboard.tableTitle')}>
          <DataTable
            caption={t('app.dashboard.tableCaption')}
            rowKey={(row: PostRow) => row.id}
            rows={latest}
            emptyTitle={t('app.dashboard.emptyTitle')}
            columns={[
              { key: 'title', header: t('app.dashboard.columnTitle'), cell: (row) => row.title },
              {
                key: 'price',
                header: t('app.dashboard.columnPrice'),
                numeric: true,
                cell: (row) => (
                  <InlineBar
                    value={row.price.minor}
                    max={ceilings.get(row.price.currency) ?? 0}
                    text={formatMoney(row.price, locale)}
                  />
                ),
              },
              {
                key: 'createdAt',
                header: t('app.dashboard.columnCreated'),
                // Below \`md\` the date folds into the row's "more" disclosure: the title and the
                // price are what a phone has room for, and nothing is lost.
                priority: 2,
                cell: (row) => (
                  <RelativeTime value={row.createdAt} now={props.data.now} locale={locale} />
                ),
              },
            ]}
          />
        </Section>
      </div>
    </Shell>
  );
}
`;

const exampleView =
  (): string => `// The dashboard's numbers, apart from its markup: pure functions over the rows the page loaded,
// so the server render and a test cannot disagree about a figure. No I/O, no \`t()\`, no JSX.

import type { Money } from '@ultimat3/money';
import { type ChartPoint, deltaOf, type StatDelta } from '@ultimat3/ui';

/** Days of history the chart shows, oldest first. */
export const CHART_DAYS = 14;

const DAY_MS = 86_400_000;

/** One post as the page reads it. \`createdAt\` is ISO text: a \`Date\` cannot cross a JSON seam. */
export interface PostRow {
  readonly id: string;
  readonly title: string;
  /** Integer minor units plus an ISO code, never a float — the entity's \`money()\` column. */
  readonly price: Money;
  readonly createdAt: string;
}

/**
 * Duck-typed rather than the entity's own row: the page only ever reads these four columns. The
 * query reads through the typed handle, so \`createdAt\` arrives as the \`Date\` the entity declares.
 */
export function toPostRow(row: {
  readonly id: string;
  readonly title: string;
  readonly price: Money;
  readonly createdAt: Date | string;
}): PostRow {
  const at = row.createdAt;
  return {
    id: row.id,
    title: row.title,
    price: row.price,
    createdAt: at instanceof Date ? at.toISOString() : at,
  };
}

/** Free (a zero price) against paid, over every row loaded — the two halves of the ring. */
export interface PriceMix {
  readonly free: number;
  readonly paid: number;
}

export function priceMix(rows: readonly PostRow[]): PriceMix {
  const paid = rows.filter((row) => row.price.minor > 0).length;
  return { free: rows.length - paid, paid };
}

/**
 * The dearest price per currency, in minor units — what each row's in-cell bar is a share of.
 * Per currency because 1,900 cents and 1,900 yen are not the same height.
 */
export function priceCeilings(rows: readonly PostRow[]): ReadonlyMap<string, number> {
  const ceilings = new Map<string, number>();
  for (const row of rows) {
    const { currency, minor } = row.price;
    ceilings.set(currency, Math.max(ceilings.get(currency) ?? 0, minor));
  }
  return ceilings;
}

export interface PostStats {
  readonly total: number;
  /** Created in the seven days ending at \`now\`. */
  readonly lastWeek: number;
  /** \`lastWeek\` against the seven days before it; absent when that baseline is zero. */
  readonly delta: StatDelta | undefined;
  /** Created in the UTC day \`now\` falls in — a partial day, so it carries no delta. */
  readonly today: number;
}

const createdAtOf = (row: PostRow): number => Date.parse(row.createdAt);

const within = (rows: readonly PostRow[], from: number, to: number): number =>
  rows.filter((row) => {
    const at = createdAtOf(row);
    return Number.isFinite(at) && at > from && at <= to;
  }).length;

export function postStats(rows: readonly PostRow[], now: Date): PostStats {
  const end = now.getTime();
  const weekAgo = end - 7 * DAY_MS;
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const lastWeek = within(rows, weekAgo, end);
  return {
    total: rows.length,
    lastWeek,
    delta: deltaOf(lastWeek, within(rows, weekAgo - 7 * DAY_MS, weekAgo)),
    today: within(rows, dayStart - 1, end),
  };
}

/** \`MM-DD\` of a UTC day. ISO, never \`toLocaleDateString\`: the chart's axis is data, not prose. */
const dayKey = (at: number): string => new Date(at).toISOString().slice(5, 10);

/**
 * One bucket per UTC day, the last one being the day \`now\` falls in, oldest first — the shape
 * \`BarChart\` draws. Every day is present even when nothing was created on it: a chart with the
 * quiet days removed reads as busier than the app is.
 */
export function bucketByDay(
  rows: readonly PostRow[],
  now: Date,
  days: number,
): readonly ChartPoint[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = today - (days - 1) * DAY_MS;
  const counts: number[] = Array.from({ length: days }, () => 0);
  for (const row of rows) {
    const at = createdAtOf(row);
    if (!Number.isFinite(at)) continue;
    const index = Math.floor((at - start) / DAY_MS);
    if (index >= 0 && index < days) counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts.map((value, index) => ({ key: dayKey(start + index * DAY_MS), value }));
}

/** A figure for a tile, in the page's locale. \`Intl.NumberFormat\` needs no time zone. */
export const formatCount = (value: number, locale: string): string =>
  new Intl.NumberFormat(locale).format(value);
`;

/** The example dashboard's page, view module and the tests beside both. */
export const exampleDashboardFiles = (app: NameSet): readonly GeneratedFile[] => [
  { path: `${DASHBOARD_DIR}/page.tsx`, contents: examplePage(app) },
  { path: `${DASHBOARD_DIR}/dashboard-view.ts`, contents: exampleView() },
  { path: `${DASHBOARD_DIR}/dashboard-view.test.ts`, contents: exampleViewTest() },
  { path: `${DASHBOARD_DIR}/page.test.ts`, contents: examplePageTest(app) },
];
