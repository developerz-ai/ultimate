// What both dashboards share — `scaffold-dashboard.ts` picks one of `scaffold-dashboard-example.ts`
// and `scaffold-dashboard-bare.ts` per invocation, and everything the two must agree on lives here:
// the route declaration, the theme island and the stylesheet.

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
  // before that, kept rather than tightened so a Bun patch cannot red a first \`bun run check\`.
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

// The trend beside the ring and the dial: side by side once the main column is wide enough for the
// area chart to keep its 14 day labels legible, stacked before that.
.charts {
  display: grid;
  gap: tokens.space(6);
  min-inline-size: 0;

  @include tokens.respond-to('lg') {
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
    align-items: start;
  }
}

// The ring and the dial share a column: two across on a tablet, where one alone would leave half
// the row empty, one above the other on a phone and in the narrow side column of a monitor.
.side {
  display: grid;
  gap: tokens.space(4);
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr));
}
`;

/**
 * `apps/web/shared/theme.ts`: the app's brand, which the boot reads by this path and inlines in every
 * document (`theme-brand.ts`). Emitted as the default theme — `defineTheme({})` renders no CSS, so
 * no tag and no CSP entry — with the preset one edit away: the look is the app's choice (axiom 8).
 */
export const themeFile =
  (): string => `// This app's brand: the boot reads \`brand\` from this file and inlines it in every document,
// after global.scss, with its hash in the CSP. \`defineTheme({})\` is @ultimat3/ui's default theme
// and renders nothing, so today no tag is emitted.
//
// \`defineTheme()\` is the one seam for restyling — colours, radii, fonts and shadows by role,
// validated at the call. The dashboard look (near-black panels, a cyan accent, glowing edges, its
// own eight chart series) is one edit:
//
//   export const brand = defineTheme({ preset: 'scifi' });
//
// Every other slot layers onto the preset role by role:
//   defineTheme({ preset: 'scifi', colors: { dark: { 'chart-1': '120 220 255' } } })
// A preset never forces a theme: to open dark whatever the OS says, set \`theme.defaultMode\` in
// app.config.ts.
import { defineTheme } from '@ultimat3/ui';

export const brand = defineTheme({});
`;

/** Its test: what the brand renders is a fact the app pins, so opting in is a visible diff. */
export const themeTest =
  (): string => `// The brand the boot inlines. The default theme renders no CSS — no \`<style>\`, no CSP entry —
// and the preset is a whole palette; either way \`defineTheme()\` validated it at import.
import { expect, unitTest } from '@ultimat3/testing';
import { defineTheme } from '@ultimat3/ui';
import { brand } from './theme';

unitTest('the app ships the default theme until it opts into a preset', () => {
  expect(brand.css).toBe('');
  // The opt-in is one edit, and what it would ship is real CSS the boot inlines.
  expect(defineTheme({ preset: 'scifi' }).css).toContain('--color-');
});
`;
