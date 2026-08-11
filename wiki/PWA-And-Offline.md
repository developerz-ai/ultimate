# PWA and offline

`sw.js` is a build artifact, generated from the route table. Hand-editing it is a build error (`X_SW_HAND_EDITED`, checksum mismatch).

v1.1.0 `As of 2026-08`. Stable API — semver from here ([Upgrading](Upgrading)).

## Why generated

A service worker is a cache-policy compiler whose input is already declared on every route: render mode, offline strategy, asset graph. Hand-writing it duplicates that information, and the duplicate drifts. Every notorious PWA bug — the page serving last month's HTML, the chunk 404 after deploy, the user stuck on a version until they clear site data — is a service worker that disagreed with the app.

```
X_SW_HAND_EDITED: sw.js does not match its generated checksum
  cause: apps/web/public/sw.js differs from the artifact emitted for build 9f3c1a2
  fix:   x build   # change the route's `offline` field instead of editing sw.js
```

## Derived from the route

```ts
export const config = defineRoute({
  render:     'isr',                  // static | isr | ssr | stream | spa
  revalidate: { tags: [tag.post] },
  prerender:  () => db.posts.slugs(),
  offline:    'precache',             // precache | runtime | network-only
  hydrate:    'visible',              // idle | visible | interaction | never
  budget:     { js: '40kb', lcp: 2000 },
  meta:       ({ post }) => ({ title: post.title, description: post.excerpt,
                               og: { image: post.cover }, ld: ld.Article(post) }),
});
```

### Precache set

| Included | Source |
|---|---|
| Every route with `offline: 'precache'` | route table + its `prerender()` URLs |
| The JS/CSS chunks those routes import | real bundle graph, not a glob |
| Fonts, icons, and `priority` images they reference | asset graph |
| The offline fallback route | required (see below) |
| The app shell for `spa` routes | build output |

Excluded always: `api/` responses, anything under an authenticated path unless `offline: 'precache'` is explicit, and any asset over the configured single-file cap.

Total precache size is a **budget** — exceeding it fails `x verify` rather than shipping a 40MB install.

### Runtime strategy from render mode

| `render` | `offline` default | Strategy | Rationale |
|---|---|---|---|
| `static` | `precache` | cache-first, revalidate on build ID change | immutable per build |
| `isr` | `runtime` | stale-while-revalidate | matches ISR's own semantics exactly |
| `ssr` | `network-only` | network, offline fallback on failure | caching a per-request render is a correctness bug |
| `stream` | `runtime` | network-first for the document, cache-first for chunks | shell freshness matters; chunks are content-hashed |
| `spa` | `precache` | shell cache-first, data network-only | the shell is static; the data never is |

Overriding `offline` is allowed; contradictions are rejected.

```
X_SW_UNCACHEABLE: route cannot use the requested offline strategy
  cause: app/reports declares offline: 'precache' with render: 'ssr' — a per-request render has no cacheable body
  fix:   set render: 'isr' or offline: 'network-only' in apps/web/app/reports/page.tsx
```

Mutations are never cached. **Offline writes go through the tier-3 mutator queue ([Realtime](Realtime)), not through Background Sync guesswork** — a durable queue with a declared `conflict` strategy per mutator, replayed on reconnect and rebased against server truth. Background Sync, when enabled, is only a wake-up trigger for that queue; it is never the queue.

### Manifest, icons, splash

From `app.config.ts` plus **one** source icon (SVG or >=1024px PNG):

| Generated | Detail |
|---|---|
| `manifest.webmanifest` | name, short_name, description, `start_url`, `scope`, display, theme + background from design tokens |
| Icons | 192/256/384/512 + maskable variants + `apple-touch-icon` |
| Favicons | `.ico` + SVG |
| iOS splash screens | full device matrix |
| Shortcuts | from routes marked `shortcut: true` |
| Screenshots | captured from the built `site/` landing page for install prompts |

No icon-generator service, no 30-file `public/` directory to maintain. Theme and background colours come from semantic [theme](Theming) tokens, never a raw hex.

### Offline fallback is required in the type

```ts
// app.config.ts — omitting `offline.fallback` is a compile error
pwa: {
  offline: { fallback: '/offline' },   // required
}
```

`x new` scaffolds `/offline` in `site/` — 0kb JS, works from cache, shows the queued-mutation count. A PWA without a fallback shows the browser's dinosaur, which reads as "the app is broken", not "you are offline". Making it a required field means no app ships without one.

## Version skew is what actually breaks PWAs

Not caching strategy. **Skew**: a client running build `A` requesting an asset from build `B`.

```
user opens app (build A) → keeps tab open 3 days → you deploy 6 times
  → user clicks a route → lazy chunk from build A → 404 → white screen
```

