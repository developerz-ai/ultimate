# 📲 @ultimat3/pwa

**You never open `sw.js`.** It is emitted from the route table. That is this package's
whole thesis: a hand-written service worker encodes routing decisions a second time, and
the second copy is the one nobody updates.

```ts
const { source, precache, warnings } = generateServiceWorker(describeRoutes(), config, buildId);
```

## Render mode → runtime strategy

| Render mode | Strategy | Why |
|---|---|---|
| `static` | cache-first | built once; the URL's bytes only change on deploy |
| `isr` | stale-while-revalidate | stale is correct by construction, refresh behind |
| `stream` | stale-while-revalidate | shell is reusable, holes come from the network |
| `ssr` | network-first | freshness is the point; cache is the offline safety net |
| `spa` | cache-first | the shell is identical for every actor |

Overrides: `offline: 'network-only'` forces `network-only`; a per-route `strategy` wins over
everything. `api/` routes get no cache rule at all.

| `offline` | Meaning |
|---|---|
| `precache` | fetched at install, keyed by content hash |
| `runtime` | cached on first visit under the render-mode strategy |
| `network-only` | never served from a cache |

## Version skew — the thing that actually breaks PWAs

A client loaded build A hours ago. Build B deletes A's chunks. The next lazy import 404s
and the app dies with a blank screen and no error anyone can act on.

| Mechanism | Rule |
|---|---|
| Build id | immutable per deploy, derived from the commit sha; `X_BUILD_ID_MISSING` if absent |
| Client → server | every SW-proxied request carries `x-ultimate-build` |
| Retention | `retentionPlan(deploys, keep)` keeps the last N deploys' assets alive (default 3) |
| Stale client | gets `AppUpdateAvailable`, never a 404 |
| Forced reload | none. This package never navigates a client — the app decides what to do with the message |
| Preview deploys | cache names are `x-<kind>-<buildId>`, so a branch build cannot poison production |

```ts
// The generated worker posts this to every page it controls, on activation — and this is the
// whole message, which `version-skew.test.ts` holds the interface to.
// { type: 'AppUpdateAvailable', to: BUILD_ID }
detectSkew(clientBuildId, message.to); // 'current' | 'stale' | 'unknown'
```

`unknown` means no id was sent — a first load or a crawler — and is never treated as stale.

## The offline fallback is mandatory in the type

```
X_PWA_NO_OFFLINE_FALLBACK: no offline fallback route
  cause: app.config.ts has no `offline` block, so an offline navigation would show the browser's error page
  fix:   create app/offline.tsx and set offline.fallback
```

`requireOfflineFallback(config)` runs inside `generateServiceWorker`, so the build fails
before an un-shippable PWA exists.

## Capabilities are opt-in, and gate bytes

| Capability | Manifest member | SW code |
|---|---|---|
| `push` | — | `push` + `notificationclick` listeners |
| `backgroundSync` | — | `sync` listener + outbox flush |
| `badging` | — | `navigator.setAppBadge` after a push |
| `shareTarget` | `share_target` | — |
| `fileHandlers` | `file_handlers` | — |
| `protocolHandlers` | `protocol_handlers` | — |

A disabled capability emits neither the manifest member nor the SW code. An unused
capability ships zero bytes and asks for zero permissions.

Three of the six are manifest-only, and the `—` in their SW column is load-bearing: the OS hands a
share, a file or a protocol URL to a route the app already serves, so there is no worker branch to
gate. `CAPABILITY_SW_MARKERS` is checked against the emitted `sw.js` in both directions, so a claim
here that the generator does not honour is a failing test rather than an installed app announcing a
capability nothing implements.

## Public API

