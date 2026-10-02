// The `--example` dashboard: the seeded `post` slice from above. Real rows through the slice's own
// repo, aggregated by a pure view module this file also emits, so the numbers are testable without
// a database. The page's route declaration and its island come from `scaffold-dashboard-shared.ts`.

import { sortedImports } from './imports';
import type { GeneratedFile, NameSet } from './naming';
import { DASHBOARD_DIR, routeConfig, themeActions, themeIsland } from './scaffold-dashboard-shared';

// Plain strings for the framework lines, never template literals: the workspace-dependency scanner
// blanks a string's contents but not a nested template's, so a template here would bill the CLI
// for the imports of the app it writes.
const examplePage = (
  app: NameSet,
): string => `// The authed dashboard: what the seeded \`post\` slice looks like from above. Real rows, read
// through the slice's own repo and aggregated by \`dashboard-view.ts\`, which is pure so the numbers
// are testable without a database.
//
// \`useT()\`, not \`t\` from @ultimat3/i18n — see apps/web/site/page.tsx for why.
${sortedImports([
  `import { useT } from '@${app.kebab}/i18n';`,
  "import { isUltimateError } from '@ultimat3/core';",
  "import { currentLocale } from '@ultimat3/i18n';",
  "import { defineRoute, island } from '@ultimat3/render';",
  [
    'import {',
    '  BarChart,',
    '  DataTable,',
    '  Grid,',
    '  PageHeader,',
    '  RelativeTime,',
    '  Section,',
    '  StatTile,',
    '  ThemeToggle,',
    "} from '@ultimat3/ui';",
  ].join('\n'),
])}
import { Shell } from '../../shared/shell';
import * as repo from '../post/repo';
import {
  bucketByDay,
  CHART_DAYS,
  formatCount,
  type PostRow,
  postStats,
  toPostRow,
} from './dashboard-view';
import styles from './page.module.scss';

/** The stat row counts what it can see. Past this many posts, write an aggregate query. */
const ROW_LIMIT = 500;

/** How many of the newest posts the table shows. */
const TABLE_ROWS = 10;

export interface DashboardData {
  /** Newest first, as the repo orders them. */
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
 * Whose posts: the ACTOR's org. The repo names none — the typed handle scopes every read to the
 * request's actor — so the viewer \`auth/dev-actor.ts\` resolves sees the rows
 * \`packages/db/src/seed.ts\` wrote, and a real session sees its own org's the day one exists.
 */
const load = (): Promise<DashboardData> => dashboardData(() => repo.list(ROW_LIMIT));

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
  const latest = props.data.rows.slice(0, TABLE_ROWS);

  return (
    <Shell
      nav="dashboard"
      actions={
        ${themeActions}
      }
    >
      <div class={styles.page}>
        <PageHeader title={t('app.dashboard.title')} description={t('app.dashboard.subtitle')} />
        {/* 10rem, not the catalog's 16rem default: three tiles fit across a tablet's main column
            instead of leaving one alone on a second row. */}
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
        </Grid>
        <Section title={t('app.dashboard.chartTitle')} description={t('app.dashboard.chartRange')}>
          <BarChart label={t('app.dashboard.chartLabel')} points={points} />
        </Section>
        <Section title={t('app.dashboard.tableTitle')}>
          <DataTable
            caption={t('app.dashboard.tableCaption')}
            rowKey={(row: PostRow) => row.id}
            rows={latest}
            emptyTitle={t('app.dashboard.emptyTitle')}
            columns={[
              { key: 'title', header: t('app.dashboard.columnTitle'), cell: (row) => row.title },
              {
                key: 'createdAt',
                header: t('app.dashboard.columnCreated'),
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

import { type ChartPoint, deltaOf, type StatDelta } from '@ultimat3/ui';

/** Days of history the chart shows, oldest first. */
export const CHART_DAYS = 14;

const DAY_MS = 86_400_000;

/** One post as the page reads it. \`createdAt\` is ISO text: a \`Date\` cannot cross a JSON seam. */
export interface PostRow {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
}

/**
 * Duck-typed rather than the entity's own row: the page only ever reads these three columns. The
 * repo reads through the typed handle, so \`createdAt\` arrives as the \`Date\` the entity declares.
 */
export function toPostRow(row: {
  readonly id: string;
  readonly title: string;
  readonly createdAt: Date | string;
}): PostRow {
  const at = row.createdAt;
  return {
    id: row.id,
    title: row.title,
    createdAt: at instanceof Date ? at.toISOString() : at,
  };
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

const exampleViewTest =
  (): string => `// The numbers the dashboard shows, pinned against a fixed clock. The interesting cases are the
