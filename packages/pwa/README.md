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
| Forced reload | only for `forceOn` reasons, only after `graceMs` (default 6h) |
| Preview deploys | cache names are `x-<kind>-<buildId>`, so a branch build cannot poison production |

```ts
detectSkew(clientBuildId, serverBuildId);   // 'current' | 'stale' | 'unknown'
updateSignal({ clientBuildId, serverBuildId, policy: updatePolicy() });
// → { type: 'AppUpdateAvailable', from, to, forced, deadlineAt }
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
| `shareTarget` | `share_target` | share-target route rule |
| `fileHandlers` | `file_handlers` | — |
| `protocolHandlers` | `protocol_handlers` | — |

A disabled capability emits neither the manifest member nor the SW code. An unused
capability ships zero bytes and asks for zero permissions.

## Public API

| Export | Owns |
|---|---|
| `generateServiceWorker` | `sw.js` from the route table; deterministic for identical input |
| `strategyFor`, `MODE_STRATEGY`, `cacheFirst`, … | the four strategies + the mapping table |
| `buildPrecacheManifest` | precache entries (url + content-hash revision), size warnings |
| `buildId`, `detectSkew`, `retentionPlan`, `updatePolicy`, `updateSignal` | version skew |
| `generateWebManifest` | the manifest + `theme-color` metas for both schemes |
| `planIcons`, `requireSourceIcon`, `maskableSafeZone` | icons and splashes from one source |
| `requireOfflineFallback` | the mandatory offline route |
| `backgroundSyncSource`, `retryDelayMs` | the Background Sync trigger |
| `renderPushPayload`, `pushSource`, `subscribeSource` | Web Push, per-locale bodies |
| `createInstallController`, `iosInstallGuidance` | install prompt, never on first paint |

## Notes

- **Theme colours come from the design tokens for both schemes.** The manifest spec carries
  one `theme_color`, so the dark value is emitted as a media-scoped
  `<meta name="theme-color">` — otherwise an installed dark app launches with a light status
  bar every time.
- **Precache revisions are content hashes, never the build id.** Keying on the build id
  re-downloads every asset on every deploy.
- **The mutation queue lives in `@ultimat3/realtime`, not here** (SRP). This package owns
  only the Background Sync trigger that asks realtime to flush.
- **Push bodies are rendered server-side per subscriber locale**, from the locale stored on
  the subscription. A notification in the wrong language is a real bug, and the sending
  server has no request context to infer one from.
- **Icons come from one source image.** `X_PWA_ICON_MISSING` names the file to add; the
  transform driver is an `ImagePipeline` interface with a labelled `X_NOT_IMPLEMENTED`
  pending Bun's native image API — no `sharp`, no vendor image CDN.
- **Route data arrives as data.** `@ultimat3/render` and `@ultimat3/pwa` are both tier 4, so
  `PwaRoute` is a structural view of `RouteDescriptor`, never an import.
