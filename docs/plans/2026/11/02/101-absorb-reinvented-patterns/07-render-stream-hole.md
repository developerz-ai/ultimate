# 07 — `<Hole>`: the marker `stream` has been waiting for

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 4 (`render`), 5 (`cli`).

## Why
`stream` flushes everything first: "nothing can yet mark a subtree as a hole" (`cli/src/runtime-render.ts:312`, `wiki/Routes-And-Render-Modes.md:246`, `wiki/Known-Gaps.md:50`). Five apps carry the comment; every page waits for its slowest query; one casts a Promise to JSX.
Nothing real blocks it. `renderStreamHtml` is finished (`render/src/render-stream.ts:112`), exported from `@ultimat3/render/server`, with deadlines and CSP hashes. Probe, a 3-line hole component over the real walker and renderer:
`shell 1 ms` · first flush `2 ms` · rejected hole `25 ms` (hidden fallback, doc intact) · fast `55 ms` · slow `302 ms` · close `302 ms`.
Also: the boundary check is a text regex (`cli/src/app-load.ts:421`). `examples/dummy/apps/web/app/feed/page.tsx:14` declares `stream` and passes only because a **comment** says `<Suspense>`: regex count 1, transpiled count 0.

## Decisions
| Question | Answer |
|---|---|
| Name | `Hole` from `@ultimat3/render`, not `Suspense`: the framework's existing noun (`StreamHole`, `holeMarker`), and the other spelling throws off its own renderer |
| Boundary invariant | deleted (`render/src/modes.ts:73,221`). A hole may sit in a layout the regex cannot see, and a holeless `stream` pays nothing (`render-stream.ts:150`). `X_ROUTE_MODE_INVALID` keeps its other uses |
| Other modes | sinkless `Hole` awaits its children inline: `ssr`, `static`, `servedDocument` and the budget measurement (`cli/src/prerender.ts:440`) each render the whole tree, so a hole's island is weighed |
| Nested hole | inner one inline inside the outer: `pending` is fixed at first flush (`render-stream.ts:153`) |
| Status, redirect | decided before the flush. `withStatus` and `redirect` stay `load`'s. Reads that can 404 or redirect belong in `load`; a throw in a hole is its error fallback |
| `X_ROUTE_ASYNC_PAGE` (`cli/src/async-pages.ts:15`) | unchanged: applies to `Page`, never to a child under a hole |
| Generated default | yes, in this slice. `x g route`, `x g resource`, the dashboard write `render: 'stream'` (`templates/route.ts:22`, `scaffold-dashboard-shared.ts:13`); the resource list reads inside a `<Hole>`. Matches `surfaces.ts:45`, and a stream is always `private, no-store` where an ungated `ssr` may be public |
| Shape | a marker node, as `isIslandNode` (`render/src/island.ts:81`). `renderNode` calls `type(props)` with no walk (`render/src/render-html.ts:129`), so a component cannot see the sink; `unwrap` does. Array-based and checked before the array branch, as an island is: the only object shape `JSX.Element` admits (`render-html.ts:68`) |
| Export | `Hole` from the client barrel, where `h` and `island` are (`render/src/index.ts:1`). `hole.ts` imports nothing: `renderToHtml` is server-only (`server.ts:42`), so resolving stays in `render-html.ts` |
| Axiom 6 | `site/` cannot declare `stream` (`surfaces.ts:46`), so it pays 0. `hole.ts` is a symbol and a function, tree-shaken from a graph that does not use it. Reveal script is inline only when `holes > 0` |

## What a hole breaks, handled here
| Fact | Effect | Handling |
|---|---|---|
| `hydrateRuntime` emits inline `type="module"` (`render/src/hydrate.ts:305`), deferred until parsing ends | shell islands stay dead until the slowest hole closes, up to 15 s | with holes and no realtime boot, emit `async`. Body and CSP hash unchanged. With a realtime boot, stays deferred: the boot must run first (`cli/src/route-islands.ts:54`); listed in Known-Gaps |
| Directives known at first flush exclude a hole's islands | their strategy runtime and boot are absent | a hole's chunk appends `bootScript` (once) and `hydrateRuntime`, after `$X()`. `each` visits a root once (`hydrate.ts:140`), so re-running is safe, and every body is already hashed (`HYDRATE_RUNTIME_BODIES`) |
| `hole_rejected` only logs (`render-stream.ts:200`) | a failing hole reaches no monitor | `reportError(source: 'http')` beside the log, deadlines too |
| Default error fallback is an empty hidden div | skeleton vanishes silently | `<Hole error={…}>`, rendered at shell time |
| `deadline.clear()` on handler return (`http/src/pipeline.ts:322`) | a hole has no request deadline | `holeTimeoutMs` bounds it; `beginWork` bodies poll covers drain (`http/src/server.ts:390`). Pinned by test, no change |
| Router reads `response.text()` (`render/src/navigation-fetch.ts:69`) | in-app navigation still waits for the slowest hole | reveals work through `runScripts` (`navigation.ts:314`), pinned by test. No incremental parse here: Known-Gaps row |