| Export | Owns |
|---|---|
| `generateServiceWorker` | `sw.js` from the route table; deterministic for identical input |
| `strategyFor`, `MODE_STRATEGY`, `cacheFirst`, … | the four strategies + the mapping table |
| `buildPrecacheManifest` | precache entries (url + content-hash revision), size warnings |
| `buildId`, `detectSkew`, `retentionPlan` | version skew |
| `generateWebManifest` | the manifest + `theme-color` metas for both schemes, from a `WebManifestInput`. Called by `@ultimat3/cli` (`pwa-artifacts.ts`) `As of 2026-08-27`, so `x dev`, the container and the static export all emit `manifest.webmanifest` |
| `planIcons`, `requireSourceIcon`, `maskableSafeZone` | icons and splashes from one source |
| `BuiltinImagePipeline` | renders that plan: one square PNG per entry, deterministic |
| `requireOfflineFallback` | the mandatory offline route |
| `backgroundSyncSource`, `registerBackgroundSyncSource` | the Background Sync trigger. No retry policy: the handler rejects and the PLATFORM reschedules it |
| `renderPushPayload`, `pushSource`, `subscribeSource` | Web Push, per-locale bodies |
| `createInstallController`, `iosInstallGuidance` | install prompt, never on first paint |
| `PwaStrategyExhaustedError` and the other `errors.ts` classes | the codes this package throws, catchable by an app |

## Notes

- **Theme colours come from the design tokens for both schemes.** The manifest spec carries
  one `theme_color`, so the dark value is emitted as a media-scoped
  `<meta name="theme-color">` — otherwise an installed dark app launches with a light status
  bar every time. The shape is `@ultimat3/core`'s `PwaColors`, which is what an app writes in
  `app.config.ts` as `pwa.colors`; this package declared its own identical `ThemeTokens` until
  2026-08-27, with nothing asserting the two agreed.
- **`WebManifestInput` is not the `pwa` block of `app.config.ts`.** It was called `PwaConfig` and
  said it was, while `@ultimat3/core` exported a different type of that name that really is the
  block. An app writes `name` and `colors`; every other member is a caller's.
- **The service worker has a build behind it, `As of 2026-08`.** `generateServiceWorker` — and
  through it `buildPrecacheManifest`, `offlineFallbackSource`, `backgroundSyncSource` and
  `pushSource` — is called by `packages/cli/src/sw-artifacts.ts`, so `x dev`, the container and the
  static export all emit `sw.js` and `x-sw-register.js`
  ([#390](https://github.com/developerz-ai/ultimate/issues/390)). It landed a release after the
  manifest half because a bad `sw.js` is sticky: it waited on a real browser check
  (`packages/cli/e2e/service-worker.e2e.test.ts`), which the tree could not run until #400.
- **Precache revisions are content hashes, never the build id.** Keying on the build id
  re-downloads every asset on every deploy.
- **The mutation queue lives in `@ultimat3/realtime`, not here** (SRP). This package owns
  only the Background Sync trigger that asks realtime to flush.
- **Push bodies are rendered server-side per subscriber locale**, from the locale stored on
  the subscription. A notification in the wrong language is a real bug, and the sending
  server has no request context to infer one from.
- **Icons come from one source image.** `X_PWA_ICON_MISSING` names the file to add;
  `BuiltinImagePipeline` renders the whole matrix from it through `@ultimat3/core`'s image
  pipeline — no `sharp`, no vendor image CDN, no native build step. Every output is a square
  PNG, because `type: 'image/png'` is what the manifest declares. A maskable icon's artwork
  lands exactly inside `maskableSafeZone(size)`; the ring around it is `background`, which is
  hex or `transparent` (there are no named colours). Same bytes in, same bytes out.
- **Every HTML sink goes through one escaper.** `appleTouchLinks` and `renderThemeColorMeta`
  interpolate app configuration into attributes, so both run it through `escapeAttribute` from
  `@ultimat3/seo` (tier 1, and the one this package can reach — `@ultimat3/render`'s `html.ts` is
  tier 4, sideways). Never a second escaper here.
- **A precache URL may already carry a query.** `PrecacheAsset.url` is public API and bundlers emit
  `?v=<hash>` of their own, so the install block picks `?` or `&` per entry. A fixed `?` produced
  `...?locale=en?v=<rev>`, and because `cache.addAll` is all-or-nothing a single non-200 there means
  the worker never installs at all.
- **Route data arrives as data.** `@ultimat3/render` and `@ultimat3/pwa` are both tier 4, so
  `PwaRoute` is a structural view of `RouteDescriptor`, never an import.
