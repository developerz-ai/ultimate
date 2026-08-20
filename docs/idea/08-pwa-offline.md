# PWA & offline

`sw.js` is a build artifact. It is generated from the route table and **never hand-edited**. `X_SW_HAND_EDITED` is the reserved name for the checksum mismatch that would catch it — **reserved, not raised** `As of 2026-08`: `sw.js` carries no checksum, so a hand edit survives `x build` and is silently overwritten on the next one ([Error codes → Reserved codes](../../wiki/Error-Codes.md#reserved-codes)). A convention today, not a build error.

## Why generated

A service worker is a cache-policy compiler whose input is already declared on every route: render mode, offline strategy, and asset graph. Hand-writing it duplicates that information, and the duplicate drifts. Every notorious PWA bug — the page that serves last month's HTML, the chunk 404 after deploy, the user stuck on a version until they clear site data — is a service worker that disagreed with the app.

## Derived from the route

```ts
// route
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

Excluded always: `api/` responses, anything under an authenticated path unless `offline: 'precache'` is explicit, and any asset over the configured single-file cap. Total precache size is a **budget** — exceeding it fails `x verify` rather than shipping a 40MB install.

### Runtime strategy from render mode

| `render` | `offline` default | Strategy | Rationale |
|---|---|---|---|
| `static` | `precache` | cache-first, revalidate on build ID change | immutable per build |
| `isr` | `runtime` | stale-while-revalidate | matches ISR's own semantics exactly |
| `ssr` | `network-only` | network, offline fallback on failure | caching a per-request render is a correctness bug |
| `stream` | `runtime` | network-first for the document, cache-first for chunks | shell freshness matters; chunks are content-hashed |
| `spa` | `precache` | shell cache-first, data network-only | the shell is static; the data never is |

Overriding `offline` is allowed. Contradictions are **not** rejected `As of 2026-08`: `offline: 'precache'` on an `ssr` route is accepted, and `X_SW_UNCACHEABLE` is a reserved name with no thrower. `X_ROUTE_OFFLINE_MISSING` refuses only an absent or unknown strategy; `X_SW_SCOPE_INVALID` covers only the scope half.

Mutations are never cached. Offline writes go through the tier-3 mutator queue ([`03-realtime.md`](./03-realtime.md)), not through Background Sync guesswork.

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

No icon-generator service, no 30-file `public/` directory to maintain.

### Offline fallback is required in the type

```ts
// app.config.ts — omitting `offline.fallback` is a compile error
pwa: {
  offline: { fallback: '/offline' },   // required
}
```

`x new` scaffolds `/offline` in `site/` (0kb JS, works from cache, shows queued-mutation count). A PWA without a fallback shows the browser's dinosaur — which reads as "the app is broken", not "you are offline". Making it a required field means no app ships without one.

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
| 5 | **Forced reload after a grace period** | **designed, not wired `As of 2026-08`.** The generated service worker posts only `{ type: 'AppUpdateAvailable', to: BUILD_ID }` on activation — no `from`, no `forced`, no `deadlineAt` — so even the *unforced* stale-build notification arrives without the fields a client would decide on. `updateSignal`, which computes all four, is exported and has **no runtime caller**; neither the stale-response nor the WebSocket notification path exists. `x deploy --critical` was deleted in 4.0.0: it recorded the intent in the plan JSON and nothing read it, and a flag that changes nothing is worse than an absent one because it reads as wired. Wiring it needs a caller passing `BUILD_ID_HEADER` into `updateSignal` and posting the full message, plus a per-release reason on the container. The grace default is **6h**, and a forced deadline is `now` — there is no framework-run countdown |
| 6 | **Skew is observable** | `/_x` and `x status --json` report the build-ID distribution of connected clients, so "how many users are three deploys behind" has an answer |
| 7 | **Build ID scopes the SW cache** | preview/branch builds get their own cache namespace and SW scope, so a preview can never poison prod caches ([`09-ai-first.md`](./09-ai-first.md)) |

Server behaviour on a stale build ID:

| Request type | Response |
|---|---|
| Asset still within retention | serve it |
| Asset outside retention | `410 Gone` + `X-Ultimate-Build-Current`, SW serves the fallback and flips `AppUpdateAvailable` |
| Action / query | executed if the contract is compatible; `X_BUILD_SKEW` with a `fix:` line if the input schema changed incompatibly |
| WS handshake | accepted, then an `update-available` frame → signal flips; the socket is not killed |

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
}
```

| Flag | Generates | Cost of enabling |
|---|---|---|
| `push` | SW push handler, subscription endpoint action, a `job` for send fanout | notification permission prompt; needs VAPID keys |
| `backgroundSync` | SW sync registration wired to the mutator queue | replay must be idempotent — enforced by the mutator's `conflict` field |
| `badging` | badge update from a live query — **only alongside `push`** `As of 2026-08-20`: the badge call is emitted inside the push block, so `badging: true` on its own changes nothing while `capabilities.badging` still reports `true` | Chromium-only surface |
| `shareTarget` | manifest entry + a POST route | must handle untrusted payloads; the target route gets a required policy |
| `fileHandlers` | manifest entry + route | OS-level file association |
| ~~`periodicSync`~~ | **not built, and the declarations are deleted** `As of 2026-08-20`. There was never a `periodicsync` listener, never a `periodicSync.register` call, and no `CAPABILITIES` flag to gate one — `PERIODIC_SYNC_TAG` and `periodicMinIntervalMs` described a feature that did not exist | — |

All of them are `route`/`action`/`job` primitives underneath ([`02-primitives.md`](./02-primitives.md)) — a push send is a job, a share target is a route with a policy. No PWA-specific concept escapes into the app's mental model.

## Rules

- Never hand-edit `sw.js`. Change the route, rebuild.
- Never cache an authenticated response without an explicit `offline` field on the route.
- Never use a timestamp or `latest` as a build ID.
- Never force-reload a user without a grace period. The `--critical` exception is designed and not wired — see row 5.
- `x verify` checks: precache budget, fallback presence, SW checksum, retention config, and that every `precache` route is actually prerenderable.
