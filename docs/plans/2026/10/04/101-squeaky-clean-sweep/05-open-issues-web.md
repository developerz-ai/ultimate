# 05 — Open issues: navigation, ui, MCP catalog, dev error page

> Part of [`overview.md`](overview.md). Depends on: 04 merged. Tier: 2–5. **Sweep 5.**
> Issue verdicts verified against `d7b8c7fa`, As of 2026-10-04.

## Agents (≤ 4, disjoint)
| Agent | Issues | Exclusive paths |
|---|---|---|
| A — render navigation | #627, #621 | `packages/render/src/{navigation,navigation-rules,navigation-dom}.ts`, render navigation CSS, `packages/pwa/src/offline-fallback.ts` (header branch only — C10 of slice 04 already landed), `packages/cli/e2e/client-navigation-*.e2e.test.ts` |
| B — ui | #488, #494 | `packages/ui/src/components/{Card,Text,Container,Grid,Section,Stack,BarChart}.tsx`, `BarChart.module.scss`, `bar-chart-view.ts`, `charts.test.ts`, new `intrinsic-root.test.ts`, `packages/cli/e2e/ui-as-prop.e2e.test.ts` |
| C — mcp | #590 | `packages/mcp/src/{meta-surface,surface-budget}.ts` + tests |
| D — http + cli dev | #492, #541 | `packages/http/src/stages.ts` (error-page branch `:377-407`), new `stages-error-page.test.ts`, `packages/cli/src/cmd-dev-reload.test.ts`, `wiki/Routes-And-Render-Modes.md:370,377` |

## Issues → fix

| Issue | Root cause | Fix | Test |
|---|---|---|---|
| **#627** offline click → `blob:` URL | `navigation-rules.ts:278` hands over any non-HTML answer before the status check (`:285`); `navigation.ts:243` → `navigation-dom.ts:168` blob; SW serves `/offline` only for `mode==='navigate'` (`pwa/src/offline-fallback.ts:108`) | Before the content-type branch: `status >= 400 && !html` → `load(facts.requested, …)` for GET, `failed` for POST; 2xx non-HTML still hands over. Harden SW: request carrying `x-ultimate-navigation` (literal of `CLIENT_NAVIGATION_HEADER`, `core/src/page-meta.ts:55`) counts as navigation | `navigation-rules.test.ts` (empty 503, JSON 404, 500 → `load`/`failed`; 200 `content-disposition` → hand-over); `offline-fallback.test.ts` header case |
| **#621** press skips running view transition | `navigation.ts:314-321` `onPress` → `skipTransition()` on every capture `pointerdown` (`:447`); click-loss fix `:328-338` relies on it | Prefer (a): ship `::view-transition { pointer-events: none }` in framework navigation CSS, remove the skip; prove on Chrome e2e. Fallback (b): skip only at click time + `elementFromPoint().click()`. No config knob | `navigation-input.test.ts:25-51` → bare press skips 0; `client-navigation-input.e2e.test.ts` press mid-transition on non-link keeps it running |
| **#488** `as` prop throws on island hydration | `const Tag = props.as ?? 'x'; <Tag>` → island Babel `createComponent(Tag)` calls a string. Card.tsx:24, Text.tsx:40, Container.tsx:20, Grid.tsx:22, Section.tsx:26, Stack.tsx:31 | `switch` over the closed union, one intrinsic per case (pattern `Icon.tsx:41-73`); compute `cls`/`style` once. No API change | Guard `intrinsic-root.test.ts` (refuses `= props.as ??` + JSX use in `components/*.tsx`); e2e `ui-as-prop.e2e.test.ts` (`<Card as="li"><Text as="p">` in an island, no page error; model `ui-rtl.e2e.test.ts`) |
| **#494** BarChart axis unreadable narrow | SVG `<text>` in `viewBox 0 0 600 128` (`bar-chart-view.ts:27`, `BarChart.tsx:92-104`); `display:none` below `sm` | Root `<figure>` wraps `<svg role="img">`; max/first/last labels as HTML spans with `t.data-text` + token font size; drop `display:none`. `class` moves to wrapper → CHANGELOG **Changed** | `charts.test.ts:30` labels as HTML nodes; `x shot --matrix` 390px visual check |
| **#590** `list_resources` ~8k chars over budget | `meta-surface.ts:283-290` per-action `(kind; confirms; scope …)`; `:315-330` `HINT_MAX = 240` chars, not N fields; no scope hoisting | Hoist a scope shared by every action of a resource onto the resource line; cap params at 4 fields + `…`, lower `HINT_MAX`; tag only `action` kind (`query` is the default) — not a name heuristic | `meta-surface.test.ts` exact text; `surface-budget.test.ts` 65-action fixture `listResources ≤ 12_000` |
| **#492** `x dev` never serves app error page | `http/src/stages.ts:377-389` returns the dev overlay before `hooks.errorPage` (`:407`); `cli/src/role-start.ts:218` per-request reads unreachable | **Owner O-492.** Default (a): in dev, 4xx asks `hooks.errorPage` first, 5xx keeps the overlay. (b): delete `perRequest` branch (`cli/src/error-pages.ts:51-57`) + fix wiki | `stages-error-page.test.ts`: `dev:true` + hook → 404 app body; 500 → overlay |
| **#541** dev serves old CSS-module class names | Likely fixed by 10edffe0 (`cli/src/app-reload-graph.ts:154-171,189-248`); no test | Test only; close if green, ask reporter to confirm on 24.x | `cmd-dev-reload.test.ts` (beside `:200-226`): edit `.module.scss` → page + island chunk serve the new hash |

## Steps
1. Branch `fix/sweep-5-open-issues`; brief A–D.
2. Failing test first (e2e for #621/#488 needs Chrome — `bun run test` opt-in e2e).
3. Coordinator: CHANGELOG, `bun run verify`, PR with `Fixes #627 #621 #488 #494 #590 #492 #541`.

## Done when
- Seven issues closed by the merged PR. Each fix row has a test that failed on `d7b8c7fa`; #541 (already fixed upstream of this sweep) needs a passing regression test instead, which fails if the fix is reverted (prove by reverting `cli/src/app-reload-graph.ts:154-171` locally).
