// The authed dashboard of an app with no entity yet. Nothing here is invented: the tiles are the
// framework's own registries — routes, locales, roles, version — and the table is the route table
// `x routes` prints. NO CHART, deliberately: there is no series to draw until the first
// `x g resource`, and a chart of made-up numbers would be the first lie in the app.
//
// `useT()`, not `t` from @ultimat3/i18n — see apps/web/site/page.tsx for why.
import { catalogs, useT } from '@docs-site/i18n';
import { frameworkVersion } from '@ultimat3/core';
import { currentLocale } from '@ultimat3/i18n';
import { defineRoute, island, routeEntries } from '@ultimat3/render';
import { DataTable, Grid, PageHeader, Section, StatTile, ThemeToggle } from '@ultimat3/ui';
import { roles } from '../../shared/roles';
import { Shell } from '../../shared/shell';
import { factsOf, formatCount, type RouteRow, routeRows } from './dashboard-view';
import styles from './page.module.scss';

// Named by SPECIFIER, never by import (axiom 6): a string has no import edge, so the page's
// bundle graph stays the page's. `props` is the exact contract of `ThemeToggleIslandProps`.
const ThemeSwitch = island({ src: '../../shared/theme-toggle.island.tsx', props: ['locale'] });

export const config = defineRoute({
  // The app/ default: the shell flushes first, and a read moved into a <Hole> arrives after it.
  render: 'stream',
  // 'visible' for the one island on this page, the theme toggle in the header.
  hydrate: 'visible',
  offline: 'runtime',
  // Auth is a policy, never a route-local flag: one authz system, evaluated everywhere.
  policy: { permission: 'dashboard:read' },
  // Only the toggle island hydrates; the tiles, the chart and the table are server markup. The
  // island measured 34.0kb minified under Bun 1.4.0 (37.0kb under 1.4.2, which honours
  // `sideEffects` and keeps core's declared modules) — solid-js is 15.1kb of it, the catalog's
  // toggle, provider, the ui runtime they share and the error registry are the rest. It was
  // 60.9kb before the framework stopped shipping solid-js twice and the i18n catalog with it
  // (issue #490), which is what put this at 64kb; 60kb is the figure the scaffold budgets held
  // before that, kept rather than tightened so a Bun patch cannot red a first `bun run verify`.
  budget: { js: '60kb' },
  meta: ({ t }) => ({
    title: t('app.dashboard.title'),
    description: t('app.dashboard.description'),
  }),
});

export function Page() {
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
        <ThemeSwitch locale={locale}>
          <ThemeToggle mode="toggle" initial="dark" />
        </ThemeSwitch>
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
