---
title: PWA and offline
nav: PWA
description: The service worker is a build artifact generated from the route table, and version skew — not caching strategy — is what actually breaks progressive web apps.
lede: `sw.js` is generated from the route table and never hand-edited. Editing it is a build error.
updated: 2026-07-26
---

## Why generated

A service worker is a cache-policy compiler whose input is already declared on every route:
render mode, offline strategy, asset graph. Hand-writing it duplicates that information, and
the duplicate drifts. Every notorious PWA bug — the page that serves last month's HTML, the
chunk 404 after deploy, the user stuck on a version until they clear site data — is a service
worker that disagreed with the app.

```text
X_SW_HAND_EDITED: sw.js does not match its build checksum
  cause: public/sw.js was modified after the last build
  fix:   x build   (change the route's `offline` field instead of editing sw.js)
```

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

| Precached | Source |
|---|---|
| Every route with `offline: 'precache'` | route table + its `prerender()` URLs |
| The JS/CSS chunks those routes import | real bundle graph, not a glob |
| Fonts, icons and `priority` images they reference | asset graph |
| The offline fallback route | required |
| The app shell for `spa` routes | build output |

Excluded always: `api/` responses, anything under an authenticated path unless
`offline: 'precache'` is explicit, and any asset over the configured single-file cap. Total
precache size is a budget — exceeding it fails `x verify` rather than shipping a 40MB install.

| `render` | `offline` default | Strategy | Rationale |
|---|---|---|---|
| `static` | `precache` | cache-first, revalidate on build ID change | immutable per build |
| `isr` | `runtime` | stale-while-revalidate | matches ISR's own semantics exactly |
| `ssr` | `network-only` | network, offline fallback on failure | caching a per-request render is a correctness bug |
| `stream` | `runtime` | network-first for the document, cache-first for chunks | shell freshness matters; chunks are content-hashed |
| `spa` | `precache` | shell cache-first, data network-only | the shell is static; the data never is |

Contradictions are rejected: `offline: 'precache'` on an `ssr` route is `X_SW_UNCACHEABLE`.

## Generated assets

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

## The fallback is required in the type

```ts
// app.config.ts — omitting `offline.fallback` is a compile error
pwa: {
  offline: { fallback: '/offline' },   // required
}
```

`x new` scaffolds `/offline` in `site/` — 0kb JS, works from cache, shows the queued-mutation
count. A PWA without a fallback shows the browser's dinosaur, which reads as "the app is
broken", not "you are offline".

## Version skew is what actually breaks PWAs

Not caching strategy. **Skew**: a client running build `A` requesting an asset from build `B`.

```text
user opens app (build A) → keeps tab open 3 days → you deploy 6 times
  → user clicks a route → lazy chunk from build A → 404 → white screen
```

| # | Mechanism | Detail |
|---|---|---|
| 1 | **Immutable build ID per deploy** | content-hash of the build, stamped into `sw.js`, the HTML, every asset path and `x.manifest.json`. Never a timestamp, never `latest` |
| 2 | **Client sends its build ID on every request** | `X-Ultimate-Build` on RPC, query and WS handshake. The server answers "you are stale" instead of guessing |
| 3 | **N-deploy asset retention** | old builds' assets stay served for N deploys (default 10) or a minimum window (default 7d), whichever is longer |
| 4 | **`AppUpdateAvailable` signal, not a 404** | a Solid signal flips when the server reports a newer build. The app renders its own "Update available — reload" affordance. No forced navigation, no lost form state |
| 5 | **Forced reload after a grace period** | `x deploy --critical` sets a deadline; the client shows a countdown, saves in-flight state via the mutator queue, then reloads. Grace default 30m |
| 6 | **Skew is observable** | `/_x` and `x status --json` report the build-ID distribution of connected clients |
| 7 | **Build ID scopes the SW cache** | preview/branch builds get their own cache namespace and SW scope, so a preview can never poison prod caches |

| Request type | Response on a stale build ID |
|---|---|
| Asset still within retention | serve it |
| Asset outside retention | `410 Gone` + `X-Ultimate-Build-Current`; SW serves the fallback and flips `AppUpdateAvailable` |
| Action / query | executed if the contract is compatible; `X_BUILD_SKEW` with a `fix:` line if the input schema changed incompatibly |
| WS handshake | accepted, then a `build-stale` frame → signal flips; the socket is not killed |

## Opt-in capabilities

Off by default. Each flag adds permission prompts, review burden or platform surface.

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

Each one is a `route`, `action` or `job` underneath: a push send is a job, a share target is a
route with a required policy. No PWA-specific concept escapes into the app's mental model.

Offline writes go through the tier-3 mutator queue, never Background Sync guesswork. Mutations
are never cached.

## Rules

- Never hand-edit `sw.js`. Change the route, rebuild.
- Never cache an authenticated response without an explicit `offline` field on the route.
- Never use a timestamp or `latest` as a build ID.
- Never force-reload a user without a grace period, except on a `--critical` deploy.
- `x verify` checks: precache budget, fallback presence, SW checksum, retention config, and that every `precache` route is actually prerenderable.
