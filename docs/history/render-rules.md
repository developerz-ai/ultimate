# render: rule rows moved out of `packages/render/CLAUDE.md`

`As of 2026-11-10`. Plan 101 wave G cut the package file to make room under its 24,576 B ceiling
(`bun run scripts/claude-md-size.ts`). Each section below is a row's cell as it stood, verbatim,
under its rule; the package file keeps a short cell marked `†`. Where the two disagree,
`packages/render/CLAUDE.md` wins. The older long form is [`render.md`](render.md).

## The hydration runtime's CSP

`HYDRATE_RUNTIME_BODIES` — every body `hydrateRuntime` can emit (seven subsets, each with and without the hold part — fourteen). It is inline in every document with an island and `@ultimat3/http`'s `script-src` is `'self' 'wasm-unsafe-eval'`, so `@ultimat3/cli`'s `script-csp.ts` hashes this list at boot. `runtimeBody` is the one place the served and hashed text are one string. A hole's reveal body is the constant `$X()`, hashed through `STREAM_REVEAL_BODIES`, and reachable.

## A loader's own STATUS

`withStatus(status, data)` (`route-status.ts`) — the ONE way a page answers 404/410/503 while rendering its own component in the app's shell. The status rides on the data by IDENTITY in a `WeakMap`; `routeStatusOf(data)` is the total reader (200 by default). A 3xx is `X_ROUTE_STATUS_INVALID`. A 4xx/5xx is `robots.index = false` by construction in `defineRoute`'s `meta` wrapper. The `Response` status is minted by `@ultimat3/cli`'s `runtime-render.ts`.

## An attribute NAME is validated too

`ATTRIBUTE_NAME` in `html.ts` (`/^[A-Za-z_:][-A-Za-z0-9_:.]*$/`), refused as `null`; the `on*` handler check folds case. `head-attributes.ts` prints a head tag through the same `attributePair`, one exception: a `link` href reads `safeUrl` as a `src` (raster `data:image/`) and `rel="alternate"` keeps `android-app:`/`ios-app:`. A drop logs `head.attribute_dropped` once per tag and attribute in dev. One rule, never two.

## Mounted routes

`registerMountedRoutes(mount, routes)` (`mounted-routes.ts`) — routes a PACKAGE mounts with no surface file (the admin's screens). In `describePages()` with `mount: { by, permissions }`, never in `routeEntries()`: described, not rendered here. Re-declaring a `key` replaces its set; a path a file route also claims is `X_ROUTE_DUPLICATE` in both orders. `RouteDescriptor.mount` is absent on a file route.
