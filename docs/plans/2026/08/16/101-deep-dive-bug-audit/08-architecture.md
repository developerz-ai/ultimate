# 08 — Architecture and design coherence

> Part of [`overview.md`](overview.md). Depends on: none, but land **after** the bug slices — several
> fixes here are deletions that would conflict with a patch to the same file. Tiers: 0–5.

Not crash bugs. These are structural: **a second path where the axioms allow one**, a seam that buys
nothing, or a declaration the framework never reads. Ordered by structural cost. Each names what to
**delete** — a finding that only adds is usually not this axis.

Eight findings (C1, C2, C3, H2, H3, H4, H8, H18) were reached independently by agents working on
disjoint package sets, which is the strongest signal available on a read-only axis.

## Critical

### C1 — `app.config.ts`, "the one config file", configures nothing

`packages/core/src/config.ts:253` (`defineConfig`) · only reader: `packages/cli/src/app-auth.ts:29`
(`config.auth.signInPath`) · the *actual* config path: `packages/cli/src/dev-services.ts:47` (env-var
presence) plus 28 `configureX()`/`setX()` process globals.

`defineConfig` validates `locales`, `defaultLocale`, `defaultTimeZone`, `defaultCurrency`, `theme`,
`pwa`, `roles`, `database`, `cache`, `jobs`, `realtime`, `ai` — then returns a frozen object nothing
reads. `resolveServices` picks the DB, event and storage driver purely from
`DATABASE_URL`/`NATS_URL`/`S3_ENDPOINT`. `config.roles` is validated ("roles must list at least one
runtime role") while the CLI uses a hardcoded `DEV_ROLES` (`packages/cli/src/dev-roles.ts:35`).
`JobsConfig.driver` has no reader at all — `packages/jobs/src/driver.ts:5` says so — yet **four
`fix:` lines** (`driver-redis.ts:27`, `driver-nats.ts:22`, `errors.ts:247`, `outbox.ts:268`) and
`packages/cache/src/redis.ts:138` instruct an operator to edit it.

Cost: two config mechanisms for one outcome, and the sanctioned one is inert. An SRE sets
`jobs: { concurrency: 8 }`, redeploys, and nothing changes; axiom 4 is violated at five `fix:` lines
that are provably no-ops. **The file contains the argument against itself** — `config.ts:43-57`
deleted `database.poolSize` for exactly this reason and pinned it in `type-pins.ts:82`; the identical
defect in the other 13 sections was left standing.

Fix: delete every section with no reader (keep `name`, `auth`), pin them in `type-pins.ts` beside
`DeadDatabaseField`, correct the five `fix:` lines to `setJobDriver(...)`. Wiring them is the
alternative — half-wired is what shipped.

### C2 — the request time zone has two ambient stores, and the one every UI component reads is never written

`packages/time/src/context.ts:13` (`CTX_TIMEZONE = 'timeZone'`), `:66` (`attachTimeZone`) · vs
`packages/core/src/context.ts:48` (`Ctx.tz`), written at `packages/http/src/stages.ts:181` ·
consumer: `packages/ui/src/theme/context.ts:70`.

`attachTimeZone`, `configureTime` and `attachLocale` have **zero callers repo-wide**.
`currentTimeZone()` reads `ctx['timeZone']`, which http never writes, so it always returns
`config.defaultZone` = `'UTC'`. `useUi()` falls back to `ambientUiContext()` on every server render
(`context.ts:104`, no Solid runtime), so **every server-rendered date in the UI kit is formatted in
UTC regardless of the request's resolved zone** — under a doc comment at `context.ts:55` asserting
the opposite ("the ambient answers `@ultimat3/time` keeps on the request context. No second ambient
store"). `packages/cli/src/dev-render.ts:64` compounds it: `const LANG = 'en'` is emitted as
`<html lang>` on every document while `ctx.locale` was negotiated one stage earlier.

Cost: the framework's loudest non-negotiable — "No date formatted without an explicit IANA
`timeZone`" — is satisfied in letter and wrong in fact for every signed-in user outside UTC,
silently.

Fix: one field, `ctx.tz`, which core already declares. **Delete `attachTimeZone`, `CTX_TIMEZONE`,
`timeZoneOf`, `timeConfig`, `configureTime` and `resolveTimeZone`** from `time/context.ts`;
`currentTimeZone()` reads `tryUseContext()?.tz`. Same for `attachLocale`/`localeOf`. Thread
`ctx.locale` into `LANG`.

### C3 — the read cache sits outside the one invalidation fan-out

`packages/query/src/read-cache.ts:96` (`setReadCache`), `:112` (`invalidateQueryTags`) · vs
`packages/action/src/cache-gate.ts` (`bustAfterCommit`, calls `invalidateTags` only) · and
`packages/cache/src/tiers.ts:152` (`createCacheStack`, **zero callers**).

`query` deliberately keeps its read tier outside `@ultimat3/cache`'s registry and closes the hole
with a private double-drop. But the only thing that busts after a write is `action`'s single
`invalidateTags` — and `action` (tier 3) can never import `query` (tier 3, sideways). The gap is
closed *by accident*: `packages/cli/src/dev-cache.ts:108` installs the Redis tier as both a
registered tier and the read tier. Line 143 — and every Compose deployment with no Redis — installs a
bare `MemoryReadCache` registered nowhere. Meanwhile `createCacheStack` (read-down/promote-up,
single-flight, negative TTL) is the package's whole design and is called by nothing; `registerTier`
feeds only `invalidateTags`, so three quarters of `CacheTier` is dead.

Cost: whether `action({ cache: { invalidates: [tag.post] } })` drops
`query({ cache: { tags: [tag.post] } })` depends on an env var, while `docs/idea/02-primitives.md`
and `packages/query/src/query.ts:26` state it unconditionally. Same defect the runtime half of
[`06-concurrency-lifecycle.md`](06-concurrency-lifecycle.md) reports — this is its structural cause.

Fix: make the read tier a registered `CacheTier`. **Delete
`setReadCache`/`getReadCache`/`invalidateQueryTags` and `MemoryReadCache`**; `readThrough` goes
through `createCacheStack(registeredTiers())`. One registry, one fan-out.

### C4 — `enforce: false` is a public one-word policy bypass on the read primitive

`packages/query/src/read.ts:181` (`SourceOptions.enforce`), exported at
`packages/query/src/index.ts:70,74`. Any app or package holding a query object can call
`(await sourceFor(q, input, { enforce: false })).execute()` and get rows with **no policy
evaluated** — while the package header (`index.ts:5`) claims "`sourceFor` is the only thing that
reads it — so no adapter can parse, authorize or execute on its own. One authz system,
structurally."

Cost: the primitive that owns reads ships the exact second door `docs/idea/02-primitives.md:67` names
as a rejected design, reachable from app code, with a name that does not say what it is.

Fix: **delete `enforce` from the exported `SourceOptions`**; make the unenforced build internal and
unexported, the pattern `defOf`/`stashDef` already uses. `ToLiveOptions.enforce` stays — realtime
genuinely needs it and its doc block earns it. (The security sweep rates the same line Medium from
the exploitability angle; the structural cost is what makes it Critical here.)

### C5 — the production application server *is* the developer CLI

`examples/dummy/apps/web/server.ts:6` (`import { runRole } from '@ultimat3/cli'`) ·
`packages/cli/src/serve.ts:29-37` (imports `dev-queue`, `dev-render`, `dev-assets`, `dev-storage`,
`dev-runtime`, `dev-roles`, `dev-services`) · `docker/Dockerfile:53` (`CMD ["dev", "--once"]`).

A deployed app's `server.ts` is a 3-line launcher over `@ultimat3/cli`, whose `exports` is a single
barrel re-exporting the scaffolder (`newCommand`/`planNewApp`/`writeNewApp`), the gate
(`runVerify`/`VERIFY_STEPS`) and `runRole`. `@ultimat3/cli`'s runtime `dependencies` include all 23
framework packages **including `@ultimat3/testing`** — the test harness, with `sealed-network` in it.
The container's default command is literally `dev`.

Cost: an agent asking "what runs in production" must read files named `dev-*` inside a package named
`cli`, and cannot tell from any name which half is which. The production image's dependency and
attack surface includes the scaffolder templates, the doc corpus, the verifier and the test harness.
This is also why [`11-deploy-ci.md`](11-deploy-ci.md)'s image findings are as tangled as they are.

Fix: extract the runtime (`serve.ts`, `dev-roles`, `dev-runtime`, `dev-queue`, `dev-render`,
`dev-services`, `dev-assets`, `dev-storage`, `api-routes`, `app-load`) into **`@ultimat3/server` at
tier 5**, with a `./server` export the app entry imports; `@ultimat3/cli` depends on it, not the
reverse. Note this also relocates `pgExecutorFor` (`dev-queue.ts:74`) — today the only adapter
bridging `DbClient` to `PgExecutor` for both `jobs` and `action`'s idempotency store, currently
living at tier 5 and masked only because the CLI *is* the runtime.

### C6 — `@ultimat3/admin` builds a second route table the router never receives

`packages/admin/src/admin.ts:184` (`AdminRoute[]`) · vs `packages/render/src/registry.ts:217`
(`registerRoute`) · demo: `dummy/social-media-clone/apps/admin/app/admin/ops/page.tsx:36`.

`defineAdmin()` normalises each admin page through `defineRoute()` and composes the policy the author
must not forget — then **nothing calls `registerRoute` with them**. `app.routes` is absent from
`routeEntries()`, `describeRoutes()`, `x routes`, `x.manifest.json`, the sitemap and `sw.js`. The
deployed demo proves the cost: `ops/page.tsx` fishes one route back out by path, while `users/`,
`jobs/`, `posts/`, `media/` hand-write `defineRoute` with a typed-in
`policy: { permission: 'admin:read' }`. `admin.ts:167` declares `/admin/jobs` as
`permissionsForOperation('job','list')`; the file actually serving `/admin/jobs` declares
`admin:read`. **One URL, two route declarations, two permission answers — and the gate reads the one
nobody serves.**

Fix: mount admin routes through `registerRoute` (which already accepts an explicit `input.path` at
`registry.ts:211`). **Delete `AdminRouteConfig` as a hand-off shape.**

### C7 — `AppToolDefinition` is a ninth primitive in an MCP costume

`packages/mcp/src/app-tool.ts:30`. `defineAppMcp({ tools: { seatReport: { description, input,
policy, handle } } })` declares a named, server-authoritative operation with an input schema, a policy
and a handler — the definition of an `action` — through a parallel declaration `action()` never sees.
`app-tools.ts:59` admits it: *"Hand-written tools for things no primitive covers. Rare — prefer an
action."*

Cost: axiom 2 is false for exactly the surface agents use. Such a tool has no `.openapi()`, no
`.client()`, no `.job()`, no `.contract()`, no manifest row, no `rateLimit`, no `deprecated`, no
output schema, and cannot be reached by HTTP, a job or a typed test client; `contract-diff` cannot
see it. Its authz is weaker too — `app-tool.ts:99` calls `guard(policy, …)` where
`projectable.ts:50` calls `invoke(target, …)`, skipping rate-limit metering, audit and span naming.

Fix: **delete `app-tool.ts` and the record form of `DefineAppMcpInput.tools`.** A hand-written tool
becomes `action({ input, output: t.unknown, policy, mcp: { expose: true }, handle })`. Keep the
`readonly AnyMcpTool[]` array form — `@ultimat3/admin` builds its catalog programmatically.

### C8 — one realtime entry point serves the browser client and the walsender

`packages/realtime/package.json:16` — `exports` is `{ ".": "./src/index.ts" }`, and `src/index.ts:206,227,318`
statically re-export `openNatsClient`, `bunPgStream` and `syncListen` from the same module a component
reaches for `useLive`/`LiveClient`. No package declares `"sideEffects": false`.

Cost: axiom 6 (static path never pays for the app path) is defeated at the package boundary after
being honoured file-by-file — `query-hook.ts:12` and `hooks.ts` deliberately name `@ultimat3/query`'s
shape *structurally* "because a value import would pull the server's read path into the bundle", and
then the barrel re-exports the Postgres wire client anyway.

Fix: split the entry — `"."` (server) and `"./client"` (`client.ts`, `hooks.ts`, `live-rows.ts`,
`local-store.ts`, `offline-queue.ts`, `rebase.ts`, `apply-patches.ts`, `sync-protocol.ts`, `json.ts`,
`cursor.ts`). The pattern already exists: `admin/./dev`, `testing/./preload`, `ui/./icons/*`.

## High

### H1 — the canonical dependency graph contains ~13 edges that do not exist

`docs/architecture/01-package-map.md:99-155`, verified against real source imports:

| Doc claims | Reality |
|---|---|
| `http → i18n`, `http → time` | http imports **core, schema only** — and re-implements `negotiateLocale`, `isValidTimeZone`, `resolveTimeZone` in `packages/http/src/locale.ts:80,110,119` |
| `policy → i18n`, `cache → time`, `seo → i18n` | each imports **core only** |
| `render → query` | render imports cache, core, i18n, seo |
| `ui → render` | ui imports core, i18n, money, time |
| `ai → jobs` | ai imports action, cache, core, db, money, policy, schema, time |
| `action → entity`, `query → entity` | neither imports entity |
| `realtime → policy`, `realtime → http` | realtime imports core, query |
| `testing → action`, `testing → realtime` | testing imports cache, core, db, entity, jobs, mail, time |

The table's own stated placement rule — "placed at the lowest tier their real imports allow"
(`scripts/lib/tiers.ts:6`) — is **false for three packages**: `http` (tier 2, imports tier 0 only),
`policy` (tier 2, core only), `pwa` (tier 4, core only). `scripts/boundaries.ts` checks only the
ceiling; nothing checks the floor.

Cost: the one artifact an agent consults for "what may import what" is 25% fiction, and half the
phantom edges name the exact place the framework duplicated instead of importing.

Fix: generate the mermaid graph from the real import scan in `scripts/boundaries.ts` and diff it in
`x verify`'s `manifest` step, the way `tier-table-drift.test.ts` pins the tier table. Add a floor
check.

### H2 — http re-implements two tier-1 packages it is allowed to import

`packages/http/src/locale.ts:80,110,119`:

| Concern | http | owner | divergence |
|---|---|---|---|
| `Accept-Language` | `locale.ts:63,80` | `i18n/locales.ts:121,146` | i18n handles `zh-hant`, `_` normalisation, clamps `q` to [0,1]; http does none |
| supported set | `DEFAULT_LOCALE_CONFIG` = `['en']` | `SUPPORTED_LOCALES` (30) + `configureLocales()` | **two config mechanisms** — an app calling `defineCatalogs({ locales: ['en','fr'] })` gets `ctx.locale === 'en'` forever |
| explicit-choice cookie | `'x-locale'` | `LOCALE_COOKIE = 'x_locale'` | **different names** — a switcher written against the documented constant is never read |
| zone validity | `isValidTimeZone` (`:110`) | `time/zones.ts:38` | time rejects `''` and `+01:00` ("a fixed offset has no DST rules"); http accepts both, so `x-timezone: +01:00` becomes `ctx.tz` and throws deeper in |

Refused only by `packages/http/CLAUDE.md`'s self-imposed "May import: core, schema. Nothing else,
ever" — which states no reason and is stricter than the tier table. With `AppConfig.locales` that is
**three** declarations of the supported set.

Fix: **delete http's `negotiateLocale`, `isValidTimeZone` and `resolveTimeZone`**; the locale stage
calls the owners. `LocaleConfig`/`TimeZoneConfig` shrink to header/cookie *names*. Amend http's
CLAUDE.md. Lands with C2 — same subsystem, same request stage.

### H3 — five copies of FNV-1a, five canonical-JSON serializers, four `tagKeys`, three `contentHash`

| Duplicate | Sites |
|---|---|
| `fnv1a` | `action/src/stable.ts:56` (hex), `query/src/stable.ts:39` (hex), `realtime/src/json.ts:62` (hex), `flags/src/bucket.ts:17` (number), `ai/src/embeddings.ts:82` (number) |
| canonical JSON | `action/src/stable.ts:14`, `query/src/stable.ts:11`, `realtime/src/json.ts:53`, `manifest/src/build.ts:104`, `ai/src/prompt.ts:160` |
| `tagKeys` | `action/src/tags.ts:15`, `query/src/tags.ts:15`, `render/src/route.ts:203`, over `cache/src/tags.ts:53`'s existing `serializeTags` |
| `contentHash` | `render/src/render-static.ts:29` (FNV hex), `manifest/src/build.ts:97` (sha256/16), `ai/src/prompt.ts:142` (sha256) |

`action/src/stable.ts:4` claims "this is the only serializer either path is allowed to use" —
falsified by the byte-identical file in `query`. **`realtime` reimplements `query`'s two functions
despite `realtime → query` being a declared sideways edge existing precisely so realtime can reuse
query.** The copies already diverge: action's and query's `tagKeys` sort + dedupe ("descriptor output
must not depend on declaration order"); render's does neither — and render's output lands in
`RouteFact.revalidateTags`, which `buildId` is a content hash of, so `build.ts:5`'s stated first
invariant ("two builds of the same tree must produce identical bytes") is **false for that field**.
`ai/src/llm.ts:34` already leaked: it imports the `number` `fnv1a` and writes
`fnv1a(rendered).toString(16)` — variable-width hex for a hash every other caller zero-pads to 8.

Cost: these are *identity* functions producing durable keys — idempotency fingerprints, query hashes
(and therefore cursor scope), fanout subjects, prompt hashes, rollout buckets, the OpenAPI byte diff.
"What is the framework's stable id of a value" has five answers and nothing stops a sixth. Note
[`02-tier23-bugs.md`](02-tier23-bugs.md) separately reports the 32-bit width as a collision risk —
fix the width **once**, here.

Fix: one `fnv1a` (+ `fnv1aHex`) and one `stableStringify`/`fingerprint` in `@ultimat3/core`. Move
sort+dedupe into `cache`'s `serializeTags`. **Delete both `stable.ts` files, `realtime/json.ts`'s
pair, `ai/prompt.ts`'s `stableJson`, and all three `tagKeys`.**

### H4 — `packages/seo`'s entire gate half has never run, and `RouteBudget` exists four times

`seo/src/budgets.ts:81,116`, `seo/src/routes.ts:26` (`RouteRecord` — **no producer anywhere**),
`sitemap.ts:60`, `robots.ts`, `validate.ts:47` — all zero callers. Only `renderMeta` is wired. The
live checker is `packages/cli/src/budgets.ts:47`; `packages/render/src/islands.ts:171` is also dead.

`RouteBudget` is declared four times, mutually incompatible: `seo/routes.ts:14`
(`js: string|number`, `inp`), `render/route.ts:50` (`js: string`, `tbt`, no `inp`),
`manifest/schema.ts:33` (`{ js?, lcp? }` — only 2 of 6 metrics survive into the manifest),
`cli/budgets.ts:17` (`RouteStats`). Byte parsing exists twice with different failure modes, and
`X_SEO_BUDGET_EXCEEDED` is a second code for one condition, thrown by a function nobody calls.

Cost: an author writing `budget: { cls: 0.1 }` gets a type error; `tbt: 300` gets a budget no checker
reads; `inp` cannot be expressed in render at all. `packages/seo/CLAUDE.md` opens with "**Enforced,
not documented.** … `x verify` fails CI on it" — no step of the 17 runs any of it. Pairs with
[`03-tier45-bugs.md`](03-tier45-bugs.md)'s unclosable `X_BUDGET_UNMEASURED`: fix them together or the
budget story stays incoherent.

Fix: **delete `seo/budgets.ts`, seo's `RouteBudget`/`RouteRecord` and `X_SEO_BUDGET_EXCEEDED`; delete
render's `checkBudget`/`checkBudgets`/`assertBudget`.** Render keeps the vocabulary, cli keeps the
gate, `manifest.RouteFact.budget` widens to every metric render can declare.

### H5–H20, condensed

| # | Site | Structural defect | Delete |
|---|---|---|---|
| H5 | `packages/pwa` (3,407 LOC, tier 4) | on no execution path — only `planIcons` is wired; no CLI file emits `sw.js` or `webmanifest`, and the scaffold emits an `/offline` page no SW can serve. Meanwhile `render/route.ts:151` makes `offline` **required by the type** | wire it (the CLI already owns `dev-render` + `prerender`), or delete `offline` from `RouteDefinition` |
| H6 | `packages/mail/src/mail.ts:65` | `defineMail` is a ninth primitive (id, input schema, registry, server-authoritative invocation) absent from `PRIMITIVE_KINDS`, with no `MailFact`; and `:158` hand-assembles an enqueue from `sendMailJob`'s *fields* rather than calling `.enqueue()`, bypassing the facade and actor attribution | the private registry; make `defineMail` return a `JobHandle` as `backfill()` does |
| H7 | `packages/schema/src/errors.ts:60` | `SchemaError` is a second implementor of the error contract that omits `retry` and `sourceError` and hands `meta` past `renderMetaRecord`. Root cause: **`core → schema` is not in `SIDEWAYS_ALLOW`** though schema imports nothing at all — the framework pays five duplications for it (`describeValue`, `humanize`, `SCHEMA_ERROR_CODES`, `isTimeZone`/`isLocale`, the error class), kept in step by pin tests living in tier-5 `cli` | add `core: ['schema']`, then delete `core/error-render.ts:213-249`, `core/schema-error-codes.ts`, `core/config.ts:157-172`, `SchemaError`, `cli/schema-error-codes-pin.test.ts` |
| H8 | `packages/auth/src/guards.ts:23,33` | `requireRole`/`requireScope` decide a 403 outside `@ultimat3/policy` — zero callers repo-wide. A route guarded this way reports `policy: null` in `x routes`, the manifest and `openapi.json`, and `x policy list` reports its permission unenforced: **a route can ship guarded while reporting unguarded** | `requireRole`, `requireScope`. Keep `requireActor`/`currentActor` — those assert authentication |
| H9 | `packages/realtime/src/channel.ts:70,100` | `hub.guard(pattern, closure)` is a second authz vocabulary (no `Policy`, no `enforce()`, no `KnownPermission`, invisible to `x policy list`) in the package whose CLAUDE.md forbids one; and `onActorChange`'s bare `catch` permanently revokes a channel when a guard times out — the denial-vs-failure conflation `live-query.ts:265-281` explains at length | branch on `isPolicyDenial`; make a topic rule a declared `Policy` |
| H10 | `packages/entity/src/query.ts:322` vs `repo.ts:78` | two sanctioned write paths: `Table.update` runs `touch()` and `$parse`, `Repo.update` does neither — so `repo.update` writes a **stale `updatedAt`**. The deployed demo uses the escape hatch (`dummy/social-media-clone/apps/admin/app/admin/repo.ts:92`) and, because `cursorFor` is unexported, hand-rolls a **third** keyset pagination reintroducing the tie-boundary problem `cursor.ts` exists to solve | the app-side `seekOf`/`dropThroughTie`; make `Table` the only public row API |
| H11 | `packages/db/src/pglite.ts:145` | the driver every author develops against classifies **no SQLSTATE** — every embedded failure is `X_DB_UNAVAILABLE` ("set DATABASE_URL to a reachable Postgres url"). An app branching on `X_DB_UNIQUE_VIOLATION` passes in production and 500s in dev | the `dbUnavailable` call site; call `driverError(...)` |
| H12 | `db/src/readonly.ts:50,72`, `admin/src/dev/panel-db.ts:52`, `mcp/src/readonly-sql.ts:134` | three "is this SQL a write?" lexers (22 / 11 / 39 keywords, disagreeing materially); the one in the package that owns the SQL lexer has **zero callers** but is the one on the public API. `noiseAt` is not exported, so both consumers wrote their own | `packages/db/src/readonly.ts` entirely; export `noiseAt` |
| H13 | `auth/src/rate-limit.ts` vs `http/src/rate-limit.ts` | two complete rate-limiting subsystems at one tier — identical `forgetAtMs`, identical `SWEEP_EVERY_MS`, identical `maxKeys × 0.9` eviction, different vocabularies; `auth/rate-limit.ts:99` names a **third** | auth's store, sweep and scope assert → core (precedent: `timing-safe-equal.ts`) |
| H14 | `packages/action/src/mutator.ts:66,126` | a factory that stopped halfway: `MutatorDef` cannot express `row`, `rateLimit` or `deprecated`. **A mutator can never declare a `row:` loader, so a row-level policy on one always receives `row: null`** — which `02-primitives.md:136` requires be read as a denial. `likePost`, the doc's own example, cannot be guarded by an ownership rule | nothing — widen `MutatorDef` and forward |
| H15 | `packages/ai/src/provider.ts` (465 LOC) | the file named for the seam is also one vendor, one double, the pricing arithmetic and the token estimator; `openai-provider.ts:27` imports five helpers from the *Anthropic* module, and `STREAM_ONLY_MAX_TOKENS` (Anthropic's cloud HTTP timeout) gates **every** provider — a local Ollama is forced onto streaming by a number describing a socket to `api.anthropic.com` | split into `provider.ts`/`pricing.ts`/`anthropic-provider.ts`/`echo-provider.ts` |
| H16 | `packages/admin/src/dev/data.ts:147-165` | the `/_x` routes panel reads render's *typed* `RouteDescriptor` as an untyped bag and gets four fields permanently wrong (every route renders as `'stream'`, budgets `{}`, tags `[]`, `hasMeta: false`). The header defends this, which is how five blank cells shipped unnoticed — the packages ship in lockstep at one version | `bagOf`/`str`/`numOf`/`strings` for every framework-package source; `import type { RouteDescriptor }` |
| H17 | `render/src/registry.ts:171,339` vs `http/src/router.ts:249` | two URL-precedence algorithms: http's per-segment trie vs render's **summed** specificity, which is position-insensitive by construction, so `/a/:b/c` and `/a/b/:c` tie. Client navigation uses render's rule and a full page load uses http's — **clicking a link and reloading it can land on different pages** | `matchRoute`/`RouteMatch` from render's public surface; give `compilePattern` the trie's comparator |
| H18 | `packages/db/src/generate.ts:19,39,50` | the entity-description vocabulary is declared three times across two packages, and `ColumnDescription`/`IndexDescription` are **two public types with one name each**, structurally incompatible (db's catalog shape vs entity's). Adding an entity column field means editing three declarations, and a forgotten one is silently dropped from generated DDL with no type error | rename db's to `CatalogColumn`/`CatalogIndex`; pin the mirrors with `extends` in `type-pins.ts` |
| H19 | `packages/core/src/error-retry.ts:68` | one fact about one code declared through two calls, with **1-in-30 adoption**: 30 packages call `registerErrorCodes`, exactly one calls `registerErrorRetry`. Every `X_*` in `time`, `money`, `i18n`, `flags`, `db`, `cache`, `auth`, `jobs`, `storage`, `realtime` is `terminal` by default — including `X_OAUTH_EXCHANGE_FAILED`, the function's own worked example of a retryable code | `registerErrorRetry`, `registeredErrorRetry`, `resetErrorRetry`; widen `ErrorCodeDeclaration` with `retry?` |
| H20 | `packages/core/src/image/` (2,296 LOC), `runtime-metrics.ts:26` | a JPEG/PNG codec is 23% of tier-0 core's source, and HTTP/WebSocket/job metric vocabulary sits at tier 0 with parameter types that are tier-2/3 domain models. A bug in `jpeg-huffman.ts` is a core version bump shipped in lockstep to all 29 | extract `@ultimat3/image` at tier 0; move each instrument to the package owning its call site |

## Medium

Condensed — each is a second path, a dead declaration, or a seam two implementations read differently.

- `render/src/registry.ts:99` + `modes.ts:167` — the `api/` surface has full route machinery and every
  registration on it throws unconditionally; an agent reading the documented `api/posts/route.ts →
  /api/posts` row writes the file and is told the primitive is wrong.
- `jobs/src/worker.ts:96` + `limits.ts:26` — two in-process per-queue caps; `concurrency: 10,
  perQueue: 2` claims 10 rows, runs 2, nacks 8 with `error: 'limited: per-queue'`. **Delete
  `LimitConfig.perQueue`.**
- `http/src/hooks.ts:57` vs `pipeline.ts:146` — `configureAuthenticator()` is documented as "one
  declaration site" and `createPipeline` never consults it; it works only because
  `cli/dev-hooks.ts:47` reads it back. An app following the docs gets `anonymousActor()` on every
  request, silently.
- `entity/src/repo.ts:138,474` + `pg-driver.ts:396` — `Transactor`/`memoryTransactor`/
  `postgresTransactor` are public and constructed by nothing; `Tx.onRollback(undo)` is meaningless to
  a database, so two implementations mean different things behind one interface.
- `policy/src/define.ts:59` — `definePolicy()` is a second declaration form for `can()` with zero
  callers; its one real capability (a translatable `deny:` key) is available only through the form
  nothing uses. **Delete; fold `deny` into `can()`.**
- `storage/src/driver-local.ts:204` vs `driver-s3.ts:184,332` — `metadata`/`cacheControl` round-trip
  in dev and throw `X_NOT_IMPLEMENTED` in production; `SignedUrlOptions.maxBytes` is HMAC-signed and
  re-checked on `local`, silently dropped on `s3`, while `grant.ts:86` returns it in `UploadGrant`.
  **An upload size limit enforced in dev and advisory in production.**
- `cache/src/cdn.ts:85,90` + `memo.ts:58` — `CacheTier` is a four-method contract two of its four
  implementations cannot honour. Split into `CacheTier` and `PurgeTarget`.
- `cache/src/semantic.ts:26,108,123` — a second tagged cache outside the one fan-out, built per scope
  by `@ultimat3/ai`; a tag drop clears every other tier and leaves a stale model answer.
- `ai/src/gateway.ts:39` + `llm.ts:462` — two response caches on one path; the gateway hit does
  `JSON.parse(cached) as GenerateResult` (unchecked) where the semantic path deliberately
  re-validates, and then reports the original cost on a call that spent nothing.
- `ai/src/tools.ts:59` vs `mcp/src/from-action.ts:48` — the restated projection contract has already
  diverged (`mcp.name`, `mcp.visibleTo`); and **`McpExposure.name` is settable by no declaration** —
  the rename is dead for every real primitive.
- `manifest/src/diff.ts:34` — "a new manifest field ⇒ a `diff.ts` rule" is prose with no build error,
  already violated: `tasks`, `policies`, `errorCodes`, `app.version` are never compared, and
  `diffRoutes` compares only `render`. A deleted cron task and a removed error code pass the contract
  gate silently.
- `render/src/route.ts:24` restated in `pwa/strategies.ts:22`, `manifest/schema.ts:28`,
  `http/router.ts:32` — `RenderMode` ×4, `OfflineStrategy` ×3, `HydrateStrategy` ×2, with
  `RENDER_MODES` only in render and no drift test.
- `render/src/head.ts:141` vs `ui/src/theme/inline-script.ts:13` — two anti-flash theme scripts, two
  storage keys (`x-theme` vs `ultimate.theme`), zero callers for either; a toggle works until the
  first reload.
- `render/src/render-isr.ts:300` — a third pattern compiler whose `table.find(...)` inverts
  `compilePattern`'s precedence, so a regenerated ISR page can take its TTL from a different route
  than the one that rendered it.
- `jobs/src/outbox.ts:215` — `mode: 'required'` exists to make a non-transactional enqueue
  impossible, and `EnqueueOptions.outbox: false` is a per-call-site opt-out of it, invisible to
  `x verify`.
- `policy/src/permissions.ts:47` — `isKnownPermission` is fail-open **and** called at module
  evaluation time, so whether `can('post:pubish')` is caught depends on import order.
- `mail/src/layout.ts:24` — twelve raw hexes in the one package `ui/tokens/tokens.ts:210` names as
  its reason to exist; `@ultimat3/pwa` faces the identical tier constraint and solves it with
  `PwaConfig.tokens: ThemeTokens`.
- `storage/src/image.ts:14` vs `core/src/image/probe.ts:11` — two public `IMAGE_FORMATS` with
  different members, and two default srcset width lists; storage's image half is dead *and* broken by
  default (`format ?? 'webp'`, which core cannot encode).
- `action/src/openapi.ts:38` — `openapi.json` describes actions only, while every registered `query`
  mounts a real `GET /_x/query/<kebab>` in no document with no `.contract()` counterpart. The artifact
  `x verify` byte-diffs covers half the HTTP surface — and omits the read side, the one that leaks
  rows.
- Also: `http/src/rate-limit.ts` (334 LOC, seven responsibilities, owning HTTP config resolution the
  docs assign to `defineHttpConfig`); `manifest`'s doc-scanner half (488 LOC, one consumer, shares no
  type with the fact model → move to `cli`); `admin/src/theme.ts:7` (`--x-${string}` names a namespace
  ui does not define); `admin/src/dev/server.ts:123` (imports the 265-line ui barrel to read 24 colour
  strings); `auth/src/oauth-route.ts:31` + `mcp/src/transport-http.ts:56` (a third and fourth route
  vocabulary); `money/src/errors.ts` (five distinct failures under `X_MONEY_NOT_INTEGER`);
  `core/src/context.ts:82` (`BUILD_ID` read as a bare literal in two core files while
  `app-version.ts` argues at length that this exact thing needs one owner); `schema/src/provider.ts:9`
  (a swap point with one implementation and no prospect of a second, with two files each claiming to
  be *the* swap point).

## Low

Five unsanctioned value renderers (four inside core itself — `assert.ts:18`, `telemetry.ts:217`,
`error-reporter.ts:203`, `image/png.ts:129` — plus `flags/errors.ts:114`), which
`scripts/error-render.ts` cannot see because it only inspects parameters typed `unknown`; **five HTML
escapers** where `render/CLAUDE.md` says "a second escaper is how one of them ends up missing a
character"; **three cookie parsers**, each citing the other two in a comment; `core/src/cursor.ts:110`
duplicating `core/src/timing-safe-equal.ts:11` byte-for-byte in the same directory; two declaration
spellings for the eight primitives (`entity()` vs `definePolicy()`); `policy/src/roles.ts:23`'s
`Actor` meaning two things depending on the importing package, mirrored a third time in
`auth/policy-bridge.ts:12` "by hand" with no pin test; `jobs/src/clock.ts:18` duplicating
`time/src/duration.ts:64` in a file that already imports from it; dead public surface
(`auth/src/session.ts:62` `CookieJar`, `policy/src/policy.ts:154` `policyPermissions`,
`core/src/assert.ts:24` `assert`, `flags/src/projection.ts`, `i18n/src/catalog.ts:107`); four
spellings of one schema operation (`t.enum`/`t.enumerated`, and `nullable`/`optional`/`refine` each
three ways) with the blessing living only in a doc comment; `core/src/logger.ts:112` reading
`LOG_LEVEL` at module scope before `installSecrets()` runs, for a variable in no env schema;
`pwa/src/strategies.ts:77` vs `:180` (each strategy exists twice, as a function and as a source
string, with the test asserting similarity rather than equivalence); `entity/src/repo.ts:1` (header
says "the repository seam", `:142-486` is the entire in-memory driver); stale references in
`http/src/hooks.ts:1`, `mail/src/templates/index.ts:2`, `ai/src/provider.ts:1`.

**`docs/idea/18-build-vs-wrap.md`** records verdicts for jobs, SMTP and NATS but none for the largest
BUILD in the tree: realtime's hand-rolled Postgres v3 wire client (`pg-bytes`, `pg-wire`, `pg-auth`
with SCRAM-SHA-256, `pg-connection`, `pg-socket`, `pgoutput` — ~1,300 production LOC) beside
`@ultimat3/db`'s `Bun.SQL`. The BUILD case is real (CopyBoth), which is why it deserves the recorded
hardening obligation the doc says a verdict creates.

## Verified sound — do not "fix"

`llm()` and `backfill()` really are factories over their primitives (both call `action()`/`job()` and
inherit every projection); `mutator` is deliberately an action; `island()` is a factory over the
route's own `hydrate`; **`db` at tier 1 owning `DbClient` while `entity` holds `postgresDriver()`** —
the two seams are genuinely different and exiling the driver would split `Driver` from its only
implementation; raw SQL beside the entity repo (a layer boundary with documented audit points); the
memory/postgres driver pairs (semantics live outside both, `*-parity.test.ts` enforces it);
`nats-fake.ts` (implements *server* semantics so multi-node fanout is provable under
`sealed-network`); the `Provider` seam (`openai-messages.ts` maps all three structural disagreements
in 175 pure lines); **`realtime → query`, `admin → ui` and `create-ultimate → cli` all earn their
declared lines**; realtime as one package (three features over one 10-frame protocol); `packages/ui`
(1,851 files is 1,767 generated glyph modules behind a deep `exports` entry; zero raw hex in any
component or stylesheet); `pwa` as a package; `manifest`'s build/diff/emit half; six 435–468-LOC
`errors.ts` files (each is one job, mostly the multi-line `fix:` prose the contract demands);
`enforcedBy: 'handler'`; `configureAuthenticator` being process-global (the *defect* is that the
pipeline does not read it); `coalesce`/`jit-preload`/`preload` sharing `batch-read.ts`;
`scripts/verify.ts` (contributes `HostCheck`s, cannot add/remove/reorder/skip a step);
`cmd-planned.ts`; jobs' structural `PgExecutor`; mcp's two `JsonSchema` types.

## Sequencing

C1, C2/H2, C3, C4, C7 and H8 are **deletions of dead or duplicate surface** — cheap, low-risk, and
each removes a place a future bug can hide. Do them first. C5, C8, H3, H20 are **extractions** that
move code across package boundaries; each needs its own PR and its own `boundaries` run. C6, H4, H5
are **wire-it-or-delete-it** decisions that need a stated call before any code moves.

## Done when

- Every Critical resolved by deletion or by wiring, with the choice recorded in the owning package's
  `CLAUDE.md`.
- `docs/architecture/01-package-map.md`'s graph is generated from the real import scan and drift-gated.
- One `fnv1a`, one `stableStringify`, one `tagKeys`, one HTML escaper, one cookie parser, one
  read-only SQL lexer.
- `bun run boundaries` green with the new edges declared, and `bun run verify` green.