// window edges: a post from eight days ago is in the prior week, not this one, and a day with no
// posts is still a bar.
import { expect, unitTest } from '@ultimat3/testing';
import { bucketByDay, formatCount, type PostRow, postStats, toPostRow } from './dashboard-view';

const NOW = new Date('2026-03-15T12:00:00.000Z');
const DAY_MS = 86_400_000;

const row = (id: string, daysAgo: number): PostRow => ({
  id,
  title: \`post \${id}\`,
  createdAt: new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString(),
});

const rows = [row('a', 1), row('b', 3), row('c', 8)];

unitTest('postStats counts the week, compares it with the prior one, and counts today', () => {
  const stats = postStats(rows, NOW);
  expect(stats.total).toBe(3);
  expect(stats.lastWeek).toBe(2);
  // Two this week against one the week before: +100%, and the chip says so.
  expect(stats.delta).toEqual({ text: '+100%', trend: 'up' });
  // 'a' is yesterday and nothing was created on 03-15 itself.
  expect(stats.today).toBe(0);
  expect(postStats([...rows, row('d', 0.25)], NOW).today).toBe(1);
});

unitTest('a zero baseline yields no delta, and no rows count nothing', () => {
  expect(postStats([row('a', 1)], NOW).delta).toBeUndefined();
  expect(postStats([], NOW)).toEqual({ total: 0, lastWeek: 0, delta: undefined, today: 0 });
});

unitTest('bucketByDay is one bar per day, oldest first, quiet days included', () => {
  const points = bucketByDay(rows, NOW, 14);
  expect(points).toHaveLength(14);
  expect(points.at(-1)?.key).toBe('03-15');
  expect(points[0]?.key).toBe('03-02');
  expect(points.reduce((sum, point) => sum + point.value, 0)).toBe(3);
  // Eight days ago is 03-07: inside a 14-day window, so the bar is there.
  expect(points.find((point) => point.key === '03-07')?.value).toBe(1);
  expect(bucketByDay([], NOW, 3).map((point) => point.value)).toEqual([0, 0, 0]);
});

unitTest('toPostRow serialises a Date and passes ISO text through', () => {
  const at = new Date('2026-01-02T03:04:05.000Z');
  expect(toPostRow({ id: 'x', title: 't', createdAt: at }).createdAt).toBe(at.toISOString());
  expect(toPostRow({ id: 'x', title: 't', createdAt: '2026-01-01' }).createdAt).toBe('2026-01-01');
});

unitTest('formatCount follows the locale', () => {
  expect(formatCount(1234, 'en')).toBe('1,234');
  expect(formatCount(1234, 'de')).toBe('1.234');
});
`;

const examplePageTest = (
  app: NameSet,
): string => `// The dashboard, rendered as a request renders it: \`load\` reads the actor's org through the
// slice's repo — the in-memory driver under test — and the page turns the rows into tiles, a chart
// and a table. Losing the policy is the other regression worth a test: the page still renders, to
// anyone.
${sortedImports([
  `import { driver } from '@${app.kebab}/db';`,
  `import { useT } from '@${app.kebab}/i18n';`,
  "import { createContext, frozenClock, runWithContext } from '@ultimat3/core';",
  "import { testActor } from '@ultimat3/policy';",
  "import { dbUnavailable } from '@ultimat3/db';",
  "import { afterEach, expect, renderRoute, unitTest } from '@ultimat3/testing';",
])}
import { DEMO_ORG_ID } from '../../shared/demo-org';
import * as repo from '../post/repo';
import * as page from './page';

const url = 'https://example.test/dashboard';
const viewer = testActor('viewer', { orgId: DEMO_ORG_ID }).actor;
const stranger = testActor('stranger', { orgId: '00000000-0000-4000-8000-000000000009' }).actor;

const DAY_MS = 86_400_000;

/**
 * One post in the viewer's org, written the way the app writes one — \`daysAgo\` days before now.
 * The request's clock is what stamps \`createdAt\`, so the test chooses the instant.
 */
const post = (title: string, daysAgo: number) => {
  const clock = frozenClock(new Date(Date.now() - daysAgo * DAY_MS));
  const draft = { orgId: DEMO_ORG_ID, title, price: { minor: 0, currency: 'USD' } };
  return runWithContext(createContext({ actor: viewer, clock }), () => repo.insert(draft));
};

/** The figure a tile shows, read off the markup by the \`stat\` the page gave it. */
const stat = (html: string, name: string): string | undefined =>
  html.match(new RegExp(\`data-stat="\${name}">([^<]*)<\`))?.[1];

// One store per process: without this, one test's rows are the next test's fixtures.
afterEach(() => {
  driver.reset?.();
});

unitTest('the dashboard is gated, renders per request, and hydrates one island', async () => {
  const view = await renderRoute(page, { url, actor: viewer });
  expect(page.config.render).toBe('ssr');
  expect(page.config.policy?.permission).toBe('dashboard:read');
  expect(page.config.offline).toBe('runtime');
  expect(page.config.budget.js).toBe('60kb');
  // What the render emitted, beside what the config declares: the theme toggle, and only it.
  expect(view.islands.map((island) => [island.moduleId, island.strategy])).toEqual([
    ['shared-theme-toggle', 'visible'],
  ]);
});

unitTest('it counts and lists the posts of the org that is looking', async () => {
  await post('Last month', 30);
  await post('This week', 3);
  await post('Today', 0);
  const view = await renderRoute(page, { url, actor: viewer });
  // Newest first, as the repo orders them — and each tile counts its own window.
  expect(view.data.rows.map((row) => row.title)).toEqual(['Today', 'This week', 'Last month']);
  expect(stat(view.html, 'posts-total')).toBe('3');
  expect(stat(view.html, 'posts-week')).toBe('2');
  expect(stat(view.html, 'posts-today')).toBe('1');
  // One table row per post, and one bar per day of the window whether or not it has posts.
  expect(view.html.match(/<tr data-row=/g)).toHaveLength(3);
  expect(view.html.match(/data-bar="true"/g)).toHaveLength(14);
  expect(view.text).toContain('This week');
  // The sidebar knows where it is.
  expect(view.html).toMatch(/<a href="\\/dashboard" aria-current="page"/);
});

unitTest('another org sees none of them: the page says so instead of an empty table', async () => {
  const t = useT();
  await post('Not theirs', 0);
  const view = await renderRoute(page, { url, actor: stranger });
  expect(view.data.rows).toEqual([]);
  expect(stat(view.html, 'posts-total')).toBe('0');
  expect(view.html).not.toContain('<tr data-row=');
  expect(view.text).toContain(t('app.dashboard.emptyTitle'));
  expect(view.meta.title).toBe(t('app.dashboard.title'));
  expect(view.meta.description).toBe(t('app.dashboard.description'));
});

unitTest('the build measures the empty page: no database is not a failure there', async () => {
  const measured = await page.dashboardData(() => Promise.reject(dbUnavailable('no database')));
  // The clock is frozen under test, so the instant the windows are cut at is this one.
  expect(measured).toEqual({ rows: [], now: new Date().toISOString() });
});

unitTest('any other failure of the read propagates', async () => {
  const cause = new TypeError('the read broke');
  const read = (): Promise<never> => Promise.reject(cause);
  expect(await page.dashboardData(read).catch((error: unknown) => error)).toBe(cause);
});
`;

/** The example dashboard's page, view module and the tests beside both. */
export const exampleDashboardFiles = (app: NameSet): readonly GeneratedFile[] => [
  { path: `${DASHBOARD_DIR}/page.tsx`, contents: examplePage(app) },
  { path: `${DASHBOARD_DIR}/dashboard-view.ts`, contents: exampleView() },
  { path: `${DASHBOARD_DIR}/dashboard-view.test.ts`, contents: exampleViewTest() },
  { path: `${DASHBOARD_DIR}/page.test.ts`, contents: examplePageTest(app) },
];
