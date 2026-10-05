# 14 — Dashboards: charts, tables and a sci-fi theme that hold up on a phone

> Part of [`overview.md`](overview.md). Added by the owner 2026-10-05: "nice dashboard charts,
> tables etc, nice sci-fi, great, awesome, also nice for mobile". **Sweep 9b**, after 9, before 10.
> Inventory at `836ecb02`, 2026-10-05 (the evidence below).

## Rule
Mechanism, not convention (axiom 8): ui ships chart and table **components** and a **theme preset**
an app opts into. Server-rendered SVG and HTML first; no chart library (`18-build-vs-wrap.md`); a
chart adds no island and no JS to a route that does not ask for interaction (axiom 6). Tokens only,
contrast-gated, every string through `t()`, every chart readable without colour and without a mouse.

## State
- Charts: `BarChart` (SVG, stacked second series) and `Sparkline`. No line/area, donut, legend,
  tooltip, keyboard layer or data-table fallback.
- Tables: `Table` (caption, sticky header, scroll wrapper) and `DataTable` (sort, cursor paging,
  states). No mobile card-collapse, sticky first column, column priority or in-cell bars.
- Tokens: 24 colour roles, no chart series roles, black-only shadows, no glow, no tabular-figure
  slot, no touch-target token. `defineTheme` covers colours, radius and font only. No presets.
- Surfaces: `/admin` home is a permission matrix (no KPIs); `/_x` panels are `<pre>` JSON except jobs;
  `AppShell` and the admin sidebar stack above content below `md` instead of collapsing.

## Agents (≤ 4, disjoint)

| Agent | Scope | Exclusive paths |
|---|---|---|
| A — tokens + preset | chart series roles `chart-1..8` (categorical, colour-blind safe, in `CONTRAST_PAIRS` against both surfaces), `glow-*` and coloured elevation shadow tokens, `font.data` (tabular figures) slot, `touch-target` token, a `scifi` theme preset (deep surfaces, cyan/magenta accents, glow edges, grid texture mixin) selectable by `defineTheme({ preset: 'scifi' })`; `defineTheme` gains shadows | `packages/ui/src/tokens/**`, `packages/ui/src/theme/**` |
| B — charts | `LineChart` / `AreaChart` (multi-series, axes with nice ticks, legend), `DonutChart`, `Gauge`; shared `chart-frame` (figure + caption + legend + visually-hidden data table fallback); keyboard focus per point with an `aria-live` readout; responsive by container query; `BarChart` gains the legend and fallback | `packages/ui/src/components/charts/**` and the existing chart files |
| C — tables + shell | `DataTable` mobile mode: rows collapse to labelled cards below `sm` (CSS only); `stickyFirstColumn`; column `priority` hiding; `InlineBar` cell renderer; `AppShell` and admin layout collapse the sidebar into the existing `Drawer` below `md` (one island, budgeted) | `packages/ui/src/components/{DataTable,Table,AppShell,Drawer}*`, `packages/admin/src/layout*` |
| D — surfaces | `/admin` home KPI row (counts per resource, recent activity as a `LineChart`); `/_x` timeline as a server-rendered waterfall and the jobs panel with charts; the scaffold's example dashboard and the social demo's dashboard use the new pieces and the preset; `x shot --viewport 390x844,1440x900` screenshots in the PR | `packages/admin/src/screen-home*`, `packages/admin/src/dev/**`, `packages/cli/src/templates/scaffold-dashboard*`, `dummy/social-media-clone/apps/web/app/dashboard/**` |

## Done when
- Every new component has unit tests (structure, a11y names, keyboard, the fallback table) and a
  390 px and a 1440 px screenshot in the PR; no route budget moves without a measured raise and its
  reason; `contrast.test.ts` covers every new role; `bun run verify` and the app gate are green.
