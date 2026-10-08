# 📲 @ultimat3/pwa

**You never open `sw.js`.** It is emitted from the route table. That is this package's
whole thesis: a hand-written service worker encodes routing decisions a second time, and
the second copy is the one nobody updates.

```ts
const { source, precache, warnings } = generateServiceWorker(describePages(), config, buildId);
```

## Render mode → runtime strategy

| Render mode | Strategy | Why |
|---|---|---|
| `static` | network-first | the document names this deploy's hashed assets; the precache is the offline copy |
| `isr` | network-first | the server's ISR cache is already the stale one; a browser copy only delays a deploy |
| `stream` | network-first | the shell names this deploy's chunks; the cache is the offline copy |
| `ssr` | network-first | freshness is the point; cache is the offline safety net |

Every rule is a document, so every mode is network-first (22.3.2): `static` was cache-first and
`isr`/`stream` stale-while-revalidate, and an online visitor got the previous deploy's HTML until a
hard reload. `offline: 'precache'` still precaches — for offline. The worker enables navigation
preload on `activate` and answers a navigation from `event.preloadResponse`, and fills its precache
`PRECACHE_CONCURRENCY` entries at a time. The worker calls `skipWaiting()`
in `install`, so a deploy takes over without every tab closing; it never reloads a page.

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
| Client → server | every SW-proxied request carries `x-ultimate-build` — `@ultimat3/core`'s `BUILD_ID_HEADER` |
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
  fix:   set pwa: { offline: { fallback: '/offline' } } in app.config.ts, then create the route it names: x g route offline --surface site
```

`requireOfflineFallback(config)` runs inside `generateServiceWorker`, so the build fails
before an un-shippable PWA exists. `pwa.offline.image` and `pwa.offline.font` are the
placeholders a failed image or font request gets — each served only from the precache.

## Capabilities are opt-in, and gate bytes

| Capability | Manifest member | SW code |
|---|---|---|
| `push` | — | `push` + `notificationclick` listeners; a tap opens a same-origin URL only. Emitted only when a `vapid` key comes with it — the web role passes `installedVapid()` |
| `backgroundSync` | — | `sync` listener that tells every open tab to drain realtime's outbox (`OUTBOX_DRAIN_MESSAGE`) |
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

## Web Push

`pwa: { push: true, vapid: { subject: 'mailto:ops@example.com' } }` in `app.config.ts`, and the rest
is wiring the framework does: the boot resolves the VAPID pair from the environment and installs the
runtime, the worker carries the handlers, every page carries `<meta name="x-push-key">`. RFC 8291
encryption and RFC 8292 (ES256) signing, on WebCrypto — no dependency.

```ts
// apps/web/app/push/actions.ts — two real actions: route, OpenAPI, typed client, contract tests.
import { pushSubscribe, pushUnsubscribe } from '@ultimat3/pwa';

export const subscribePush = pushSubscribe({ permission: 'push:subscribe' });
export const unsubscribePush = pushUnsubscribe({ permission: 'push:subscribe' });
```

```ts
// an island, on a click — `@ultimat3/pwa/client` imports nothing.
import { subscribeToPush } from '@ultimat3/pwa/client';

declare const client: { subscribePush(input: unknown): Promise<unknown> };

const outcome = await subscribeToPush({ save: client.subscribePush });
// { status: 'subscribed', endpoint } | { status: 'denied' } | { status: 'unsupported' } | { status: 'unconfigured' }
```

```ts
// a notifier — every device of the recipient, each in the locale it subscribed with.
import { pushChannel } from '@ultimat3/notify';
import { webPush } from '@ultimat3/pwa';

