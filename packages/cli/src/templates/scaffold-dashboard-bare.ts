// The `--no-example` dashboard: framework facts and the route table, and no chart — there is no
// series to draw until the first `x g resource`, and a chart of invented numbers would be the first
// lie in the app. The route declaration and the island come from `scaffold-dashboard-shared.ts`.

import { sortedImports } from './imports';
import type { GeneratedFile, NameSet } from './naming';
import { DASHBOARD_DIR, routeConfig, themeActions, themeIsland } from './scaffold-dashboard-shared';

// Plain strings for the framework lines, never template literals: the workspace-dependency scanner
// blanks a string's contents but not a nested template's, so a template here would bill the CLI
// for the imports of the app it writes.
const barePage = (
  app: NameSet,
): string => `// The authed dashboard of an app with no entity yet. Nothing here is invented: the tiles are the
// framework's own registries — routes, locales, roles, version — and the table is the route table
// \`x routes\` prints. NO CHART, deliberately: there is no series to draw until the first
// \`x g resource\`, and a chart of made-up numbers would be the first lie in the app.
//
// \`useT()\`, not \`t\` from @ultimat3/i18n — see apps/web/site/page.tsx for why.
${sortedImports([
  `import { catalogs, useT } from '@${app.kebab}/i18n';`,
  "import { frameworkVersion } from '@ultimat3/core';",
  "import { currentLocale } from '@ultimat3/i18n';",
  "import { defineRoute, island, routeEntries } from '@ultimat3/render';",
  "import { DataTable, Grid, PageHeader, Section, StatTile, ThemeToggle } from '@ultimat3/ui';",
])}
import { roles } from '../../shared/roles';
import { Shell } from '../../shared/shell';
import { factsOf, formatCount, type RouteRow, routeRows } from './dashboard-view';
import styles from './page.module.scss';

${themeIsland}

${routeConfig('')}

export function DashboardPage() {
  const t = useT();
  const locale = currentLocale();
  // Read at render, not at import: the registries are filled by the boot scan, after this module.
  const entries = routeEntries();
  const facts = factsOf({
    routes: entries.length,
    locales: catalogs.locales.length,
    roles: Object.keys(roles).length,
    version: frameworkVersion(),
  });
  const rows = routeRows(entries);

  return (
    <Shell
      nav="dashboard"
      actions={
        ${themeActions}
      }
    >
      <div class={styles.page}>
        <PageHeader title={t('app.dashboard.title')} description={t('app.dashboard.subtitle')} />
        {/* 12rem, not the catalog's 16rem default: four tiles pair up two-by-two on a tablet's main
            column and sit in one row on a desktop, never three and an orphan. */}
        <Grid minColumn="12rem">
          <StatTile
            stat="routes"
            label={t('app.dashboard.statRoutes')}
            value={formatCount(facts.routes, locale)}
            hint={t('app.dashboard.hintRoutes')}
          />
          <StatTile
            stat="locales"
            label={t('app.dashboard.statLocales')}
            value={formatCount(facts.locales, locale)}
            hint={t('app.dashboard.hintLocales')}
          />
          <StatTile
            stat="roles"
            label={t('app.dashboard.statRoles')}
            value={formatCount(facts.roles, locale)}
            hint={t('app.dashboard.hintRoles')}
          />
          <StatTile
            stat="version"
            label={t('app.dashboard.statVersion')}
            value={facts.version}
            hint={t('app.dashboard.hintVersion')}
          />
        </Grid>
        <Section title={t('app.dashboard.routesTitle')}>
          <DataTable
            caption={t('app.dashboard.routesCaption')}
            rowKey={(row: RouteRow) => row.path}
            rows={rows}
            columns={[
              { key: 'path', header: t('app.dashboard.columnPath'), cell: (row) => row.path },
              {
                key: 'surface',
                header: t('app.dashboard.columnSurface'),
                cell: (row) => row.surface,
              },
              { key: 'render', header: t('app.dashboard.columnRender'), cell: (row) => row.render },
            ]}
          />
        </Section>
      </div>
    </Shell>
  );
}
`;

const bareView =
  (): string => `// The dashboard's facts, apart from its markup: pure projections of what the framework registered,
// so the page and a test read the same shape. No I/O, no \`t()\`, no JSX.

/** The three columns of the route table, as \`x routes\` prints them. */
export interface RouteRow {
  readonly path: string;
  readonly surface: string;
  readonly render: string;
}

/** What \`routeEntries()\` hands over, narrowed to the fields the table reads. */
export interface RouteLike {
  readonly path: string;
  readonly surface: string;
  readonly config: { readonly render: string };
}

/** Sorted by path in code-unit order — the order \`x routes\` and the manifest both use. */
export const routeRows = (entries: readonly RouteLike[]): readonly RouteRow[] =>
  entries
    .map((entry) => ({ path: entry.path, surface: entry.surface, render: entry.config.render }))
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

export interface FrameworkFacts {
  readonly routes: number;
  readonly locales: number;
  readonly roles: number;
  readonly version: string;
}

/** Counts are never negative, and a blank version is reported as unknown rather than as nothing. */
export const factsOf = (input: FrameworkFacts): FrameworkFacts => ({
  routes: Math.max(0, input.routes),
  locales: Math.max(0, input.locales),
  roles: Math.max(0, input.roles),
  version: input.version === '' ? 'unknown' : input.version,
});

/** A figure for a tile, in the page's locale. \`Intl.NumberFormat\` needs no time zone. */
export const formatCount = (value: number, locale: string): string =>
  new Intl.NumberFormat(locale).format(value);
`;

const bareViewTest = (): string => `// The route table and the fact tiles, pinned on fixed input.
import { expect, unitTest } from '@ultimat3/testing';
import { factsOf, formatCount, routeRows } from './dashboard-view';

unitTest('routeRows projects the three columns and sorts by path', () => {
  const rows = routeRows([
    { path: '/dashboard', surface: 'app', config: { render: 'ssr' } },
    { path: '/', surface: 'site', config: { render: 'static' } },
  ]);
  expect(rows.map((row) => row.path)).toEqual(['/', '/dashboard']);
  expect(rows[1]).toEqual({ path: '/dashboard', surface: 'app', render: 'ssr' });
});

unitTest('factsOf clamps counts and names an unknown version', () => {
  const facts = factsOf({ routes: -1, locales: 1, roles: 2, version: '' });
  expect(facts).toEqual({ routes: 0, locales: 1, roles: 2, version: 'unknown' });
  expect(factsOf({ routes: 3, locales: 1, roles: 2, version: '1.2.3' }).version).toBe('1.2.3');
});

unitTest('formatCount follows the locale', () => {
  expect(formatCount(1234, 'en')).toBe('1,234');
  expect(formatCount(1234, 'de')).toBe('1.234');
});
`;

/** The bare dashboard's page, view module and view test. */
export const bareDashboardFiles = (app: NameSet): readonly GeneratedFile[] => [
  { path: `${DASHBOARD_DIR}/page.tsx`, contents: barePage(app) },
  { path: `${DASHBOARD_DIR}/dashboard-view.ts`, contents: bareView() },
  { path: `${DASHBOARD_DIR}/dashboard-view.test.ts`, contents: bareViewTest() },
];