## Files to change
- `packages/render/src/hole.ts` (new) — `HOLE_NODE`, `Hole(props)` returning the marker, `isHoleNode`. No imports.
- `packages/render/src/render-html.ts:51` — `RenderHtmlOptions.holes?`, the sink with its per-render counter; `unwrap` handles the marker before the array branch and clears the sink for a hole's children.
- `packages/render/src/render-stream.ts:19` — `StreamHole.error?`, `after?` (scripts after `$X()`), `reportError` at `:200`. `:65` `revealChunk` takes `after`.
- `packages/render/src/hydrate.ts:302` — `hydrateRuntime(directives, { async? })`.
- `packages/render/src/modes.ts:36,73,221`, `registry.ts:53,238,269,282,304` — delete `needsSuspense`, `suspenseBoundaries`.
- `packages/render/src/index.ts:99` — export `Hole`.
- `packages/cli/src/runtime-render.ts:311` — collect holes, build the plan; comment replaced.
- `packages/cli/src/app-load.ts:389,421`, `runtime-admin.ts:47` — delete the regex.
- `packages/cli/src/templates/route.ts:17,22`, `resource-page.ts:126`, `scaffold-dashboard-shared.ts:9,13`, `emitted-routes.test.ts:3,76`.
- `examples/dummy/apps/web/app/feed/page.tsx:13` — the activity count becomes a real hole, the comment goes; budget comment re-measured. `dummy/social-media-clone/apps/web/app/messages/page.tsx:1`.
- `wiki/Routes-And-Render-Modes.md:71,243–280`, `wiki/Known-Gaps.md:50` (out; two rows in), `wiki/Queries-And-Live-Queries.md:306`, `wiki/Tutorial-01-First-App.md:256`, `wiki/FAQ.md:64`, `wiki/Upgrading.md`, `docs/idea/01-stack.md:60`, `07-rendering-seo.md:46–63`, `12-build-deploy.md`, `docs/architecture/16-build-pipeline.md:85`, `09-rendering-internals.md:109`, `packages/render/README.md:180`, `packages/render/CLAUDE.md`, `llms.txt`.

## Steps
1. `Hole({ fallback, error?, children })` returns the marker and decides nothing. In `unwrap`, with a sink: render `fallback` and `error`, push `{ id, fallback, error, resolve }`, emit `holeMarker(id, fallback)`. Without: `unwrap(children)`.
2. `resolve` is `unwrap(children, 0, { islands })`, no sink. Started in `start()` (`render-stream.ts:136`), so inside the request's async context.
3. `runtime-render.ts` stream case: walk with a sink; `plan.holes` from it; `after` compares the collector's directives to those already flushed.
4. `async` on the first-flush runtime per the table; `documentFrom` unchanged.
5. Delete the invariant, its regex and fix line; grep `Suspense` to zero outside history and Upgrading.
6. Generators, then `x verify` on a scaffold: emitted-route tests hold the shape.

## Error codes
None new: a hole's failure is `render.stream.hole_rejected` plus the report, and its fallback. `X_ROUTE_MODE_INVALID` stops firing for a holeless `stream`, and `wiki/Error-Codes.md`'s row drops that clause. Run `bun run new-error-code` only if review adds one.

## Tests
- `packages/render/src/hole.test.ts` (unit): the marker reaches the walker through a wrapping component and survives the island/array order; `hole.ts` has no import (the client bundle test stays green); the probe's order pinned; sinkless inline; nested inline; id escaped; `error` used; a throw reports.
- `packages/cli/src/runtime-render-hole.test.ts` (unit): first chunk holds the shell before a held promise resolves; `useContext()` works in a hole after the handler returned; a hole's island brings its runtime in the chunk; `budgets` weighs it.
- `packages/render/src/navigation-swap.test.ts`: a fetched doc's holes fill after `runScripts`.
- `packages/cli/e2e/stream-hole.e2e.test.ts` (browser, enforced CSP): click a shell island while a 2 s hole is open; it responds before reveal. This is the proof of the `async` row, and fails without it.
- `packages/cli/src/templates/emitted-routes.test.ts`: every generated `app/` route registers. Command `bun test packages/render/src/hole.test.ts`.

## Semver
breaking, one Upgrading row: `registerRoute`'s `suspenseBoundaries` and `RouteEntry.suspenseBoundaries` deleted, `ModeSpec.needsSuspense` deleted (edit only if you pass or read them). Everything else minor: new export, a refusal removed, existing routes unchanged; generators change only new files.

## Done when
- `grep -rn "no hole marker" wiki docs/idea packages/cli/src` answers nothing.
- A scaffolded `app/` page's first chunk arrives before its held read resolves, under the enforced CSP.
- A hole's island hydrates; a shell island answers a click while a hole is open.
- `bun run verify` green; `bun run scripts/reference-app-gate.ts` green; `scaffold-smoke` green twice per shape.