The client is not broken and the server is not broken; they disagree about which version exists. Mitigations, all mandatory:

| # | Mechanism | Detail |
|---|---|---|
| 1 | **Immutable build ID per deploy** | content-hash of the build, stamped into `sw.js`, the HTML, every asset path, and `x.manifest.json`. Never a timestamp, never `latest` |
| 2 | **Client sends its build ID on every request** | `X-Ultimate-Build` header on RPC, query, and WS handshake. The server can answer "you are stale" instead of guessing |
| 3 | **N-deploy asset retention** | old builds' assets stay served for N deploys (default 10) or a minimum window (default 7d), whichever is longer. A build-A chunk resolves after six deploys |
| 4 | **`AppUpdateAvailable` signal, not a 404** | a Solid signal flips when the server reports a newer build. The app renders its own "Update available — reload" affordance. **No forced navigation, no lost form state, no dinosaur** |
| 5 | **Forced reload after a grace period** | security-flagged deploys (`x deploy --critical`) set a deadline. Client shows a countdown, saves in-flight state via the mutator queue, then reloads. Grace default 30m; a hard patch can set minutes |
| 6 | **Skew is observable** | the `/_x` live panel reports the build-ID distribution of connected clients, so "how many users are three deploys behind" has an answer. `x status --json` would report it outside dev and is **planned**, not shipped |
| 7 | **Build ID scopes the SW cache** | preview/branch builds get their own cache namespace and SW scope, so a preview can never poison prod caches |

Server behaviour on a stale build ID:

| Request type | Response |
|---|---|
| Asset still within retention | serve it |
| Asset outside retention | `410 Gone` + `X-Ultimate-Build-Current`, SW serves the fallback and flips `AppUpdateAvailable` |
| Action / query | executed if the contract is compatible; `X_BUILD_SKEW` with a `fix:` line if the input schema changed incompatibly |
| WS handshake | accepted, then a `build-stale` frame → signal flips; the socket is **not** killed |

`410 Gone` rather than `404`: a 404 is indistinguishable from a typo, and a client cannot act on it. `410` plus `X-Ultimate-Build-Current` is an instruction.

## Opt-in capabilities

Off by default. Each flag adds permission prompts, review burden, or platform surface, so none is implicit.

```ts
pwa: {
  offline: { fallback: '/offline' },
  push:           { enabled: true, vapid: env.VAPID },
  backgroundSync: { enabled: true, queues: ['mutations'] },
  badging:        { enabled: true, count: () => unreadCount() },
  shareTarget:    { enabled: true, accept: ['image/*', 'text/plain'] },
  fileHandlers:   [{ action: '/import', accept: { 'text/csv': ['.csv'] } }],
  periodicSync:   { enabled: false },
}
```

| Flag | Generates | Cost of enabling |
|---|---|---|
| `push` | SW push handler, subscription endpoint action, a `job` for send fanout | notification permission prompt; needs VAPID keys |
| `backgroundSync` | SW sync registration wired to the mutator queue | replay must be idempotent — enforced by the mutator's `conflict` field |
| `badging` | badge update from a live query | Chromium-only surface |
| `shareTarget` | manifest entry + a POST route | must handle untrusted payloads; the target route gets a required policy |
| `fileHandlers` | manifest entry + route | OS-level file association |
| `periodicSync` | SW periodic handler | rarely granted; document the fallback path |

All of them are `route` / `action` / `job` primitives underneath ([The eight primitives](The-Eight-Primitives)) — a push send is a job, a share target is a route with a policy. No PWA-specific concept escapes into the app's mental model.

## What `x verify` checks

| Check | Fails on |
|---|---|
| SW checksum | `sw.js` differs from the generated artifact (`X_SW_HAND_EDITED`) |
| Strategy coherence | an `offline` value contradicting the route's `render` (`X_SW_UNCACHEABLE`) |
| Precache budget | total precache bytes over the configured cap |
| Fallback presence | `pwa.offline.fallback` missing, or pointing at a route that does not exist |
| Prerenderability | a `precache` route that is not actually prerenderable |
| Retention config | asset retention below the minimum N-deploys / window |
| Build ID shape | a timestamp or `latest` used as a build ID |

`x test e2e` additionally asserts SW install, offline fallback rendering, and the version-skew reload path in a real browser. See [Testing](Testing).

## Rules

- Never hand-edit `sw.js`. Change the route, rebuild.
- Never cache an authenticated response without an explicit `offline` field on the route.
- Never use a timestamp or `latest` as a build ID.
- Never force-reload a user without a grace period, except on a `--critical` deploy.
- Never cache a mutation. Offline writes are the tier-3 mutator queue's job.
- Never ship a PWA without `/offline` — the type will not let you.
