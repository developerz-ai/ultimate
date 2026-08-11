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
| Cache names | always `cacheNamespace(buildId, kind)`. An unkeyed cache name is a rejected change. |
| Offline fallback | `requireOfflineFallback` runs inside `generateServiceWorker`. Never optional. |
| Capabilities | gate the manifest member **and** the SW block. Disabled → zero bytes. |
| Outbox | queue lives in `@ultimat3/realtime`. This package only registers the sync trigger. |
| Push strings | i18n keys only, rendered per subscriber locale. Never a literal. |
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
