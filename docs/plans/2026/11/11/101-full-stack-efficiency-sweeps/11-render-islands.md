# 11 — render and the island build: fewer bytes per island, assets compressed once, a failing island that still shows

> Part of [`overview.md`](overview.md). Depends on: [`06`](06-http.md) H3 (encoding negotiation), [`01`](01-hotfix-patch.md) (the `assets` bucket). Tier: 4 (`render`) and 5 (`cli` build).

Live demo, 2026-11-11: one stylesheet of 170,641 B (23,798 B gzip) for every page plus 6,130 B of inline style per page; gzip only; warm TTFB 10–29 ms. An adopter measured list pages going from 54 kB to 208 kB with live islands on.

## Findings

| ID | Sev | Status | Where | Finding | Fix |
|---|---|---|---|---|---|
| I1 | P2 | confirmed (code) | `packages/cli/src/island-bundle.ts:369-398` (splitting only within a route group; a standalone island has `splitting: false`), `:177-232`; `island-runtime.ts:1-4` | A standalone island bundles its own copy of `solid-js` + `solid-js/web`. (The realtime page runtime, 63,928 B, is already one shared output — the adopter's "64 kB per island" is that file, fetched once) | a fixed vendor chunk built as `island-runtime.ts` builds the page runtime: `vendor-solid.<graphHash>.js` re-exporting `solid-js`, `solid-js/web`, `solid-js/store`; every island build maps those specifiers to it through `onResolve` (`external`). One more request on first load, no cross-island tree-shake bleed. The service-worker precache plan and the budgets count it once |
| I2 | P2 | gap; 2 adopters set budgets by hand | `packages/cli/src/budgets.ts`; `defineMeasurementActor` exists | Budgets weigh routes signed out; an SSR route with params is unweighable (`X_BUDGET_UNMEASURED`) | measure a param route from its `exercise.ts` inputs or a declared sample param set, per measurement actor. The budgets step also reports **requests per route** (documents + chunks + styles): a measurement in the JSON; `X_ISLAND_REQUESTS_OVER_BUDGET` only when an app declares a ceiling |
| I3 | P2 | confirmed (read + live) | `packages/http/src/compress.ts:80-90,128-130`; no precompression in `packages/cli/src` (grep) | Immutable hashed assets are gzipped synchronously on every request; brotli is never offered | `x build` writes `.br` and `.gz` beside each hashed asset (brotli via `node:zlib` with a `why:` line if Bun has no native encoder — check first); the asset routes serve the precompressed file by `Accept-Encoding` with `Vary`. Zero CPU per hit |
| I4 | P2 | absent (catalogue) | `packages/cli/src/route-islands-preload.ts:1` (tags after the body only) | No `Link` response header on documents | `Link: <sheet>; rel=preload; as=style, <chunk>; rel=modulepreload` from the same set the tags come from: a CDN turns it into a 103 Early Hint. A test holds header set = tag set |
| I5 | P2–P1 | partial; **owner decision OD7** (it changes the template every scaffold copies) | `packages/cli/src/templates/island.ts:70-78`; `packages/render/src/hydrate.ts:139` | A failed boot is marked `data-x-failed` per root, but the scaffolded `mount` clears the server markup first: a render throw leaves a blank island | `mount` renders inside a Solid `ErrorBoundary` whose fallback is the server's HTML (or renders off-DOM and swaps on success), and reports through `clientErrors`. Shipped as a helper in `render` so the template is three lines and existing apps adopt by a guard's fix text, not by a codemod (codemods are decided out, `docs/history/major-sweeps.md:11`) |
| I6 | P3 | plausible (not measured) | `packages/cli/src/serve-web.ts:218-220`; `theme-brand.ts` | 6,130 B of CSP-hashed inline style on every page: the error-page style bodies and the brand tokens | move the brand tokens into the hashed, immutable stylesheet; keep inline only what must paint before the sheet |
| I7 | — | measured, **not planned** | `packages/cli/src/style-bundle.ts:56-64,85-104` | One stylesheet per surface: every page ships the whole surface's CSS | leave: 23.8 kB gzip, immutable, cached across navigations; a per-route split costs requests and CSP entries and no budget asks for it. Revisit if a surface's sheet passes 50 kB gzip — record the figure in the budgets JSON so that day is visible |
| I8 | P3 | confirmed | `packages/render/src/navigation.test.ts:82,315,317,368`, `navigation-input.test.ts:18` | real-clock waits | [`17`](17-test-determinism.md); the router's scheduler seam is added there |

Checked and fine, not planned: the synchronous SSR walker, ISR (single-flight with a deadline, stale-while-revalidate, stale-if-error, byte-bounded store), streaming with `<Hole>`, navigation (superseded fetches aborted, prefetch cache ≤ 20 entries with a TTL, head diffed by markup, islands disposed on swap, scroll and focus restored), hydration directives (`idle` / `visible` / `interaction`), speculation rules, View Transitions, the image pipeline.

Not read in five passes: `hydrate.ts` body, `island*.ts`, `head.ts`, `render-stream.ts`, `render-ssr.ts`, `route*.ts`, `navigation-modal*.ts`, `navigation-intercept.ts`, `navigation-refresh.ts`, `render-isr-store-storage.ts`; `packages/cli/src/prerender.ts`. Covered by this sweep's review passes ([`overview.md`](overview.md) *Risks*).

## Files to change
- `packages/cli/src/island-vendor.ts` (new), `island-bundle.ts`, `island-outputs.ts`, `sw-precache-plan.ts`, `budgets.ts`; `packages/core/src/config-islands.ts` (doc) — I1, I2.
- `packages/cli/src/cmd-build.ts` / the asset emit path, `asset-precompress.ts` (new), `runtime-assets.ts`, `style-routes.ts`, `island-routes.ts` — I3.
- `packages/cli/src/route-islands-preload.ts`, `serve-web.ts`, `theme-brand.ts` — I4, I6.
- `packages/render/src/island-mount.ts` (new: the boundary helper), `hydrate.ts`; `packages/cli/src/templates/island.ts`, `templates/guard-island-mount.ts` (new) — I5.
- Budgets: every tracked app's figures move (I1 shrinks islands and adds one shared file). `bun run budget-raises`; the reason and the number in the same diff.
- Coordinator only: codes (`X_ISLAND_REQUESTS_OVER_BUDGET`; the guard's code for I5), changelog + `wiki/Upgrading.md` (I1 changes emitted file names; I3 changes what a static host must serve), `bun run manifest`, each app's `x.manifest.json`.

## Steps
1. I1: build `examples/dummy` on `main`, record whole-chunk bytes per route from `.x/build-stats.json`; build again with the vendor chunk; the PR carries both tables. Attribute by whole chunks, not by source maps.
2. I3 after [`06`](06-http.md) H3's runtime probe; a static export (`x build --target static`) emits the same `.br`/`.gz` files, and the docs say which header rules a static host needs.
3. I5 only after OD7: write the helper and the guard; the reference app's islands adopt first.
4. I4, I6: one worker; re-measure the demo's first-visit bytes with curl (GETs only).

## Tests
- `packages/cli/src/island-vendor.test.ts` — two standalone islands both import `vendor-solid.<id>.js`; neither inlines solid (metafile); a page with both makes 3 script requests.
- `packages/cli/src/asset-precompress.test.ts` — a `.br` is served for `br`, `.gz` for `gzip`, identity otherwise; `Vary: Accept-Encoding`; the ETag is per encoding.
- `packages/cli/src/route-islands-preload.test.ts` — the `Link` header set equals the tag set.
- `packages/render/src/island-mount.test.ts` — a throw in render leaves the server markup in place and reports once.
- `packages/cli/src/budgets.test.ts` — a param route is weighed from its sample; the JSON carries requests per route.
- Command: `bun test ./packages/cli/src/<file>.test.ts`; `bun run scripts/reference-app-gate.ts`.

## Done when
- A page with three standalone islands ships one copy of Solid (bytes table in the PR).
- The demo serves hashed assets precompressed, with brotli where the client accepts it, and no compression CPU per asset hit.
- A throwing island in the reference app shows its server HTML and an error-tracker event, not a blank box.