export const channel = pushChannel<{ postId: string }>({
  pusher: webPush(),
  message: ({ event }) => ({
    titleKey: 'push.comment.title',
    bodyKey: 'push.comment.body',
    url: `/posts/${event.params.postId}`,
    tag: `post:${event.params.postId}`,
  }),
});
```

| Piece | Rule |
|---|---|
| Keys | `ULTIMATE_VAPID_PUBLIC_KEY` + `ULTIMATE_VAPID_PRIVATE_KEY`, env only. `x vapid create` seals both in one write; locally, neither set signs with `DEV_VAPID_KEYS`, which a deployed boot refuses (`X_PWA_VAPID_KEY_MISSING`). Two halves that do not sign for each other: `X_PWA_VAPID_KEY_INVALID`, at boot |
| Subscriptions | `x_push_subscriptions`, applied by the boot; keyed by endpoint, stored against `ctx.actor.id`, with the locale and zone they subscribed in. An agent never subscribes |
| Strings | catalog keys (`titleKey`, `bodyKey`, `actions[].titleKey`), rendered per subscription locale through `@ultimat3/i18n`'s `translatorFor` |
| Size | one 4096-byte record: 3993 bytes of notification (`X_PWA_PUSH_PAYLOAD_TOO_LARGE`). Send a path, never the content |
| Travel | `ttlSeconds` (default 86 400), `urgency`, `topic` — RFC 8030 headers; the topic is any string, sent as 32 URL-safe characters of its SHA-256 |
| 201 / 404, 410 / 429, 5xx / 400, 403, 413 | delivered / subscription deleted / `X_PWA_PUSH_FAILED`, retried by the job after every other device was tried / `X_PWA_PUSH_REJECTED`, logged, never retried |
| `renotify` | dropped, with a warning, without a `tag` — at both ends |

## Error classes

Every error class `src/index.ts` exports, for `instanceof` inside one process. Across a wire or
a job boundary the class is gone and the `code` is what survives — match on that.

| Class | Code | Declared in |
|---|---|---|
| `BuildIdMissingError` | `X_BUILD_ID_MISSING` | `src/errors.ts` |
| `PwaIconMissingError` | `X_PWA_ICON_MISSING` | `src/errors.ts` |
| `PwaManifestInvalidError` | `X_PWA_MANIFEST_INVALID` | `src/errors.ts` |
| `PwaNoOfflineFallbackError` | `X_PWA_NO_OFFLINE_FALLBACK` | `src/errors.ts` |
| `PwaPushFailedError` | `X_PWA_PUSH_FAILED` | `src/errors.ts` |
| `PwaPushPayloadTooLargeError` | `X_PWA_PUSH_PAYLOAD_TOO_LARGE` | `src/errors.ts` |
| `PwaPushRejectedError` | `X_PWA_PUSH_REJECTED` | `src/errors.ts` |
| `PwaPushSubscriptionInvalidError` | `X_PWA_PUSH_SUBSCRIPTION_INVALID` | `src/errors.ts` |
| `PwaPushUnconfiguredError` | `X_PWA_PUSH_UNCONFIGURED` | `src/errors.ts` |
| `PwaStrategyExhaustedError` | `X_PWA_STRATEGY_EXHAUSTED` | `src/errors.ts` |
| `PwaVapidKeyInvalidError` | `X_PWA_VAPID_KEY_INVALID` | `src/errors.ts` |
| `PwaVapidKeyMissingError` | `X_PWA_VAPID_KEY_MISSING` | `src/errors.ts` |
| `SwScopeInvalidError` | `X_SW_SCOPE_INVALID` | `src/errors.ts` |

## Public API

| Export | Owns |
|---|---|
| `generateServiceWorker` | `sw.js` from the route table; deterministic for identical input |
| `strategyFor`, `MODE_STRATEGY`, `cacheFirst`, … | the four strategies + the mapping table; a `personal` route is `network-only`. Each answers what its emitted `sw.js` twin answers: the cache copy goes to `env.wait` and is never awaited (a failed copy costs the copy, not the response), and an exhausted strategy with no fallback rejects — `staleWhileRevalidate` with `X_PWA_STRATEGY_EXHAUSTED` |
| `routeRules`, `assetRules` | the worker's rule list: routes most specific first, runtime asset prefixes (`/islands/`) ahead of them. `routeRules(routes, personalPages)` — `'last-member'` gives a personal page a `pages` rule; a pattern matches the browser's percent-encoded pathname, and a catch-all its bare prefix |
| `CLEAR_PAGES_MESSAGE`, `PAGES_CLEARED_MESSAGE` | `{ type: 'clear-pages' }` — post it to the worker on sign-out; it empties every pages cache and answers `{ type: 'pages-cleared' }` |
| `buildPrecacheManifest` | precache entries (url + content-hash revision), size warnings |
| `buildId`, `detectSkew`, `retentionPlan` | version skew |
| `generateWebManifest` | the manifest + `theme-color` metas for both schemes, from a `WebManifestInput`. Called by `@ultimat3/cli` (`pwa-artifacts.ts`) `As of 2026-08-27`, so `x dev`, the container and the static export all emit `manifest.webmanifest` |
| `planIcons`, `requireSourceIcon`, `maskableSafeZone` | icons and splashes from one source |
| `BuiltinImagePipeline` | renders that plan: one square PNG per entry, deterministic |
| `requireOfflineFallback` | the mandatory offline route |
| `backgroundSyncSource`, `registerBackgroundSyncSource` | the Background Sync trigger. No retry policy: the handler rejects and the PLATFORM reschedules it |
| `renderPushPayload`, `pushSource`, `subscribeSource` | Web Push, per-locale bodies |
| `pushSubscribe`, `pushUnsubscribe` | factories over `action`: store / forget this browser's subscription for `ctx.actor` |
| `webPush`, `pushToActor` | one notification to every device of one person — `webPush()` is notify's `Pusher` |
| `sendPushMessage`, `encryptPushMessage`, `vapidAuthorization` | one message to one subscription; RFC 8291; RFC 8292 |
| `installWebPush`, `installedVapid`, `webPushRuntime`, `resetWebPush` | the runtime the boot installs (store, signer, transport, translator) |
| `memoryPushSubscriptionStore`, `postgresPushSubscriptionStore` | where subscriptions live; `x_push_subscriptions` DDL is `@ultimat3/pwa/schema` |
| `resolveVapidKeys`, `generateVapidKeys`, `assertVapidPair`, `DEV_VAPID_KEYS` | the key pair: from env, minted, checked, and the published development one |
| `@ultimat3/pwa/client`: `subscribeToPush`, `unsubscribeFromPush`, `pushPermission` | the browser half, import-free |
| `installController`, `iosInstallGuidance` | install prompt, never on first paint |
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
  only the Background Sync trigger that tells the open tabs to drain it.
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
  interpolate app configuration into attributes, so both run it through `escapeHtml` from
  `@ultimat3/core` — the framework's one HTML character table (`@ultimat3/render`'s `html.ts` is
  tier 4, sideways, and re-exports the same function). Never a second escaper here.
- **A precache URL may already carry a query.** `PrecacheAsset.url` is public API and bundlers emit
  `?v=<hash>` of their own, so the install block picks `?` or `&` per entry. A fixed `?` produced
  `...?locale=en?v=<rev>`, and because `cache.addAll` is all-or-nothing a single non-200 there means
  the worker never installs at all.
- **Route data arrives as data.** `@ultimat3/render` and `@ultimat3/pwa` are both tier 4, so
  `PwaRoute` is a structural view of `RouteDescriptor`, never an import.
