# PWA and offline

`sw.js` is a build artifact, generated from the route table. Hand-editing it is **not** caught: `As of 2026-08` `sw.js` carries no checksum, so an edit survives the build and is silently overwritten by the next one. `X_SW_HAND_EDITED` is a **reserved** name — nothing raises it, and `x errors explain X_SW_HAND_EDITED` refuses it ([Error codes → Not thrown yet](Error-Codes#not-thrown-yet)). Treat "do not edit `sw.js`" as a convention, not a rule, until the checksum ships.

`As of 2026-08`. Stable API — semver from here ([Upgrading](Upgrading)).

## Why generated

A service worker is a cache-policy compiler whose input is already declared on every route: render mode, offline strategy, asset graph. Hand-writing it duplicates that information, and the duplicate drifts. Every notorious PWA bug — the page serving last month's HTML, the chunk 404 after deploy, the user stuck on a version until they clear site data — is a service worker that disagreed with the app.

The edit an agent should make is the route's `offline` field, then `x build`. Nothing enforces that today — see the reserved-code note above.

## Derived from the route

```ts
export const config = defineRoute({
  render:     'isr',                  // static | isr | ssr | stream
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

Excluded always: `api/` responses, anything under an authenticated path unless `offline: 'precache'` is explicit, and any asset over the configured single-file cap.

Total precache size is a **budget** — exceeding it fails `x verify` rather than shipping a 40MB install.

### Runtime strategy from render mode

`MODE_STRATEGY` in `packages/pwa/src/strategies.ts`, read by `strategyFor()` and keyed on
`Record<RenderMode, StrategyName>` — a mode with no row and a row for a mode that does not exist
are both compile errors, `As of 2026-08`.

| `render` | Strategy | Rationale |
|---|---|---|
| `static` | `cache-first` | immutable per build |
| `isr` | `stale-while-revalidate` | matches ISR's own semantics exactly |
| `ssr` | `network-first` | caching a per-request render is a correctness bug; the offline fallback answers on failure |
| `stream` | `stale-while-revalidate` | the shell is the cacheable part and the holes re-fetch anyway |

**There is no per-mode `offline` default** — `offline` is required by `defineRoute`'s type and again
at runtime (`X_ROUTE_OFFLINE_MISSING`). It is read *before* the mode: `offline: 'network-only'` is a
declaration that this URL is never answered from a cache, and `strategyFor` returns `network-only`
without consulting the table. A per-route `strategy` overrides both.

Overriding `offline` is allowed. Contradictions are **not** rejected `As of 2026-08`: `offline: 'precache'` on a `render: 'ssr'` route is accepted, and `X_SW_UNCACHEABLE` is a reserved name nothing raises ([Error codes → Not thrown yet](Error-Codes#not-thrown-yet)). The scope half *is* enforced — `X_SW_SCOPE_INVALID`, when the service-worker scope cannot serve the routes it precaches. Until the coherence check ships, review the pairing yourself: a per-request render has no cacheable body, so `precache` on `ssr` means the shell is served stale.

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
| 3 | **N-deploy asset retention** | the last **3** builds' assets stay served — `retentionPlan(deploys, keep = 3)` in [`packages/pwa/src/version-skew.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/pwa/src/version-skew.ts). A **count of deploys, with no time component**: no 7-day minimum, and **no `pwa.retention` config field** — `keep` is a call-site argument. A build-A chunk resolves for two more deploys |
| 4 | **`AppUpdateAvailable` signal, not a 404** | a Solid signal flips when the server reports a newer build. The app renders its own "Update available — reload" affordance. **No forced navigation, no lost form state, no dinosaur** |
| 5 | **Forced reload after a grace period** | **Not a capability of this package.** Deleted in 9.0.0 — `updateSignal`/`updatePolicy` computed a deadline nothing acted on, and `pwa` (tier 4) sits above the two runtimes that hold both build ids. The service worker posts `{ type: 'AppUpdateAvailable', to }`; act on it yourself, or read `useConnection().updateAvailable` |
| 6 | **Skew is observable** | the `/_x` live panel reports the build-ID distribution of connected clients, so "how many users are three deploys behind" has an answer. `x status --json` would report it outside dev and is **planned**, not shipped |
| 7 | **Build ID scopes the SW cache** | preview/branch builds get their own cache namespace and SW scope, so a preview can never poison prod caches |

Server behaviour on a stale build ID:

| Request type | Response |
|---|---|
| Asset still within retention | serve it |
| Asset outside retention | `410 Gone` + `X-Ultimate-Build-Current`, SW serves the fallback and flips `AppUpdateAvailable` |
| Action / query | executed if the contract is compatible; `X_BUILD_SKEW` with a `fix:` line if the input schema changed incompatibly |
| WS handshake | accepted, then an `update-available` frame carrying the server's `buildId` → signal flips; the socket is **not** killed |

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

All of them are `route` / `action` / `job` primitives underneath ([The eight primitives](The-Eight-Primitives)) — a push send is a job, a share target is a route with a policy. No PWA-specific concept escapes into the app's mental model.

## What is checked, and where

`x verify` has **no PWA step** — its 20 steps are typecheck, lint, boundaries, filesize, package-shape, errors, unit, contract, live, job, e2e, eval, drift, contract-diff, budgets, seo, i18n, policy, manifest, roadmap. The two PWA checks that ship run in **`x doctor`** ([`packages/cli/src/cmd-doctor.ts:129`](https://github.com/developerz-ai/ultimate/blob/main/packages/cli/src/cmd-doctor.ts)), and report `@ultimat3/pwa`'s own codes rather than CLI twins of them.

| Check | Where | Fails on | `As of 2026-08` |
|---|---|---|---|
| Source icon present | `x doctor` | the 1024×1024 source PNG is missing, so install icons and OG images cannot be generated (`X_PWA_ICON_MISSING`) | **shipped** |
| Offline fallback route present | `x doctor` | the fallback route file is missing, so an offline navigation lands on the browser error page (`X_PWA_NO_OFFLINE_FALLBACK`) | **shipped** |
| SW scope | `@ultimat3/pwa` | the service-worker scope cannot serve the routes it precaches (`X_SW_SCOPE_INVALID`) | **shipped** |
| SW checksum | — | nothing computes one; `X_SW_HAND_EDITED` is reserved | **not built** |
| Strategy coherence | — | an `offline` value contradicting the route's `render` is accepted; `X_SW_UNCACHEABLE` is reserved | **not built** |
| Precache budget | — | no step reads precache bytes | **not built** |
| Retention config | — | `retentionPlan(deploys, keep = 3)` is a call-site argument, not a validated config field | **not built** |
| Build ID present | `@ultimat3/pwa` | `generateServiceWorker` was handed an empty build id, so caches cannot be keyed and skew cannot be detected (`assertBuildId`) | **shipped** |
| Build ID *shape* | — | only emptiness is rejected. A timestamp or `latest` is accepted, and both defeat the immutable-namespace guarantee | **not built** |
| Offline fallback declared | `@ultimat3/pwa` | no `offline` block, or one with no `fallback` route — `generateServiceWorker` refuses with `X_PWA_NO_OFFLINE_FALLBACK` rather than building a worker that falls through to the browser error page | **shipped** |

`x test e2e` additionally asserts SW install, offline fallback rendering, and the version-skew reload path in a real browser. See [Testing](Testing).

## Rules

- Never hand-edit `sw.js`. Change the route, rebuild. **Convention, not a rule** — nothing checks it `As of 2026-08`.
- Never cache an authenticated response without an explicit `offline` field on the route.
- Never use a timestamp or `latest` as a build ID. **Convention, not a rule** — `assertBuildId` rejects only an empty one.
- Never force-reload a user without a grace period, except on a `--critical` deploy.
- Never cache a mutation. Offline writes are the tier-3 mutator queue's job.
- Never ship a PWA without an `offline.fallback` route — `generateServiceWorker` refuses (`X_PWA_NO_OFFLINE_FALLBACK`). A runtime refusal at build time, not a type error: `OfflineConfig` is passed as a `Partial`.
