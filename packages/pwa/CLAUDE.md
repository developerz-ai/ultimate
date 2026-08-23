# @ultimat3/pwa — boundary

Owns: `sw.js` generation, caching strategies, precache manifest, version skew, web
manifest, icons, offline fallback, background-sync trigger, push, install prompt.

Tier 4. May import tiers 0–3: `core`, `schema`, `i18n`, `money`, `time`, `cache`, `seo`,
`entity`, `policy`, `http`, `action`, `query`. **Never** `render`, `mcp`, `ai`, `manifest`
(sideways), never `ui`/`cli` (upward).

| Rule | Detail |
|---|---|
| `sw.js` | generated, never hand-written, never committed. No file in this package is a SW. |
| Determinism | no `Date.now()`, no randomness, sort every collection. Same input → same bytes. |
| Route input | `PwaRoute` is a **structural** view of render's `RouteDescriptor`. Never import render. |
| Strategy choice | derived from render mode via `MODE_STRATEGY`. Per-route override only. |
| Precache revision | content hash. Never the build id — that re-downloads everything per deploy. |
| Precache KEY | the bare URL, always. The revision addresses the FETCH (`?v=<hash>`), never the key: every strategy looks an entry up with `caches.match(req)` and `ignoreSearch` defaults to `false`, so an entry left keyed under `?v=` is a permanent miss — offline serves the fallback document instead of the precached page, and online every precached byte is downloaded twice. `addAll` still does the fetching, because its all-or-nothing failure is what stops a half-populated precache from activating; the install block only re-keys what it stored. `service-worker.test.ts` executes the emitted `sw.js` against stub `caches`/`fetch` rather than asserting its text. |
| Precache FETCH | the revision is appended with `?` or `&`, picked per entry. `PrecacheAsset.url` is public API and a bundler emits `?v=<hash>` of its own, so a fixed `?` built `...?locale=en?v=<rev>`; `addAll` is all-or-nothing, so one non-200 there means `install` rejects and the worker never activates at all. |
| SW scope | `assertScope` refuses a relative `swPath`. `lastIndexOf('/')` on `sw.js` is `-1`, so the directory was `''` and `scope.startsWith('')` passed for every scope — the check waved through exactly the config most likely to be wrong. |
| HTML sinks | one escaper: `escapeAttribute` from `@ultimat3/seo` (tier 1, and the only one reachable — render's `html.ts` is tier 4, sideways). `appleTouchLinks` and `renderThemeColorMeta` interpolate app config into attributes; both escape. Never a second escaper here. |
| A byte count in a warning | `formatBytes` from `@ultimat3/core`, never a local one. The copy that lived in `precache.ts` stopped at `mb`, so a precache past a gigabyte reported a four-digit `mb` — and `@ultimat3/render`'s copy stopped at `kb`, so the two halves of one build printed different units for the same bytes. Still on this barrel: a size report is what a caller of this package prints. |
| Cache names | always `cacheNamespace(buildId, kind)`. An unkeyed cache name is a rejected change. |
| Offline fallback | `requireOfflineFallback` runs inside `generateServiceWorker`. Never optional. |
| Capabilities | gate the manifest member **and** the SW block, where the capability has one. Disabled → zero bytes. `push`, `backgroundSync` and `badging` emit worker code; `shareTarget`, `fileHandlers` and `protocolHandlers` are **manifest-only** — the OS delivers to a route the app already serves — and their `CAPABILITY_SW_MARKERS` list is empty, which `service-worker.test.ts` checks in both directions: every declared marker is in the worker when its capability is on, none is when they are all off. `shareTarget` named `/_x/share-target` there while no block emitted it. |
| `AppUpdateAvailable` | declares exactly the fields the emitted `activate` block posts, and no more. `version-skew.test.ts` reads the literal back out of the generated source and compares it to a fixture typed `Required<AppUpdateAvailable>` — a field added to the interface stops compiling, a field added to the worker fails the assertion. It declared five and posted two until 9.0.0; the three extra described a forced reload nothing performed. |
| Forced reload | **not a capability of this package.** `updateSignal`/`updatePolicy` computed `forced`/`deadlineAt` with no runtime caller and were deleted in 9.0.0. The two runtimes holding both build ids are BELOW this one — `http`'s `ctx.clientBuildId` (tier 2), `sync`'s `update-available` frame (tier 3) — so neither could ever have called into tier 4 to act on one. The app renders its own affordance; the framework never navigates a client. |
| Outbox | queue lives in `@ultimat3/realtime`. This package only registers the sync trigger. |
| Push strings | i18n keys only, rendered per subscriber locale. Never a literal. |
| Push URLs | `PushPayload.url` is a PATH and `WindowClient.url` is absolute, so `notificationclick` resolves against `self.location.origin` before comparing. Unresolved, the focus-existing-tab loop matched nothing and every tap opened a second window. |
| Colours | token values passed in via `PwaConfig.tokens`. Never a hex literal in this package — a test fixture asserting the parser is the one exception. |
| Icons | one source image → `BuiltinImagePipeline` → a square PNG per `ICON_MATRIX` entry, rendered by `@ultimat3/core`'s image pipeline. Never a second scaler, never `sharp`, never a vendor CDN. |
| Icon source | a **PNG** (core decodes PNG and JPEG only). `x new` scaffolds one; `@ultimat3/cli`'s `dev-assets.ts` reads it at `ICON_SOURCE` and serves every entry at its `outputPath`. This package renders bytes and mounts nothing. |
| Icon background | `IconSourceConfig.background`, hex or `transparent` — core's grammar has no named colours. Default transparent. |
| Errors | `errors.ts` subclasses only. `X_NOT_IMPLEMENTED` must carry a real `fix:`. |
| Errors in `sw.js` | no bundler there, so no `UltimateError` import — the generated source defines its own class (`SYNC_ERROR_CLASS`) carrying `code`, `cause`, `fix`, `docs`. Never emit a bare `throw new Error`; the code stays owned by `errors.ts`. |

```
bun test                          # from packages/pwa
bun run typecheck
bun run --cwd ../.. verify
```
