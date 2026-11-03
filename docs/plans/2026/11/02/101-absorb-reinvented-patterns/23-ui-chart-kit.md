# 23-ui-chart-kit — Charts a live, mobile dashboard can stand on

> Part of [`overview.md`](overview.md). Depends on: [`23-ui-data-table.md`](23-ui-data-table.md) (`Sparkline` `null`, the keyed-node rule). Tier: 4 (`ui`), 5 (`cli` templates).

## Why
Every serious dashboard hits these, whoever builds it; four adopters wrote their own chart kits, inside `ui` packages of 3,221 to 4,749 LOC; one builds on `ChartFrame`, one on `CHART_SERIES_SLOTS`. `Gauge`, `StatTile`, `DonutChart` and `LineChart` `null` gaps are shipped; what follows is not. Probe output, from the pure view modules:
- `barRects([{value:-5},{value:10}])` heights `[2,104]`; `value: NaN` also `2`. Negative, missing and zero are one 2 px bar (`bar-chart-view.ts:6,63`). "Caller zero-fills" (`BarChart.tsx:23`) makes no-data read as zero.
- `sparklinePath` over `-5,0,5`: `M4,68 L300,68 L596,4`. The clamp at `sparkline-view.ts:23` draws -5 as 0. A P&L or a temperature is flat.
- `lineLayout` keys `00:00, 00:01, 06:00`: `keyX [8,300,592]`. Six hours and one minute get one width; irregular samples lie.
- `deltaOf(120,100)` is `up`; `StatTile.module.scss:67` paints `up` success. An error rate rising 20% is green. `deltaOf(5,0)` is `undefined`, `deltaOf(5,2)` `+150%`.
- `chartHits` rebuilds on every tick (`ChartFrame.tsx:133`), the mechanism that lost focus in `DataTable`: a focused point in a live island loses focus. Unproven here; the e2e below proves it first.

