// The tests the `--example` dashboard ships beside its page and its view module — split from
// `scaffold-dashboard-example.ts` to keep each file under the ceiling. Emitted, never run here: the
// generated app's own `bun test` runs them, and the scaffold gate holds that run to green.

import { sortedImports } from './imports';
import type { NameSet } from './naming';

export const exampleViewTest =
  (): string => `// The numbers the dashboard shows, pinned against a fixed clock. The interesting cases are the
// window edges: a post from eight days ago is in the prior week, not this one, and a day with no
// posts is still a bar.
import { expect, unitTest } from '@ultimat3/testing';
import {
  bucketByDay,
  formatCount,
  type PostRow,
  postStats,
  priceCeilings,
  priceMix,
  toPostRow,
} from './dashboard-view';

const NOW = new Date('2026-03-15T12:00:00.000Z');
const DAY_MS = 86_400_000;

const row = (id: string, daysAgo: number, minor = 0, currency = 'USD'): PostRow => ({
  id,
  title: \`post \${id}\`,
  price: { minor, currency },
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

unitTest('toPostRow serialises a Date, passes ISO text through, and keeps the price whole', () => {
  const at = new Date('2026-01-02T03:04:05.000Z');
  const price = { minor: 1900, currency: 'USD' };
  expect(toPostRow({ id: 'x', title: 't', price, createdAt: at }).createdAt).toBe(at.toISOString());
  expect(toPostRow({ id: 'x', title: 't', price, createdAt: '2026-01-01' })).toEqual({
    id: 'x',
    title: 't',
    price,
    createdAt: '2026-01-01',
  });
});

unitTest('priceMix splits free from paid, and priceCeilings is the dearest per currency', () => {
  const priced = [row('a', 1, 0), row('b', 1, 1900), row('c', 1, 500), row('d', 1, 300, 'JPY')];
  expect(priceMix(priced)).toEqual({ free: 1, paid: 3 });
  expect(priceMix([])).toEqual({ free: 0, paid: 0 });
  // 300 yen is never measured against 1,900 cents: each currency has its own ceiling.
  expect([...priceCeilings(priced)]).toEqual([
    ['USD', 1900],
    ['JPY', 300],
  ]);
});

unitTest('formatCount follows the locale', () => {
  expect(formatCount(1234, 'en')).toBe('1,234');
  expect(formatCount(1234, 'de')).toBe('1.234');
});
`;

export const examplePageTest = (
  app: NameSet,
): string => `// The dashboard, rendered as a request renders it: \`load\` reads the actor's org through the
// slice's query — the in-memory driver under test — and the page turns the rows into tiles, a chart
// and a table. Losing a policy is the other regression worth a test: the page's own, and the read's
// — \`dashboard:read\` opens the page, and only \`post:read\` shows its posts.
${sortedImports([
  `import { driver } from '@${app.kebab}/db';`,
  `import { useT } from '@${app.kebab}/i18n';`,
  "import { ctxOf, frozenClock, isUltimateError, runWithContext } from '@ultimat3/core';",
  "import { testActor } from '@ultimat3/policy';",
  "import { dbUnavailable } from '@ultimat3/db';",
  "import { afterEach, expect, renderRoute, unitTest } from '@ultimat3/testing';",
])}
// The app's API, as boot loads it: \`defineApi\` is what names the query the page reads, and a
// query with no name is refused (X_QUERY_UNREGISTERED) before it reads a row.
import '../../api';
import { DEMO_ORG_ID } from '../../shared/demo-org';
import * as repo from '../post/repo';
import * as page from './page';

const url = 'https://example.test/dashboard';
// The read grant, a direct one: what a \`member\` holds in apps/web/shared/roles.ts.
const read = 'post:read';
const viewer = testActor('viewer', { orgId: DEMO_ORG_ID, permissions: [read] }).actor;
const elsewhere = '00000000-0000-4000-8000-000000000009';
const stranger = testActor('stranger', { orgId: elsewhere, permissions: [read] }).actor;

const DAY_MS = 86_400_000;

/**
 * One post in the viewer's org, written the way the app writes one — \`daysAgo\` days before now.
 * The request's clock is what stamps \`createdAt\`, so the test chooses the instant.
 */
const post = (title: string, daysAgo: number, minor = 0) => {
  const clock = frozenClock(new Date(Date.now() - daysAgo * DAY_MS));
  const draft = { orgId: DEMO_ORG_ID, title, price: { minor, currency: 'USD' } };
  return runWithContext(ctxOf({ actor: viewer, clock }), () => repo.insert(draft));
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
  await post('This week', 3, 1900);
  await post('Today', 0);
  const view = await renderRoute(page, { url, actor: viewer });
  // Newest first, as the query orders them — and each tile counts its own window.
  expect(view.data.rows.map((row) => row.title)).toEqual(['Today', 'This week', 'Last month']);
  expect(stat(view.html, 'posts-total')).toBe('3');
  expect(stat(view.html, 'posts-week')).toBe('2');
  expect(stat(view.html, 'posts-today')).toBe('1');
  expect(stat(view.html, 'posts-paid')).toBe('1');
  // One table row per post, each price with its in-cell bar.
  expect(view.html.match(/<tr[^>]*\\sdata-row=/g)).toHaveLength(3);
  expect(view.html.match(/data-inline-bar-value/g)).toHaveLength(3);
  expect(view.text).toContain('$19.00');
  // The trend is one filled series; the ring draws free and paid; the dial is a meter.
  expect(view.html.match(/data-area="true"/g)).toHaveLength(1);
  expect(view.html.match(/data-segment="/g)).toHaveLength(2);
  expect(view.html).toContain('role="meter"');
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
  expect(view.html).not.toMatch(/<tr[^>]*\\sdata-row=/);
  expect(view.text).toContain(t('app.dashboard.emptyTitle'));
  expect(view.meta.title).toBe(t('app.dashboard.title'));
  expect(view.meta.description).toBe(t('app.dashboard.description'));
});

unitTest('a viewer the post read refuses is refused, never shown the org’s posts', async () => {
  await post('Not for them', 0);
  // In the org, onto the page, without \`post:read\`: the query's policy decides, not the page's.
  const outsider = testActor('outsider', { orgId: DEMO_ORG_ID }).actor;
  const rendering = renderRoute(page, { url, actor: outsider });
  const refused = await rendering.catch((error: unknown) => error);
  expect(isUltimateError(refused) && refused.code).toBe('X_FORBIDDEN');
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
