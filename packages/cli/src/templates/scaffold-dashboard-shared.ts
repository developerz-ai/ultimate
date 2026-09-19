// What both dashboards share — `scaffold-dashboard.ts` picks one of `scaffold-dashboard-example.ts`
// and `scaffold-dashboard-bare.ts` per invocation, and everything the two must agree on lives here:
// the route declaration, the theme island, the stylesheet and the config test.

export const DASHBOARD_DIR = 'apps/web/app/dashboard';

export const routeConfig = (load: string): string => `export const config = defineRoute({
  // 'ssr', not 'stream', and this is not a downgrade: 'stream' needs a boundary to stream into,
  // and the framework has no hole marker yet. Solid's <Suspense> is not it — it throws outside a
  // Solid renderer, and the server JSX factory is inert on purpose. A scaffolded 'stream' route
  // therefore failed x routes with X_ROUTE_MODE_INVALID on the first run, printing a fix nobody
  // could follow. Ship the mode that works. Async data needs no boundary: await it in the page.
  render: 'ssr',
  // 'visible' for the one island on this page, the theme toggle in the header.
  hydrate: 'visible',
  offline: 'runtime',
  // Auth is a policy, never a route-local flag: one authz system, evaluated everywhere.
  policy: { permission: 'dashboard:read' },
  // Only the toggle island hydrates; the tiles, the chart and the table are server markup. The
  // island measured 34.0kb minified under Bun 1.4.0 (37.0kb under 1.4.2, which honours
  // \`sideEffects\` and keeps core's declared modules) — solid-js is 15.1kb of it, the catalog's
  // toggle, provider, the ui runtime they share and the error registry are the rest. It was
  // 60.9kb before the framework stopped shipping solid-js twice and the i18n catalog with it
  // (issue #490), which is what put this at 64kb; 60kb is the figure the scaffold budgets held
  // before that, kept rather than tightened so a Bun patch cannot red a first \`bin/check\`.
  budget: { js: '60kb' },${load}
  meta: ({ t }) => ({
    title: t('app.dashboard.title'),
    description: t('app.dashboard.description'),
  }),
});`;

/** Declared ABOVE `defineRoute`: the route drains the island declarations made before it. */
export const themeIsland = `// Named by SPECIFIER, never by import (axiom 6): a string has no import edge, so the page's
// bundle graph stays the page's. \`props\` is the exact contract of \`ThemeToggleIslandProps\`.
const ThemeSwitch = island({ src: '../../shared/theme-toggle.island.tsx', props: ['locale'] });`;

/**
 * The pre-hydration shell: the catalog's toggle renders from server markup alone, so the served
 * document already shows the control the island takes over. `initial="dark"` is this app's
 * `theme.defaultMode`, stated once more here because the server has no browser to ask.
 */
export const themeActions = `<ThemeSwitch locale={locale}>
          <ThemeToggle mode="toggle" initial="dark" />
        </ThemeSwitch>`;

export const dashboardStyle = (): string => `@use '@ultimat3/ui/tokens' as tokens;

.page {
  display: flex;
  flex-direction: column;
  gap: tokens.space(6);
  // A measure, not the full monitor: past ~80rem a table row is too long to read across.
  max-inline-size: 80rem;
  margin-inline: auto;
  color: tokens.role('fg');
}
`;

export const dashboardPageTest =
  (): string => `// The dashboard renders per request, is gated by a policy, hydrates its one island, and stays
// under its budget. Losing the policy is the interesting regression: the page still renders, to
// anyone.
import { expect, unitTest } from '@ultimat3/testing';
import { config } from './page';

unitTest('the dashboard renders on the server, is gated, and has an offline strategy', () => {
  expect(config.render).toBe('ssr');
  expect(config.policy?.permission).toBe('dashboard:read');
  expect(config.offline).toBe('runtime');
});

unitTest('the dashboard hydrates its one island inside a stated budget', () => {
  expect(config.hydrate).toBe('visible');
  expect(config.budget.js).toBe('60kb');
});
`;