## Decisions
| Question | Answer |
|---|---|
| New chart component or options | options on the shipped charts. New names only where no chart has the shape: `HeatStrip`, `LiveIndicator` |
| Series colour | `tone?: Tone` beside the slot. Dash and marker stay: never colour alone. `CONTRAST_PAIRS` gains tone-on-surface at 3:1 |
| Which delta direction is good | `goodWhen: 'up' \| 'down' \| 'none'` on `StatTile`, default `'up'` (today's). Arrow always; colour only when stated. Whether up is good is the caller's, one prop (axiom 8) |
| Stat grid | none. `Grid minColumn` is it; a second layout name fails axiom 1. Documented with the 2-up phone recipe |
| Live animation | no path tweens. Nodes keep identity, numbers change. Nothing to withdraw under reduced motion, nothing to re-lay out on a phone |
| Live data source | not here. `useQuery` live, or `visibleInterval` from [`23-ui-live-refresh.md`](23-ui-live-refresh.md). `liveWindow` is the pure trim |
| Announcing ticks | never: a chart has no live region. `LiveIndicator` announces state changes through `announce()` |
| Look | tokens. `scifi` preset already recolours series and edges; the dashboard route below is the proof, no new mixin |

## Files to change
- `packages/ui/src/components/bar-chart-view.ts:6,63` — `value: number | null`; `null` no rect; negatives below a real zero line; `maxOf` becomes extent.
- `packages/ui/src/components/BarChart.tsx:19` — `tone`, `references`, n-series `series` + `keys` mode as a union (the two-series `secondary` form stays).
- `packages/ui/src/components/sparkline-view.ts:23`, `Sparkline.tsx` — signed scale; `tone`; `area`; newest point marked.
- `packages/ui/src/components/line-chart-view.ts:143`, `LineChart.tsx:26` — optional `at: readonly number[]` true x positions, ascending; `references`; `stacked` for `AreaChart`.
- `packages/ui/src/components/chart-frame-view.ts:144` — `ChartSeries.tone`; table prints `ui.chart.none` for a gap instead of an empty cell.
- `packages/ui/src/components/chart-reference-view.ts` (new) — reference-line geometry, shared.
- `packages/ui/src/components/ChartFrame.tsx:130` — hits keyed by a stable `id` with the `data-table-rows.ts` rule; touch hit box at least `--touch-target`.
- `packages/ui/src/components/StatTile.tsx:15`, `.module.scss:67`, `stat-delta.ts:16` — `goodWhen`, `tone`, `href`, `of`, `trend` (a `Sparkline`), `loading` (a `Skeleton` in the figure's box); `deltaOf(current, baseline, { absoluteBelow? })` gives a signed difference under a small baseline, and from zero.
- `packages/ui/src/components/Gauge.tsx:18`, `gauge-view.ts` — `value: number | null` (track and `ui.chart.none`), `thresholds: { at, tone }[]` picks the tone, `target` tick.
- `packages/ui/src/components/Meter.tsx:15`, `meter-view.ts` — `target` tick (a bullet bar is a `Meter` with a target).
- `packages/ui/src/components/HeatStrip.tsx`, `.module.scss`, `heat-strip-view.ts` (new) — rows of status cells, HTML; a cell is one element, shape from a mask per tone, `href` optional, full reading as its name.
- `packages/ui/src/components/LiveIndicator.tsx`, `.module.scss` (new) — static dot, shape per state, words beside it: `live`, `reconnecting`, `paused`, `offline`. Never blinks.
- `packages/ui/src/live-window.ts` (new) — `liveWindow(series, point, { max })`, pure, fails on a non-finite `max` via `finiteOption`.
- `packages/ui/src/index.ts:240`, `i18n-keys.ts`, `packages/i18n/src/catalogs/en.json` — exports; `ui.chart.none`, `ui.live.*`.
- `packages/ui/src/tokens/contrast-pairs.ts` — tone on surface for marks.
- `packages/cli/src/templates/scaffold-dashboard-example.ts:129` — tiles carry `trend` and `goodWhen`; the query's window fills `null`, not zero.
- `dummy/social-media-clone/apps/web/app/dashboard/page.tsx:86` — the deployed use, `scifi`.
- `examples/dummy/apps/web/app/runs/` — run-health page: `HeatStrip`, `LiveIndicator`, `LineChart` with `at`, `Gauge` with `thresholds`, in `Grid`. `examples/dummy/x.manifest.json` regenerated.
- `scripts/ui-barrel-bytes.test.ts` — ceilings below.
- `packages/ui/README.md:193`, `packages/ui/CLAUDE.md`, `packages/ui/CATALOG.md`, `wiki/Interface-Rules.md`, `wiki/UI-Components.md`.

## Steps
1. Geometry first, each pure with its failing test: signed bars, signed sparkline, `at`, stacked area, references.
2. `tone`, `goodWhen`, `Gauge` and `Meter` options; the contrast pairs and the preset test.
3. Keyed hits. A live tick keeps a focused point's node and its readout.
4. `HeatStrip` (arrow keys never; each linked cell a link, an unlinked cell no tab stop). `LiveIndicator`. `liveWindow`.
5. Phone pass at 390 px: no page scroll, tap opens a readout, tick labels thin out, stacked legend. One e2e per chart family.
6. Scaffold and demo. Measure a live island of one chart, raise the budget with `measured:` and `why:` (`bun run budget-raises`).

Baseline, raw minified export-only island cost, this probe: `LineChart` 36,219 B, `BarChart` 33,138, `Gauge` 30,074, `StatTile` 15,115. Static render: 0 B, and that stays. New ceilings measured when written, never cut to fit (axiom 9).

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_UI_INVALID_VALUE` (existing) | `at` length differs from `keys`, or is not ascending; `thresholds` unsorted; a `series.values` length differs from `keys` | the cause names the series and the index |

## Tests
- Unit: `bar-chart-view.test.ts`, `sparkline-view.test.ts`, `line-chart-view.test.ts`, `stat-delta.test.ts`, `gauge-view.test.ts`, `heat-strip-view.test.ts`, `live-window.test.ts`; each probe line above becomes an assertion that fails today.
- `packages/ui/src/tokens/contrast.test.ts`, `presets.test.ts`: tones at 3:1 on four surfaces, both themes, `scifi` included.
- `packages/cli/e2e/ui-chart-live.e2e.test.ts` (browser): focus a point, tick, same node focused; 390 px viewport, `scrollWidth <= innerWidth`; tap shows the readout; `dir="rtl"` readout stays in the box.
- `scripts/ui-barrel-bytes.test.ts`: `HeatStrip`, `LiveIndicator` retained module lists; `liveWindow` adds no chart module. Command `bun test packages/ui/src/components/bar-chart-view.test.ts`.

## Semver
breaking; lands in v30.
**Breaking, three rows.** `ChartPoint.value` widens to `number | null`: a reader of the field must handle `null`. `UI_KEYS` gains keys (`Record<UiKey, string>` stops compiling). Series length mismatch now throws.
Upgrading: "Handle `null` in any code reading `ChartPoint.value`. Add `ui.chart.*`, `ui.live.*` to a `Record<UiKey, string>`. A negative value now draws below zero. Rows of unequal length are `X_UI_INVALID_VALUE`." The rest is additive; `goodWhen` defaults to today's colours.

## Done when
- A negative, a missing and a zero value draw three different things on `BarChart` and `Sparkline`.
- An error-rate tile rising shows no green with `goodWhen="down"`.
- A live page at 390 px on `scifi` ticks for a minute with focus held, no page scroll, no announcement.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green; scaffold smoke green twice per shape.
