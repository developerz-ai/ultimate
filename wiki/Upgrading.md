# Upgrading

**`As of 2026-08`. Semver applies from here.** A breaking change to a documented API needs a major. Every `@ultimat3/*` version is pinned exactly and moves in lockstep — never mix versions.

**Twenty-three majors have shipped, and this page walks all twenty-three** — 2.0.0's 33 entries joined it `As of 2026-08`, and `scripts/changelog-check.ts` now refuses a summary row whose section the page does not carry, which is how they were missing for six releases. [`CHANGELOG.md`](https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md) is the source for the majors it still carries, and `git show v<tag>:CHANGELOG.md` for the ones it has archived; none ships a codemod, so every entry is a manual edit the entry itself names. **One section per major**, newest first — read the ones between your pin and your target, oldest first.

| From → to | Breaking entries | Read |
|---|---|---|
| 24.x → 25.0.0 | **31** so far, and **unreleased** — Bun 1.4.2 as the floor; seven deleted `app.config.ts` keys refused by name, the locales in `defineCatalogs()`; `assertEnvExample`, `resolveSpeculation` and `normalizeAuditRecord` removed, `AuditRecord.name` / `.primitive` required, the deprecation helpers from core only; one `memoryX` / `postgresX` spelling per factory; `entity`'s `Page` and `http.drainTimeoutMs` removed, a `bearerMount` catch-all; one MCP projection (`toolFrom`), one page shape (`nextCursor`, `hasMore`), a per-action rate limit that is the action's own, a redaction-keeping `IdempotencyStore`, `SQL_*` statements off the barrels, the NATS job driver stub deleted, required `WebhookLedger.isDisabled` and `ChangeEvent.write`; `McpExposure.name` and `contentHash` removed, a scopes map that names every tool, a required `DigestAppend.appender`; **no model chosen for an app — it registers its own and names one**; a widened `Menu` `aria-controls`, a private `FakeElement.listeners`, offline scrapes that state their robots reason, `nearest` removed, a `--cdp-url` capture that fails closed, a page that may not import a repo, and ai's `contentHash` renamed `promptHash` | the `24.x → 25.0.0` section below. Its entries sit under `[Unreleased]` in `CHANGELOG.md` until the tag |
| 23.x → 24.0.0 | **202** — a calendar check on `t.date`, `t.url` refusing what the parser would cut, plain objects only, a default its own schema must accept, decimal-only coercion, a stricter `defineConfig`, an unknown `LOG_LEVEL` refused, `retry` and `createFlightGate` refusing a bound that is not one, a child context that aborts with its parent, compound credential names redacted, error `meta` under `extra.meta` in the monitor envelope, per-signal OTLP headers, a sampler that ignores a leftover ratio, wildcard host rules that stop at the network edge, an empty cursor secret counted as unset; then tier 1 — `t()` always interpolating, interval crons through both passes of a fall-back hour, exact cron names, `formatRelative` requiring a zone, a transaction that rejects when its body swallowed a failed statement, `X_DB_COMMIT_UNKNOWN`, nested transaction options refused, sibling nested scopes run in turn under a 30 s wait, a `changed-primary-key` drift kind, `introspect()` reporting catalog types, flag expiries that must be ISO; then an `e:<entity>` purge key on every tagged response, WebP-only `responsiveImage()` by default, `promoteAttachment` requiring its policy, a required `StorageDriver.stat()`, an optional `lastModified`, a `get()` ceiling, image variant keys that keep the source extension, `v2` signed URLs that name their disk; then a required `Driver.transactor()`, `dbDrift` leaving entity, a preload ceiling, `assertAllowed` throwing the decision's own code, a 401 for a denial with no actor, a malformed policy decision that denies; then `ctx.peer` behind its own switch, anonymous browser writes held to same-origin, failed sign-ins metered to a 429, health bodies trimmed for strangers, a `max-age` treated as a shared-cache offer, a body refused without a `content-type`, an awaited browser `close()`; then auth — **a sealed MFA secret that needs `x auth seal-mfa` run once**, a retired `x_auth_failures` table, a reservation-shaped `AuthLimiter`, API keys bound to their owner and its grants, `X_MFA_REQUIRED` carrying a challenge, eight more required `AuthAdapter` members, `oauthLogin` requiring `APP_URL`, an e2e `offline()` that rejects when a page refuses the switch; then `compareValues` removed from query, a `.limit()` that bounds every page, a `single` read answering one row over MCP, `admin:*` declared by `defineAdmin()` rather than by import; then `mutator()` requiring `idempotent: true`, a regenerated `openapi.json` and schema dump, idempotent actions and cache busts that settle with the commit, a `manifest` step that fails on a stale `openapi.json`; then jobs — a final-attempt lapse buried instead of re-claimed, `cancel` refusing finished jobs, step writes fenced on the claim, a uuid-only `runId`, an awaited `purgeExpired()`, `x_job_events` swept; then realtime — **three operator steps: `APP_URL` on the `sync` role as the whole origin allow-list, `REPLICA IDENTITY FULL` for channels with params, and a replication connection that refuses a weak password without TLS** — rows revived across the bus, five interfaces with new required members, stricter channel re-authorization, and an offline queue abandoned when the principal changes; then a catch-all route that answers its bare prefix, a zero-length ISR `ttl` refused, `NativeReason` gaining `'unparsable'`, CSS-module classes scoped in selectors only with every scoped name changed once, a positional `CompiledPattern.specificity`, and a notification tap that opens this app only; then ui — two required `ThemeEnv` members, a fixed `theme.defaultMode` that a "System" pick and an OS change no longer override, the deprecated theme inline script removed, a `Popover` trigger whose `aria-controls` can be absent, and file controls that post only the files they accepted; then a required `peek` on every rate-limit store and an address refused on required routes once its failed credentials are spent; then mcp — a 5xx cause hidden from a remote caller, `db.query` refusing SQL run as text, a meta tool without `destructive` listed as a query, list calls held to their whitelist, failed tokens metered per address; then a `send()` that waits for its transaction's commit and one recipient rule on every mail driver; then `x_notify_digests` in the schema dump, queries publishing `input`, a non-finite manifest fact refused, and a dropped NOT NULL default classed as breaking; then ai — an atomic `BudgetStore.take`, a required `Gateway.callLedger(keys)`, **gateway `actor` and `org` ceilings that count every model call's caller**, a 5xx tool cause hidden from the model, `fnv1a` removed and `HashEmbedder` vectors changed, an unknown finish reason read as truncated, an unscoped vector read refused inside an org's request, a required `VectorStore.prune`, `chunk()` owning `source`, and `numericTolerance` refusing a bound that is not one; then testing — a coded `app()` before boot, `assertDeterministic` by canonical form, `frozenClock` announcing its moves, one module instance per island mount; then scraping — a proxy switch in launch args refused, a required browser-level `target()`, a jar-less browser refused, `burnSession` comparing `savedAt`, `maxDrop` held to a fraction, credential-shaped URL redaction, a declared header that replaces the session's, wildcard hosts resolved and pinned, robots redirects screened per hop, and an undated recording read as stale; then admin — a nullable keyset bound, **edit forms that post `_version` and a 409 for a stale edit**, a required `AdminFormProps.version`, a `'stale'` `CrudResult`, creates and updates decided on what they write, tenant-scoped audit screens, actions and batches that commit with their audit entry, `?scope=*` for no scope, and stricter list filters; then a split sitemap's parts under `/sitemaps/`, a permission's declaration site restored with it, then cli — an export directory a build must prove is its own, a static build that fails on a module that does not load, unread build flags refused, a `--dry-run` that is the write plan, generator names and API bindings refused before writing, an unowned path read as root-wide, test discovery anchored at the root, guards and app entry files under `filesize` and `errors`, SEO answers kept an hour, a scaffold pinned to the repository's `solid-js` and typechecking the root program, **a permission only `defineAdmin()` declared refused by the `policy` step**, **an unrecorded `REPLICA IDENTITY FULL` refused by the `drift` step**, and a registry snapshot that carries permission sites; then a handler's own CSP kept beside the app's, `x routes --json` in every route fix, **serving roles that leave the framework schema to `ROLE=migrate`**, decimal-only ports and proxy hops, stored files served as sandboxed downloads, no readiness grace off the listening roles, a replicator ready only while its stream runs, and cli commands that exit 1 on an unknown name or any finding, a `/_x` SQL panel that runs only a same-origin POST from this machine, and stricter `x doctor`, `x jobs`, `x shot`, `x dev`, `x verify merge`, `tests.run`, `x mcp serve` and `x routes`; then `checkErrorCodesThrown` waiving only the codes a list names; then **a chart that renders a NetworkPolicy per role, a bounded `/tmp` and a Secret every role must have**, and a sync listener on its own port at port 0 | the `24.0.0` section, in order |
| 22.x → 23.0.0 | **66** — an image line that prebuilds the island store, a worker that imports less of the app, a committed schema dump, a stated coverage floor, step deadlines, raw browser requests refused by the gate, a typed-handle repo with `list(limit)` and a generated query with no `orgId` input, admin label keys the `i18n` step now checks, every hand-written job driver and store fenced on its claim, `runJobs` through a real worker, a framework-served admin that replaces the host's pages and now serves the jobs dashboard, an async `AuditLog`, admin writes held to the row scope, and sealed scraping sessions that discard what was stored before | the `23.0.0` section, in order |
| 21.x → 22.0.0 | **23** — two date readers that refuse a non-ISO string instead of reading it in the host's zone, a `helm` release named after the app, `channel()` requiring a policy, a per-mutation outbox, a `sync` role that refuses to boot with nothing to deliver, boot-owned auth tables, `x shot` on raw CDP with no `puppeteer-core`, `realtime.transport` deciding the bus, and removed exports: `Result`, realtime's `backoffDelay`, the e2e driver's move to `@ultimat3/testing`, `startLiveReplicator` leaving it, unreferenced package internals and 236 of the CLI's, a one-time `x db gen` for a re-stamped schema hash, and a query that filters on a column its loader never selected refusing instead of answering `[]` | the `22.0.0` section, in order |
| 20.x → 21.0.0 | **27** — `AsyncState`'s import path, `custom(merge)` over rows rather than outputs, realtime's second conflict vocabulary removed, `isSuperseded` widened, one error path for every typed client, the record envelope on actions that return entity rows, the service worker's outbox flush replaced by a message to open tabs, a third client-scope answer, `last-write-wins` refused without a clock, the realtime client rebuilt around one page store and one read hook, Compose requiring `SYNC_URL`, `x verify`'s duration as wall time, and channels served by declaration only. The client data layer, one entry per removed surface | the `21.0.0` section, in order |
| 19.x → 20.0.0 | **2**, both `@ultimat3/ui` component behaviour and neither a type change — a `DataTable` that keeps its rows while reloading, and a `Button` whose `loading` no longer sets the native `disabled`. Nothing fails to compile; what changes is what a screen does | the `20.0.0` section, in order |
| 18.x → 19.0.0 | **2**, both from the same hole — the service worker had no build behind it, so the config key that steers it and the route it falls back to both had to move | the `19.0.0` section, in order |
| 17.x → 18.0.0 | **5** — a runtime floor that was a minor behind what the CLI emits, two PWA config surfaces that had to grow before an app could be installable, a `--json` shape, and one scraping interface | the `18.0.0` section, in order |
| 16.x → 17.0.0 | **3**, all one sweep — a numeric option that used to accept `NaN` refuses it, at boot or at the call boundary rather than mid-request | the `17.0.0` section, in order |
| 15.x → 16.0.0 | **1** — `matches(/re/)` refuses a construct the two regex engines read differently, at `entity()` time | the `16.0.0` section, in order |
| 14.x → 15.0.0 | **1** — `DriftKind` gains a member, so an exhaustive `switch` with no `default` stops compiling | the `15.0.0` section, in order |
| 13.x → 14.0.0 | **8** — two are security fixes with a behaviour change (a frame verb, a session key), four are types that refused what the runtime already did, and two remove API nothing called | the `14.0.0` section, in order |
| 12.x → 13.0.0 | **2**, both narrow: a service factory's parameter type, and one deleted `PageLike` member with zero call sites anywhere in the repository | the `13.0.0` section, in order |
| 11.x → 12.0.0 | **16**, from the widest sweep since 4.0.0 — a keyset defect that dropped rows, a name that reached the DDL unchecked, and eight interfaces that gained a member | the `12.0.0` section, in order |
| 10.x → 11.0.0 | **7** | the `11.0.0` section, in order |
| 9.x → 10.0.0 | **19** | the `10.0.0` section, in order |
| 8.x → 9.0.0 | **5** | the `9.0.0` section, in order |
| 7.x → 8.0.0 | **6** | the `8.0.0` section, in order |
| 6.x → 7.0.0 | **4** | the `7.0.0` section, in order |
| 5.x → 6.0.0 | **7** | the `6.0.0` section, in order |
| 4.x → 5.0.0 | **2**, over six surfaces, each a declaration that promised what the code did not do | the `5.0.0` section, in order |
| 3.0.0 → 4.0.0 | **25**, from a sweep that closed every known gap | the `4.0.0` section, in order |
| 2.0.0 → 3.0.0 | **10**, all from a five-agent bug sweep | the `3.0.0` section, in order |
| 1.x → 2.0.0 | **33** | the `2.0.0` section, in order |
| 11.x → 20.0.0 | **47** | every major section `CHANGELOG.md` still carries, oldest first |

An entry is a line `CHANGELOG.md` marks `BREAKING —`. The count is derived, never curated:

```sh
grep -cE '^(- \*\*|### )BREAKING —' <(awk '/^## /{u = ($0 == "## [Unreleased]")} !u' CHANGELOG.md)
# 365 As of 2026-10-04 — every RELEASED section, which is the sum of every row above whose section
# the changelog still carries. `[Unreleased]` is cut by the awk deliberately: a bare whole-file
# grep agrees with this number only while that section is empty, so it moved on every PR that
# landed a breaking change and moved BACK when the release promoted the section — a count that can
# only be right between merges, whose repair is a number the next release invalidates. Corrected
# 2026-08-26, after it failed exactly that way.
#
# The count is SMALLER than the number of entries this page walks, and that is the archive, not a
# discrepancy: `CHANGELOG.md` keeps the recent releases and `git show v10.0.0:CHANGELOG.md` has the
# rest. THIS page is not truncated with it — a reader upgrading across four majors needs every
# walkthrough in order, so every major keeps its row and its section here. `changelog-check` reads
# the oldest `## X.Y.Z` heading still in the changelog as the retention boundary and stops asking
# for a count below it. At a TAGGED commit
# `[Unreleased]` holds none, and that is the state the rule below checks — a `BREAKING —` line left
# there at a tag is
# X_DOC_CHANGELOG_UNRELEASED_BREAKING, and the release promotes the section rather than appending one.
# Scope the count to one section to read a single row. The range is that section's own heading line
# to the line before the next `## `, and `grep -n '^## ' CHANGELOG.md` prints both —
#   sed -n '<start>,<end>p' CHANGELOG.md | grep -cE '^(- \*\*|### )BREAKING —'
# Line numbers are deliberately not written here: every release moves them.
# `bun run changelog-check` compares both directions: each row against its OWN section, and the
# line above against the file.
```

Each entry changes a surface the table below covers.

> **Move to whatever `latest` is** — only the [footer](_Footer) stamps the number, because a version written into a page goes stale on the next tag. All 31 workspaces resolve at one version — 29 `@ultimat3/*` plus the unscoped `create-ultimate`, `@ultimat3/scraping` and `@ultimat3/flags` included — and every tarball since 3.0.0 was published by the release workflow with a provenance attestation. Resolve before you pin, never take it from this page:

| Check | Command | Answer that means "go" |
|---|---|---|
| what `latest` is | `npm view @ultimat3/core version` | the version you are pinning |
| that a package resolves at it | `npm view @ultimat3/scraping@<version> version` | that version, not `E404` |
| that the tarball is attested | `npm view @ultimat3/core dist.attestations` | a `provenance` object |
| every name that must move together | `bun run scripts/release-workflow.ts --json` | the 30 derived names — check each |

## 24.x → 25.0.0, entry by entry — **unreleased**

**Thirty-one entries so far** — `CHANGELOG.md`'s `[Unreleased]` breaking entries in their order: Bun
first, then grouped by package, lowest tier first. No legacy path, no codemod, no compatibility
shim — every break is a build error or an `X_*` error naming the rewrite. Most of the major is
deletion: a second spelling, a second projection or a second page shape removed, and the keys and
re-exports a deprecation promised to remove. **Entries 2 and 8 refuse the boot** of an app that
still writes a deleted key. **Entry 12 is silent:** a per-action bucket in `configureHttp` stops
limiting anything, so move it before the deploy — upgrade step 9. **Entries 22–24 refuse every AI
call** until the app registers its own models and names one — upgrade step 8. Entry 31 landed
after the cut, so it sits below 30 rather than with ai's 22–24. A later slice
appends its rows below the last one and never renumbers; each row's `CHANGELOG.md` line names it
as `(#N)` after the dash.

### The upgrade, top to bottom

| # | Do | What you see until you do | Entries |
|---|---|---|---|
| 1 | `bun upgrade` to 1.4.2 and move the app's own image to a 1.4.2 base | `X_BUN_VERSION` from `x` and `x doctor` | 1 |
| 2 | pin every `@ultimat3/*` to the one new version, `bun install` | nothing yet — a mixed install is untested | — |
| 3 | delete the removed keys from `app.config.ts` and each overlay; declare the locales in `defineCatalogs` (`packages/i18n/src/index.ts`); move a non-`/mcp` `ai.mcp.path` to the first `defineAppMcp({ path })` in `apps/<app>/mcp.ts`; move `drainTimeoutMs` to `drain: { deadlineMs }` | TS2353 in a typed config; `X_CONFIG_INVALID` naming the key and its replacement at the first import | 2, 8 |
| 4 | `bun run typecheck` for the renames and removed exports: factory spellings, `checkEnvExample`, the core deprecation, client-flight and audit-sink helpers, `fingerprint`, `nearestName`, `promptHash`, `entity`'s `Page`, `SQL_*`, `createNatsDriver` and `createRedisDriver` imports | TS2305 / TS2724 at each import; TS1485 / TS1362 at a class now exported as a type | 3, 5–7, 14, 15, 20, 28, 31 |
| 5 | `bun run typecheck` for the MCP projection and the page shape: `.tool()` and `toolFromAction` → `toolFrom`, `endCursor` / `hasNextPage` → `nextCursor` / `hasMore`, `mcp.name` → the primitive's `name` | TS2339 / TS2305 / TS2353 at each site | 10, 11, 18 |
| 6 | `bun run typecheck` for the members a custom implementation owes: `AuditRecord.name` / `.primitive`, `IdempotencyStore.keepsRedaction` and `settle(…, redacted)`, `WebhookLedger.isDisabled`, `ChangeEvent.write`, `DigestAppend.appender`; widen a `Menu` trigger's `aria-controls`; read `listenerFor` instead of `listeners` | TS2741 / TS2554 / TS2322 / TS2341 at each site | 4, 13, 16, 17, 21, 25, 26 |
| 7 | `bun run typecheck` for ai: pass `models` to each `new AnthropicProvider(…)`, replace `OPENAI_MODEL_IDS` with the app's ids | TS2554 / TS2305 at each site | 23 |
| 8 | **before the deploy, where the app calls a model:** `registerModel` every model it names (by convention in its own `models.ts`), and name one on each declaration or as `createGateway({ defaultModel })`; a test registers its rows in `beforeEach` and passes `model` to `EchoProvider` | `X_AI_MODEL_UNKNOWN` before any provider call; `X_AI_MODEL_UNRESOLVED` at a call that names none | 22–24 |
| 9 | **before the deploy:** move each `rateLimit.buckets.<actionName>` from `configureHttp` to that action's `rateLimit: { limit, windowMs }` | `X_CONFIG_INVALID` at boot, naming the bucket and the action | 12 |
| 10 | `x manifest`, commit `x.manifest.json` and `openapi.json` | `X_MANIFEST_STALE` from the `manifest` step | 11 |
| 11 | `x verify --only boundaries,unit,contract,e2e` and fix what it fails: move an app wildcard off a `bearerMount` prefix, list every projected tool under a scope, give each offline scrape a `robots: { ignore }` reason, move a page's repo read into a query | `X_ROUTE_CONFLICT`; `X_MCP_SCOPE_UNCOVERED` at boot; `X_SCRAPE_ROBOTS_DISALLOWED`; `X_BOUNDARY_ROUTE_TO_DB` | 9, 19, 27, 30 |
| 12 | read each script or CI job that runs `x shot --cdp-url` against a hosted browser | `X_CDP_CALL_FAILED` where a capture used to proceed | 29 |
| 13 | `x verify` | green, or a finding whose `fix:` is the edit | — |

### Entry by entry

Every package (1). Tier 0 — `@ultimat3/core` (2–5). Tier 1 and up — the factory spellings of
`db`, `cache`, `storage`, `auth`, `action`, `jobs`, `realtime`, `mail`, `notify`, `ai` and
`testing` (6). Tier 2 — `@ultimat3/entity` (7),
`@ultimat3/http` (8–9). Tier 3 — `@ultimat3/action` and `@ultimat3/query` (10–14),
`@ultimat3/jobs` (15–16), `@ultimat3/realtime` (17). Tier 4 — `@ultimat3/mcp` (18–19),
`@ultimat3/manifest` (20), `@ultimat3/notify` (21), `@ultimat3/ai` (22–24), `@ultimat3/ui` (25).
Tier 5 — `@ultimat3/testing` (26), `@ultimat3/scraping` (27), `@ultimat3/cli` (28–30). After
the cut — `@ultimat3/ai` (31).

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | `engines.bun`, `x`, `x doctor` | you run Bun 1.4.0 or 1.4.1. `X_BUN_VERSION`; `bun upgrade`, and a 1.4.2 base image in the app's own Dockerfile |
| 2 | `app.config.ts`, keys removed: `locales`, `defaultLocale`, `defaultTimeZone`, `defaultCurrency`, `theme.tokens`, `jobs.driver`, `ai.mcp.path` | a layer writes one. `X_CONFIG_INVALID` naming the key and its replacement; TS2353 in a typed config; TS2339 where code reads `config.locales`. The locales and their default are `defineCatalogs({ default, locales })` in `packages/i18n/src/index.ts`; the zone is passed per call, the currency per `Money`; the theme is `defineTheme` in `apps/web/shared/theme.ts`; the driver is `setJobDriver(postgresJobDriver({ executor }))`. Delete `ai.mcp.path`: every MCP endpoint, #0 included, mounts at its own `defineAppMcp({ path })` (default `/mcp`) — if yours was not `/mcp`, pass it as `path` to the first `defineAppMcp` in `apps/<app>/mcp.ts`. `McpConfig` is `{ expose }` |
| 3 | `assertEnvExample`, `EnvExampleDriftError`, `resolveSpeculation` | you import one. `checkEnvExample(…)` returns findings instead of throwing — or let `x verify --only manifest` run it; speculation is `defineConfig({ navigation: { speculation } })` |
| 4 | `AuditRecord`, `normalizeAuditRecord`, `NormalizedAuditRecord` | a sink or test reads `record.action` or builds a record without `name` and `primitive`. TS2339 / TS2741. Read and write `name` and `primitive`; no DDL changed |
| 5 | `Deprecation`, `DeprecationField`, `DeprecationRender`, `recordDeprecatedCall`, `renderDeprecation`; the values `createClientFlight`, `DEFAULT_CLIENT_RETRY`, `isSuperseded`, `isTransientFailure`, `getAuditSink`, `setAuditSink`, `resetAuditSink` | you import one from `@ultimat3/action` or `@ultimat3/query`. Import it from `@ultimat3/core`; `action` and `query` re-export types only |
| 6 | every `createMemory*`, `createPg*`, `pgSchedulerState`, `createPostgresClient`; a `Memory*` / `InMemory*` / `Pg*` / `BuiltinAdapter` class `new`-ed as a value; every `create<Vendor>Driver`; storage's `memoryDriver` | you call one. TS2305 / TS2724; TS1485 / TS1362 where the class is now a type only. Rename per the table below. Arguments and return types are unchanged; option type names too, but storage's `MemoryDriverOptions` → `MemoryStorageDriverOptions` |
| 7 | `Page` from `@ultimat3/entity` | you annotate a `findMany` or `.page()` result with it. Import `Page` from `@ultimat3/core` (or `@ultimat3/query`): `findMany` answers it, so the page now carries `hasMore` too. A hand-written `Repo` builds its page with core's `pageOf(rows, nextCursor)` (TS2741 / TS2322 at a `{ rows, nextCursor }` literal) |
| 8 | `configureHttp({ drainTimeoutMs })`, `defineHttpConfig({ drainTimeoutMs })` | you pass it. `X_CONFIG_INVALID` naming `drain.deadlineMs`, refused by key so a spread is caught too. Declare `drain: { deadlineMs }` in `app.config.ts` — every role, web included, drains on it |
| 9 | `bearerMount` | the app declares a wildcard at the mount's own `<prefix>/*rest`. `X_ROUTE_CONFLICT` at registration; the mount answers every method under its prefix |
| 10 | `.tool()`, `toMcpTool(s)`, `toQueryTool(s)`, `isExposed`, `toolFromAction`, `toolFromQuery`, `McpToolDescriptor`, `McpInvokeOptions`, `QueryTool*` | you project or call a tool by hand. `toolFrom(x)` for an action or a query (`toolFromAction` renamed, no alias), `toolListEntry(tool)` for the `tools/list` entry, `invoke(x, input, { ctx, surface: 'mcp' })` to call, `(await sourceFor(q, input, { surface: 'mcp' })).execute()` to read, `isMcpExposed(x.mcp)` from `@ultimat3/core` |
| 11 | query `Page`, the `?_first=` envelope, `openapi.json` | a client reads `endCursor` or `hasNextPage`. Read `nextCursor` and `hasMore`; pass `nextCursor` as `after` (`_after=` on the wire). Run `x manifest`. **And** a client keeps the LAST page's cursor — to poll for rows appended after it, or because it reads `nextCursor` without `hasMore`: the last page's `nextCursor` is now `null` (it is `null` exactly when `hasMore` is false, on every surface), so a `while (page.nextCursor)` loop no longer fetches an empty page past the end. To tail a listing, keep the cursor of the last page that had one, or re-read the first page |
| 12 | `http.rateLimit.buckets.<actionName>` | you limited an action through a named bucket. It is refused at boot with `X_CONFIG_INVALID` (a bucket keyed by a mounted action's or query's name): delete it from `configureHttp` and declare `rateLimit: { limit, windowMs }` on the action |
| 13 | `IdempotencyStore` | you wrote your own. Declare `keepsRedaction: true`, keep `settle`'s 4th argument `redacted` and return it as `IdempotencyRecord.redacted` |
| 14 | `SQL_*` exports of `action`, `jobs`, `notify`, `admin` | you import a statement other than a table DDL (`SQL_AUDIT_TABLE`, `SQL_IDEMPOTENCY_TABLE`, `SQL_JOBS_TABLE`, `SQL_NOTIFY_*_TABLE`, `SQL_ADMIN_AUDIT_TABLE`) — `SQL_CLAIM`, `SQL_OUTBOX_RELEASE` and `SQL_NOTIFY_INBOX_MARK_READ` included. Call the store that runs it, or copy the text into the app |
| 15 | `createNatsDriver`, `NatsDriverOptions`, `createRedisDriver`, `RedisDriverOptions` | you import one — every method threw `X_NOT_IMPLEMENTED`. Postgres is the durable driver: `postgresJobDriver({ executor })` |
| 16 | `WebhookLedger` | you wrote your own. Add `isDisabled(endpointId): Promise<boolean>` |
| 17 | `ChangeEvent` | a custom change feed builds one. Pass `write: null` where it has no write name |
| 18 | `McpExposure.name` | a hand-built primitive handed to `toolFrom` sets `mcp: { name }`. Rename the primitive instead |
| 19 | `defineAppMcp({ scopes })` | the map leaves a projected tool out — `include: 'exposed'` and hand-written tools such as `whoami` included. `X_MCP_SCOPE_UNCOVERED` at boot; list each tool under a scope |
| 20 | `contentHash` from `@ultimat3/manifest` | you import it. `fingerprint(body)` from `@ultimat3/core`, the same 16 hex characters |
| 21 | `DigestAppend`, `DigestStore` | you wrote a store. Key its replay on the required `appender` |
| 22 | `DEFAULT_MODEL`, a call with no model | a declaration, its prompt and the gateway all leave the model out. `X_AI_MODEL_UNRESOLVED` naming the three places; `EchoProvider` needs `model` too, and so does a request to a provider called directly (`AnthropicProvider`, `openAiProvider`), which runs `request.model` and nothing else. `describeAgents()` answers `model: null` there |
| 23 | `new AnthropicProvider()`, `ANTHROPIC_MODEL_IDS`, `OPENAI_MODEL_IDS` | you construct a provider without `models` or with the built-in list. TS2554 / TS2305; an empty list is `X_AI_REQUEST_INVALID`. Pass the ids the app registered |
| 24 | the built-in catalogue, `registerOpenAiModels()` | the app names a model it never `registerModel`-ed. `X_AI_MODEL_UNKNOWN` before any provider call. Register each model at boot, with its source and date beside each number |
| 25 | `Menu` trigger props | you type `aria-controls` as `string`. It is `string \| undefined`; a closed menu carries none |
| 26 | `FakeElement.listeners` | a test reads it. `element.listenerFor(name)`, or `island.fire(selector, type)` |
| 27 | an offline `scrape()` test with `fakeBrowser` / `fixtureBrowser` | it declares no `robots: { ignore }`. `X_SCRAPE_ROBOTS_DISALLOWED` under `bun test`; write the reason the run is permitted |
| 28 | `nearest` from `@ultimat3/cli` | you import it. `nearestName` from `@ultimat3/core` |
| 29 | `x shot --cdp-url` | the provider refuses the browser-target attach. `X_CDP_CALL_FAILED`; point at a browser that allows it, or drop the flag |
| 30 | the `boundaries` step | a `page`, `layout` or `route` imports a slice's `repo`. `X_BOUNDARY_ROUTE_TO_DB`; read through a query |
| 31 | `contentHash` from `@ultimat3/ai` | you import it. `promptHash(input)`, the same argument and the same hash; `contentHash` is `@ultimat3/render/server`'s byte hash only |

Entry 6, the renames:

| Package | Was | Is |
|---|---|---|
| `db` | `createPostgresClient` | `postgresClient` |
| `cache` | `createMemorySemanticCache` | `memorySemanticCache` |
| `jobs` | `createMemoryDriver`, `createPgDriver` | `memoryJobDriver`, `postgresJobDriver` |
| `jobs` | `createPgLeader`, `createPgLeaseLeader`, `pgSchedulerState` | `postgresLeader`, `postgresLeaseLeader`, `postgresSchedulerState` |
| `jobs` | `createPgEventBus`, `createPgOutboxStore` | `postgresEventBus`, `postgresOutboxStore` |
| `jobs` | `createMemoryEventBus`, `createMemoryOutboxStore`, `createMemoryStepStore` | `memoryEventBus`, `memoryOutboxStore`, `memoryStepStore` |
| `jobs` | `createMemoryLeaseStore`, `createMemorySchedulerState`, `createMemoryBackfillLedger` | `memoryLeaseStore`, `memorySchedulerState`, `memoryBackfillLedger` |
| `mail` | `createMemoryDriver` | `memoryMailDriver` |
| `notify` | `createMemoryDeliveryLedger`, `createMemoryDigestStore`, `createMemoryInboxStore`, `createMemoryPreferenceStore` | `memoryDeliveryLedger`, `memoryDigestStore`, `memoryInboxStore`, `memoryPreferenceStore` |
| `notify` | `createPgDeliveryLedger`, `createPgDigestStore`, `createPgInboxStore` | `postgresDeliveryLedger`, `postgresDigestStore`, `postgresInboxStore` |
| `storage` | `memoryDriver`, `MemoryDriverOptions` | `memoryStorageDriver`, `MemoryStorageDriverOptions` |
| `auth` | `new BuiltinAdapter(…)`, `new MemoryAdapter(…)` | `postgresAuthAdapter(…)`, `memoryAuthAdapter(…)` |
| `action` | `new MemoryIdempotencyStore(…)` | `memoryIdempotencyStore(…)` |
| `realtime` | `new MemoryLocalStore()`, `new MemoryQueueStore()` | `memoryLocalStore()`, `memoryQueueStore()` |
| `realtime/server` | `new InMemoryAdvisoryLock(…)`, `new PgAdvisoryLock(…)` | `memoryAdvisoryLock(…)`, `postgresAdvisoryLock(…)` |
| `realtime/server` | `new InMemoryChangeFeed(…)`, `new PgLogicalReplicationFeed(…)`; `PgOutputDecoder` | `memoryChangeFeed(…)`, `postgresChangeFeed(…)`; not exported — the feed decodes |
| `mail` | `createSmtpDriver`, `createResendDriver`, `createLogDriver`, `createUnconfiguredDriver` | `smtpMailDriver`, `resendMailDriver`, `logMailDriver`, `unconfiguredMailDriver` |
| `ai` | `new PgVectorStore(…)`, `new MemoryVectorStore(…)`, `new MemoryBudgetStore()` | `postgresVectorStore(…)`, `memoryVectorStore(…)`, `memoryBudgetStore()` |
| `testing` | `createSubscribeDriver()` | `subscribeDriver()` |

Each class above stays nameable as a type (`import type { MemoryVectorStore }`).

### Before → after

Entry 2 — `app.config.ts`, and where each key went:

```diff
 export const config = defineConfig({
   name: 'my-app',
-  locales: ['en', 'es'],
-  defaultLocale: 'en',
-  defaultTimeZone: 'UTC',
-  defaultCurrency: 'USD',
-  theme: { defaultMode: 'system', tokens: { brand: '#0a84ff' } },
-  jobs: { driver: 'postgres' },
-  ai: { mcp: { expose: true, path: '/agents' } },
+  theme: { defaultMode: 'system' },
+  ai: { mcp: { expose: true } },
+  drain: { deadlineMs: 25_000 }, // entry 8: was configureHttp({ drainTimeoutMs })
 });

 // apps/web/mcp.ts — an endpoint's path is its own; /mcp needs no line
+export const mcp = defineAppMcp({ path: '/agents', /* name, tools, resolveToken … */ });

 // packages/i18n/src/index.ts — the one declaration of the locales and their default
+export const catalogs = defineCatalogs({ default: 'en', locales: { en, es } });

 // at each format call — there is no ambient zone
-formatDate(at, { locale });
+formatDate(at, { locale, zone: 'Europe/Paris' });
```

Entry 10 — the one MCP projection:

```diff
-import { toMcpTool, isExposed } from '@ultimat3/action';
-import { toQueryTool } from '@ultimat3/query';
+import { invoke } from '@ultimat3/action';
+import { isMcpExposed } from '@ultimat3/core';
+import { toolFrom, toolListEntry } from '@ultimat3/mcp';
+import { sourceFor } from '@ultimat3/query';

-const entry = publishPost.tool();                       // or toMcpTool(publishPost)
+const entry = toolListEntry(toolFrom(publishPost)); // an action or a query
-await toMcpTool(publishPost).invoke(input, { ctx });
+await invoke(publishPost, input, { ctx, surface: 'mcp' });
-await toQueryTool(postList).read(input);
+await (await sourceFor(postList, input, { surface: 'mcp' })).execute();
-if (isExposed(publishPost)) …
+if (isMcpExposed(publishPost.mcp)) …
```

Entry 11 — a page:

```diff
 const page = await client.postList({ _first: 20 });
-if (page.hasNextPage) next = page.endCursor;
+next = page.nextCursor; // null exactly when !page.hasMore — the last page carries no cursor
```

Entry 12 — a per-action limit:

```diff
-configureHttp({ rateLimit: { buckets: { publishPost: { capacity: 10, refillPerSecond: 0.1 } } } });
 export const publishPost = action({
   input: t.object({ id: t.uuid }),
+  rateLimit: { limit: 10, windowMs: 60_000 },
   …
 });
```

Entries 4, 13, 16, 17 and 21 — the members a custom implementation owes:

```diff
-const record = { action: 'publishPost', /* … */ };
+const record = { name: 'publishPost', primitive: 'action', /* … */ };

 const store: IdempotencyStore = {
+  keepsRedaction: true,
-  settle: (key, value, reservationId) => …,
+  settle: (key, value, reservationId, redacted) => …, // keep it; return it as record.redacted
 };

 const ledger: WebhookLedger = {
+  isDisabled: (endpointId) => Promise.resolve(disabled.has(endpointId)),
 };

-await feed.emit({ entity, op, before, after, lsn, txid, orgId, at });
+await feed.emit({ entity, op, before, after, lsn, txid, orgId, at, write: null });
```

Entries 22–24 — the app brings its models. Every number below is a placeholder: copy the vendor's
published limits and prices into the app's own `models.ts`, with the source and the date beside
each, as `examples/dummy/apps/web/app/models.ts` does.

```ts
import { AnthropicProvider, configureAi, createGateway, registerModel } from '@ultimat3/ai';

const usd = (minor: number) => ({ minor, currency: 'USD' }) as const;

export const appModel = registerModel({
  id: 'your-model-id',
  family: 'your-vendor',
  contextWindow: 200_000,
  maxOutput: 32_000,
  inputPerMillion: usd(300),
  outputPerMillion: usd(1_500),
  cacheMinimumTokens: 1_024,
  reasoning: { effort: true, adaptive: true, disableThinkingUpTo: undefined },
});

configureAi({
  gateway: createGateway({
    providers: [new AnthropicProvider({ models: [appModel.id] })],
    defaultModel: appModel.id,
  }),
});
```

```diff
-new AnthropicProvider()
+new AnthropicProvider({ models: [appModel.id] })
-openAiProvider({ apiKey, models: [...OPENAI_MODEL_IDS] })
+openAiProvider({ apiKey, models: [appModel.id] })
-beforeEach(() => registerOpenAiModels());
+beforeEach(() => registerModel(testModelRow));
-new EchoProvider().generate({ prompt })
+new EchoProvider().generate({ prompt, model: appModel.id })
```

### Not breaking, but you will see it

| Surface | What changed |
|---|---|
| `x shot`, the PWA manifests, `x g --locales`, `x i18n`, the e2e default locale | read the locales from the app's `defineCatalogs()`, never `app.config.ts` — an app with no `packages/i18n/src/index.ts` has none declared |
| Helm grace periods | sized from `drain.deadlineMs` alone, which `x deploy --method helm` passes on every upgrade |
| `x jobs drain` | still planned: `X_NOT_IMPLEMENTED` before it boots the queue or leases a job; `--to` accepts no value, since no durable second driver ships |
| `describeAgents()` | `model` and `modelFrom` are `null` where nothing names a model; `'built-in-default'` is gone |
| fix lines | no `fix:` names a vendor's model as the default |
| `pwa.offline.fallback`, `.image`, `.font` | must be paths on this origin: `//host`, `/\host` and absolute URLs are `X_CONFIG_INVALID` at config load |
| a raw MCP tool with no `destructive` | billed to the write bucket and listed as `(action)`; set `destructive: false` on a hand-registered read |
| `BarChart` | renders a `<figure>` around `<svg role="img">`; `class` lands on the figure |
| `x shot --matrix` | directories are `<theme>-<w>x<h>`, were `<theme>-<w>` |
| `/admin` home | counts a resource only when it declares `count: true` |

### Where the sites are

```sh
grep -rnwE "locales|defaultLocale|defaultTimeZone|defaultCurrency|tokens|driver|drainTimeoutMs" app.config.ts apps packages --include=*.ts
grep -n "mcp" app.config.ts
grep -rnwE "createMemory[A-Z]\w*|createPg[A-Z]\w*|pgSchedulerState|createPostgresClient|create[A-Z]\w*Driver|(Nats|Redis|Memory)DriverOptions|memoryDriver|MemoryIdempotencyStore|(Pg|Memory)VectorStore|MemoryBudgetStore|(Builtin|Memory)Adapter|Memory(Local|Queue)Store|(InMemory|Pg)AdvisoryLock|InMemoryChangeFeed|PgLogicalReplicationFeed|PgOutputDecoder" apps packages --include=*.ts --include=*.tsx
grep -rnwE "assertEnvExample|EnvExampleDriftError|resolveSpeculation|normalizeAuditRecord|NormalizedAuditRecord|contentHash|nearest" apps packages scripts --include=*.ts --include=*.tsx
grep -rnE "(Deprecation\w*|recordDeprecatedCall|renderDeprecation|createClientFlight|DEFAULT_CLIENT_RETRY|isSuperseded|isTransientFailure|(get|set|reset)AuditSink).*from '@ultimat3/(action|query)'" apps packages --include=*.ts --include=*.tsx
grep -rnE "\.tool\(\)|toMcpTools?\b|toQueryTools?\b|isExposed\b|toolFromAction|toolFromQuery|McpToolDescriptor|McpInvokeOptions|QueryTool(Descriptor|ReadOptions|Answer)" apps packages --include=*.ts --include=*.tsx
grep -rnwE "endCursor|hasNextPage|SQL_[A-Z_]+|AuditRecord|IdempotencyStore|WebhookLedger|ChangeEvent|DigestAppend|DigestStore|FakeElement" apps packages --include=*.ts --include=*.tsx
grep -rnE "Page\b.*from '@ultimat3/entity'|bearerMount\(|scopes:|buckets:|aria-controls|robots:|fakeBrowser\(|fixtureBrowser\(" apps packages --include=*.ts --include=*.tsx
grep -rnwE "DEFAULT_MODEL|ANTHROPIC_MODEL_IDS|OPENAI_MODEL_IDS|registerOpenAiModels|AnthropicProvider|EchoProvider|defaultModel|registerModel" apps packages --include=*.ts --include=*.tsx
grep -rnE "cdp-url|x shot" .github scripts package.json bin
```

The `typecheck` step finds 3–7, 10, 11, 13–18, 20, 21, 23, 25–28 and 31 at the import or the member,
and 2 in a typed `app.config.ts`. Entries 2 and 8 also refuse at the first import of the config
(`X_CONFIG_INVALID`), 19 at boot, 9 at route registration and 22 and 24 at the first model call.
The `manifest` step finds 11's stale `openapi.json`, `boundaries` finds 30, and the unit and e2e
suites find 27. Nothing finds 12 — a bucket keyed by an action's name is read by nobody — or 29
until a capture runs; read each `configureHttp` for 12 and each `x shot --cdp-url` caller for 29.
Entry 1 is `x doctor`'s first line.

## 23.x → 24.0.0, entry by entry

**Two hundred and two entries** — `CHANGELOG.md`'s 24.0.0 entries in their order: grouped by package, lowest tier first. No legacy path, no
codemod, no compatibility shim — every break is a build error or an `X_*` error naming the rewrite.
`As of 2026-10` slices 01–10 have landed: `@ultimat3/schema` and `@ultimat3/core`; tier 1 —
`i18n`, `time`, `db`, `flags`; then `cache`, `seo`, `storage` and one `render` entry; then slice 04, complete — tier 2's `entity`, `policy` and `http`, with one `testing` entry; then slice 05, `auth`; then slice 06, complete — `query`, `mcp`, `admin`, then `action` and the `manifest` step; then slice 07, `jobs`; then slice 08, `realtime`; then slice 09, complete — `render` and `pwa`, with one `http` entry, then `ui`; then slice 10, complete — `http` again, `mcp`, `mail`, `notify` and `manifest`, then `ai`; then slice 11, complete — `testing`,
`scraping` and `admin`; then slice 12a — `cli`'s build, generator, test-selection and policy half, with
`seo`, `policy` and `testing`; then slice 12b — `cli`'s runtime and commands, with `http` and the
chart; then slice 13a, the repository's guards, with one `cli` entry; then slice 13b, CI and the
chart; then slice 14, one home per helper — `render`, `cli`, `schema` and `core`. **Realtime has three operator steps: entries
88–90, upgrade steps 32–34.** **A deployment with MFA-enrolled users has an
operator step: entry 58, upgrade steps 18–20.** **A gateway that declares `actor` or `org`
ceilings: entry 123, upgrade step 49.** **The `policy` and `drift` steps go red on an
existing app: entries 169–170, upgrade step 61.** **Every deploy runs `ROLE=migrate` before its
serving roles: entry 174, upgrade step 65.** **A chart upgrade needs its values read first:
entries 192–194, upgrade step 72.** A later slice appends
its rows below the last one and never renumbers; each row's `CHANGELOG.md` line names it as
`(#N)` after the dash.

### The upgrade, top to bottom

| # | Do | What you see until you do | Entries |
|---|---|---|---|
| 1 | pin every `@ultimat3/*` to the one new version, `bun install` | nothing yet — a mixed install is untested | — |
| 2 | `bun run typecheck`, then `x verify --only typecheck,unit` | `X_SCHEMA_DEFAULT_INVALID` or `X_CONFIG_INVALID` at the first import of the file that declares it | 4, 6 |
| 3 | read the deploy environment: `LOG_LEVEL`, `ULTIMATE_CURSOR_SECRET`, `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, `OTEL_EXPORTER_OTLP_METRICS_HEADERS`, `OTEL_TRACES_SAMPLER` | a boot that exits on `X_INVARIANT` or `X_CURSOR_SECRET_DEV`; a collector that rejects one signal; every root trace sampled where a leftover ratio thinned them | 7, 13, 14, 16 |
| 4 | `x verify --only unit,contract,e2e` and fix the tests it fails | a date, URL, object or query number that validated and is now refused; a redacted field a test read | 1–3, 5, 8–11 |
| 5 | repoint error-monitor rules from `extra.<key>` to `extra.meta.<key>`; add an exact host rule for each internal address a wildcard used to admit | a saved search that matches nothing; a refused request to `127.0.0.1` | 12, 15 |
| 6 | `bun run typecheck` again for the tier-1 types: add `zone` to each `formatRelative` call, `wildcardTime` to a hand-built `CronExpression`, `case 'changed-primary-key':` to a `DriftKind` switch, `.expression` to a `CatalogColumn.generated` read | TS2741 / TS2339 at each site | 18, 20, 26, 28 |
| 7 | load the app once (`x verify --only unit`) and fix each cron and flag declaration it refuses | `X_CRON_INVALID`, `X_FLAG_EXPIRY_INVALID` at the first import of the declaring file | 19, 30 |
| 8 | `x db gen` where the database holds an object entry 29 lists; commit `packages/db/schema/` | a dump that no longer matches the one the gate regenerates | 29 |
| 9 | `x verify --only unit,contract,job,live` and fix the tests it fails; read every `catch` and every `Promise.all` inside a `withTransaction` body | `X_DB_TRANSACTION_ABORTED` where a call used to resolve; `X_DB_SIBLING_SCOPE_TIMEOUT` after a 30 s wait; `⟦name⟧` in a rendered string; a relative date counted in calendar days | 17, 20–25, 27, 31 |
| 10 | `bun run typecheck` for the storage types: add `policy` to each `promoteAttachment` call, `stat()` to a hand-written `StorageDriver`, a guard to each `lastModified` read, a base path to `canonicalRequest` / `signConstraints` | TS2741 / TS18048 / TS2554 at each site | 35–37, 41 |
| 11 | load the app once (`x verify --only unit`) and rename each cache tag and `revalidate.tags` entry it refuses | `X_ROUTE_MODE_INVALID` at registration; `X_CACHE_PURGE_FAILED` where a tagged response is built | 33, 43 |
| 12 | `x verify --only unit,contract,e2e` and fix the tests it fails; add the real media types to each upload policy; pass `{ formats: FORMAT_ORDER }` where your driver encodes AVIF | a header or `<picture>` snapshot that changed; `X_STORAGE_TOO_LARGE` from a `get()`; an upload refused for its sniffed type | 32, 34, 38, 40, 42 |
| 13 | after the deploy: list and delete the old-shape image variants; expect signed URLs minted before it to fail for 15 minutes; purge the CDN once if a collection bust must reach older edge copies | orphaned variant files; an outstanding signed URL that no longer verifies | 32, 39, 41 |
| 14 | `bun run typecheck` for tier 2: add `transactor()` to a hand-built or wrapping `Driver`, import `dbDrift` from `@ultimat3/db`, retype a `403` denial status as `DenialStatus` | TS2741 / TS2305 / TS2322 at each site | 44, 45, 48 |
| 15 | `x verify --only unit,contract,policy` and fix the tests it fails; read every `catch` around `assertAllowed` and every policy predicate's return | `X_UNAUTHENTICATED` and a 401 where a test expected `X_FORBIDDEN` and 403; a denial where a malformed decision allowed; `X_INVARIANT_VIOLATED` from a preload over 10,000 rows | 46–49 |
| 16 | set the http config the deploy needs: `trustClientCertHeader: true` where `ctx.peer` is read behind a proxy that strips the header, `healthDetailPeers` for an off-box health reader, `cors.origins` for a cross-origin browser form, `hostname` for an embedder | `ctx.peer` is `null`; a health body of three fields; `X_CSRF_BLOCKED` on an anonymous form post | 50, 51, 53, 56 |
| 17 | `x verify --only unit,contract,e2e` and fix the tests it fails: `await` every browser `close()`, send `content-type` with every body, write `private, max-age=N` where a handler meant a per-user lifetime | `X_BODY_INVALID`; a rewritten `cache-control`; 429 after repeated 401s; a leaked Chrome | 52, 54, 55, 57 |
| 18 | **before the deploy, where any user has MFA:** `x secrets init`, or set `ULTIMATE_SECRETS_KEY` in the deploy | `X_SEAL_KEY_MISSING` at `login()` for an enrolled user | 58 |
| 19 | `bun run typecheck` for auth: a custom `AuthLimiter` implements `reserve` / `refund`; a custom `AuthAdapter` implements the eight members; callers of `verifyApiKey` read `.record`; delete imports of `redeemRecoveryCode`, `mfaRequired`, `authNotImplemented`; enrolment writes through `saveTotpSecret`; set `APP_URL` | TS2741 / TS2305 / TS2339 at each site; `X_ENV_MISSING` from `oauthLogin` | 60, 61, 64, 65, 67 |
| 20 | **deploy, then `x auth seal-mfa --json` once** | `X_MFA_SECRET_UNSEALED` (500) at the second factor for every enrolled user | 58 |
| 21 | `x verify --only unit,contract,e2e`; move the second-factor client to `meta.challenge` and `completeMfa`; list each API key's scopes and pass `grantsOf` where users hold roles | a key that resolves with fewer scopes or 401; a client still reading `meta.userId`; `X_AUTH_WRITE_FAILED` where a test matched `X_DB_UNIQUE_VIOLATION`; `X_CDP_CALL_FAILED` from an `offline()` a page refused | 61–63, 66, 68 |
| 22 | once every replica runs this release: `x doctor --json`, then `psql "$DATABASE_URL" -c 'drop table if exists x_auth_failures'` | `X_FRAMEWORK_TABLE_ORPHANED` from `x doctor` | 59 |
| 23 | `bun run typecheck` for slice 06: delete `compareValues`, pass `kindsOf(shape.entity)` to `compareRows` / `matchesFilter` / `isAfterKey`, replace `adminPermissions` with `...ADMIN_PERMISSIONS` in `definePermissions([...])` | TS2305 / TS2554 at each site | 69, 72 |
| 24 | `x verify --only unit,contract,e2e`; drop `.limit()` from each read a client pages to the end; read the row, not `.rows`, from a `single: true` MCP tool | a listing that ends at its limit; `X_CURSOR_INVALID` once for a cursor minted before the deploy; an MCP answer of a different shape | 70, 71 |
| 25 | add `idempotent: true` to every `mutator({ … })`; on more than one replica also `configureIdempotency({ scope: 'shared' })`. A hand-built `postgresIdempotencyStore` adds `origin` and `reclaimAfterMs` | TS2741 at each site; `X_MUTATOR_NOT_IDEMPOTENT` at declaration from untyped code | 73, 77 |
| 26 | `x manifest`, commit `x.manifest.json` and `openapi.json` | the `manifest` step is `X_MANIFEST_STALE` | 74, 79 |
| 27 | `x db gen`, commit `packages/db/schema/` | the `drift` step is `X_SCHEMA_DUMP_DRIFT` for `x_idempotency` | 75 |
| 28 | `x verify --only unit,contract,job`; read each test that rolls back an idempotent action or asserts a cache bust inside `withTransaction` | a record left `in-flight` after a rollback; a bust that fires at commit; `X_IDEMPOTENCY_RESERVATION_LOST` (409) on a slow attempt | 76, 78 |
| 29 | `bun run typecheck` for jobs: a custom `EventBus` returns a promise from `purgeExpired()`, a custom `EventLookup` adds `now()`, a hand-built `Lease` adds `abandon()`, a hand-built `RetentionStores` adds `events`; a caller of `SQL_CLAIM` / `SQL_SCHEDULER_FIRE` binds the extra parameter | TS2741 / TS2322 at each site; a statement that fails to bind | 81, 85, 87 |
| 30 | read every job with `retry.attempts: 1`, every script that cancels a finished job, and every `runId` passed to `enqueue` | a job buried `dead` after its worker died; `X_JOB_NOT_CANCELLABLE`; `X_ID_INVALID` | 80, 82, 84, 86 |
| 31 | `x verify --only unit,job` and fix the tests it fails | `X_JOB_LEASE_LOST` from a step write after a lapsed lease; a dead letter where a test expected a re-run | 80, 83 |
| 32 | **before the deploy:** make `APP_URL` on the `sync` role the origin the pages are served on — a declared origin is the whole allow-list; add it to `.env.production` for an older compose file | every websocket upgrade is `403 X_SOCKET_ORIGIN_REFUSED` | 88 |
| 33 | **where a channel is declared with params:** `x db gen "replica identity full"`, then `x db migrate` | `replication.channel_identity_partial` in the replicator log; deletes on those channels not announced | 89 |
| 34 | **before the deploy:** check the replication role's password method and the connection's `sslmode`; set `?sslmode=verify-full`, move the role to scram-sha-256, or state `?sslmode=disable` | `X_REPLICATION_FAILED` when the replicator dials | 90 |
| 35 | roll `replicator` and `sync` together — they must run the same major; point an off-box health reader of the sync role at `healthDetailPeers` | rows that do not parse across a mixed fleet; a health body of three fields | 91, 93 |
| 36 | `bun run typecheck` for realtime: a custom `Transport` adds `onReconnect`, a custom `AdvisoryLock` adds `onLost` and `abandon`, a custom `ChangeFeed` adds `abandon`, an `UpgradeTarget` adds `requestIP`, `UpgradeDeps` adds `healthDetailPeers`; replace `.hasOwnProperty(` on decoded records with `Object.hasOwn(` | TS2741 at each site; a `TypeError` on a null-prototype object | 92, 96 |
| 37 | `x verify --only unit,live,e2e` and fix the tests it fails | `X_TOPIC_FORBIDDEN` where a channel kept delivering; `X_OFFLINE_QUEUE_ABANDONED` for a write queued across a sign-out | 94, 95 |
| 38 | `bun run typecheck` for render: add `case 'unparsable':` to an exhaustive `switch` over `NativeReason` | TS2322 / TS2366 at the switch | 99 |
| 39 | load the app once (`x verify --only unit`) and give each `isr` route whose only trigger is a zero-length `ttl` a positive `ttl` or `tags` | `X_ROUTE_MODE_INVALID` at registration, naming the file | 98 |
| 40 | `x build`, then `x verify --only unit,contract,e2e`; handle `path === ''` in each catch-all handler, read an escaped CSS-module class by its unescaped name, replace a stored `specificity` with a comparison, point each push `url` at this origin | a 200 where a test expected a 404 at a catch-all's bare prefix; a snapshot holding the old scoped class name; `styles['w-1']` undefined; a tap that opens the app root | 97, 100–102 |
| 41 | `bun run typecheck` for ui: add `current()` and `appDefault()` to a hand-built `ThemeEnv`; delete each import of `THEME_INLINE_SCRIPT` / `themeInlineScript*`, its hand-inlined `<script>` and its `sha256-…` in your CSP; widen a `Popover` trigger's `aria-controls` to `string \| undefined` | TS2741 / TS2305 / TS2322 at each site | 103, 105, 106 |
| 42 | `x build --target static`, then `x verify --only unit,e2e,budgets`; set `theme: { defaultMode: 'system' }` where the page must follow the OS; read each upload test that posts a file the control refuses | `X_BUDGET_UNMEASURED` on every budgeted route until the build; a "System" pick that stays dark; a refused file missing from the request | 104, 107 |
| 43 | `bun run typecheck` for http: a hand-written `RateLimitStore` adds `peek(key, bucket, nowMs)`, a hand-written `RateLimiter` adds `peek(key, bucketName)` | TS2741 at each site | 108 |
| 44 | **before the deploy:** list every probe, monitor, script or agent that sends a credential that can fail — to an `auth: 'required'` route or to the MCP endpoint — from an address real users or agents share; raise `rateLimit.defaultBucket` or `rateLimits.unauthenticated`, or move it | `429 X_RATE_LIMITED` / `429 X_MCP_RATE_LIMITED` for a right credential after a run of wrong ones | 109, 114 |
| 45 | `x manifest`, then `x db gen`; commit `x.manifest.json`, `openapi.json` and `packages/db/schema/`. Where `x manifest` refuses `X_MANIFEST_FACT_INVALID`, make the declaration at `meta.path` finite and run it again | `X_MANIFEST_STALE` from the `manifest` step; `X_MANIFEST_BREAKING` for `jobs.mail.send.input` from `contract-diff`; `X_SCHEMA_DUMP_DRIFT` for `x_notify_digests` from `drift` | 116–119 |
| 46 | `x verify --only unit,contract,job,e2e` and fix the tests it fails; read each MCP client that parses a 5xx `cause`, each `db.query` an agent runs, each hand-registered tool's `destructive`, each `manage_resource` list call, each `send()` inside `withTransaction` and each recipient a mail is sent to | a fixed cause where the server's was; `X_MCP_QUERY_REJECTED`; a writing tool listed as `query`; `X_INPUT_INVALID` for a list key; a mail sent only after the commit; `X_MAIL_ADDRESS_INVALID` or `X_VALIDATION_FAILED` at `send()` | 110–113, 115, 116 |
| 47 | before dropping a default from a NOT NULL column: bump the app's major in `package.json`, or keep the default | `X_MANIFEST_BREAKING` from `contract-diff` naming `…hasDefault` | 120 |
| 48 | `bun run typecheck` for ai: a hand-written `BudgetStore` adds an atomic `take(key, tokens, limit)`; a hand-written or wrapping `Gateway` implements `callLedger(keys)`; a hand-written `VectorStore` adds `prune(filter, keep)`; replace each `fnv1a` import with core's `fingerprint` | TS2741 / TS2554 / TS2305 at each site | 121, 122, 125, 129 |
| 49 | **before the deploy, where `createGateway({ budget })` declares `actor` or `org`:** size each ceiling for every `llm()`, `agent()` and hive member a caller makes — every anonymous caller shares one counter — and key each `gateway.scope()` with `budgetKeysFor(actor)` | `X_AI_BUDGET_EXCEEDED` where the call ran | 123 |
| 50 | load the app once (`x verify --only unit,eval`); give each `numericTolerance` a finite, non-negative bound; bind a tenant on each vector store read inside an org's request, or open the backfill store with `scope: UNSCOPED` | `X_INVARIANT` at the eval file's import; `X_VECTOR_UNSCOPED` (500) at the read | 128, 131 |
| 51 | `x verify --only unit,eval,e2e` and fix what it fails: re-index every store `HashEmbedder` filled; give each app code an agent tool throws for the model to read a 4xx `registerErrorStatus` row or a public cause; move a `source` passed to `chunk()` under another key; make a fixture's invented `finish_reason` `stop` | a ranking or vector snapshot that changed; a tool result reading `CODE: ` and a fixed sentence; `X_LLM_TRUNCATED` where an answer was repaired | 124, 126, 127, 130 |
| 52 | `bun run typecheck` for scraping: a hand-written launcher or test double's browser adds `target()` answering `createCDPSession()`, whose session has `send` and `on`; a `burnSession` call passes the version of the record the run used | TS2741 / TS2554 at each site | 137, 139 |
| 53 | load the app once (`x verify --only unit`) and write each `expect.maxDrop` as a fraction | `X_INVARIANT` at `scrape()`, naming the scrape | 140 |
| 54 | `x verify --only unit,e2e` and fix the tests it fails: read `app()` inside a `test` body, set up per mount the state a test carried between island mounts | `X_TEST_APP_NOT_BOOTED` where a test expected `ReferenceError`; a mount that no longer sees the last one's module state; an assertion on key order or a count of clock announcements that changed | 132–135 |
| 55 | `x verify --only unit,job` and fix the scraping runs it fails: move a proxy switch out of `localBrowser({ options: { args } })` into `proxy` or `egress`; add an exact `allowHosts` rule for each internal host a wildcard reached and for each host a `robots.txt` redirects to; re-record each fixture with no readable `recordedAt` | `X_SCRAPE_LAUNCH_ARGS_INVALID`; `X_SCRAPE_HOST_BLOCKED`; `X_NOT_IMPLEMENTED` from a jar-less browser; `X_SCRAPE_FIXTURE_STALE`; a redaction snapshot or a header that changed; robots rules that no longer apply | 136, 138, 141–145 |
| 56 | `bun run typecheck` for admin: a custom `AdminRepo#list` handles a `null` `keyset.value`; an `AdminForm` rendered by hand passes `version`; an exhaustive `switch` over `CrudResult` handles `'stale'` | TS2345 / TS18047 / TS2741 at each site; a switch that no longer compiles | 146, 148, 149 |
| 57 | load the app once (`x verify --only unit`) and rename a list scope declared as `*` | `X_ADMIN_FILTER_INVALID` where the resource is declared | 153 |
| 58 | `x verify --only unit,contract,e2e` and fix the tests it fails: post the rendered `_version` with each hand-posted edit form; read each policy rule over `input` for what an admin create or update writes; read each test that expects an action's or a batch's write to outlive a failed audit entry, or another org's audit rows; fix each link that sends a blank, hex, exponent or off-calendar filter | a 409 where an edit used to save; a denial on a create or update; a rolled-back write with a `failed` entry; an audit list without another org's rows; `X_ADMIN_FILTER_INVALID` | 147, 150–152, 154 |
| 59 | `bun run typecheck` for slice 12a: a hand-built `ProcessRegistrySnapshot` adds `permissionSites`; a one-argument `restorePermissions(names)` call passes the `permissionDeclarationSites()` captured with the names | TS2741 at each snapshot; TS2554 at each `restorePermissions` call | 156, 171 |
| 60 | **where a sitemap is split** (past `maxUrls`, 50,000 by default): `x build --target static`, upload the new `sitemaps/` folder, delete or redirect each old `sitemap-<n>.xml`, re-submit `/sitemap.xml`. A running web role answers SEO from a one-hour memo — restart it to publish a change sooner | a search console reporting the old parts as 404; a sitemap change that shows an hour late | 155, 166 |
| 61 | `x verify --only policy,drift`: add each permission it names to the app's own `definePermissions([...])`; `x db gen "record replica identity full"`, then `x db migrate` | `X_PERMISSION_BORROWED` naming the file; `X_DB_SCHEMA_UNMIGRATED` for `replica identity full` | 169, 170 |
| 62 | `x verify --only filesize,errors,i18n,unit,live,e2e` and fix what it fails | a guard or an `apps/*/server.ts` / `prerender.ts` over 500 lines or with an unrunnable `fix:`; a test under a slice named `build`, `examples` or `dummy` that never ran and now fails | 164, 165 |
| 63 | read each build and CI script: empty a custom `--out` once or build to `.x/static`; drop `--tag` / `--out` / `--no-preflight` where the target never reads it; fix each module `x verify --only manifest --json` lists; read `ok` and the findings of `x g --dry-run`; rename a generator name it refuses; expect more work from `--affected` after a change under `scripts/` or `guards/` | `X_BUILD_OUT_UNSAFE`; `X_BUILD_FAILED`; `X_CLI_BAD_FLAG`; `X_GENERATE_CONFLICT`; a CI job that runs every workspace | 157–163 |
| 64 | optional, to match a fresh scaffold: pin `solid-js` `1.9.15`; set `"typecheck": "tsc --noEmit -p ../../tsconfig.json"` in `apps/web/package.json` and `apps/admin/package.json` | an app typecheck that now reports what the gate already refused | 167, 168 |
| 65 | **before the deploy:** make `ROLE=migrate` run to completion before every serving role. The shipped chart's pre-install/pre-upgrade hook and `docker-compose.prod.yml` already do; a deploy of your own adds the step | every `web`, `sync`, `worker`, `scheduler` and `replicator` pod refuses to boot: `X_FRAMEWORK_SCHEMA_UNAPPLIED` | 174 |
| 66 | read the deploy environment and the monitors: `TRUSTED_PROXY_HOPS` decimal 1–64, `PORT` and `METRICS_PORT` decimal; repoint an alert on `X_PORT_INVALID` for hops to `X_TRUSTED_PROXY_HOPS_INVALID`, and a match on `x routes list --json` to `x routes --json` | a boot that exits on `X_PORT_INVALID` or `X_TRUSTED_PROXY_HOPS_INVALID`; an alert that never fires | 173, 175, 176 |
| 67 | roll the chart: `docker/helm` carries the replicator probe; a chart `x new` wrote copies the two edits from `docker/helm/templates/_helpers.tpl` and `service.yaml`; read each alert on a not-ready replicator | a replicator at 0/1 while its stream is down; a worker that stops claiming at SIGTERM | 178, 179 |
| 68 | `bun run typecheck`: a hand-built `DoctorProbe` adds `appUrl` | TS2741 at each site | 182 |
| 69 | `x verify --only unit,contract,e2e` and fix what it fails: read each handler that sets its own CSP, each link to an uploaded non-media file, each script or test of `/_x/db`, `x routes list`, `x verify merge` parts and MCP `tests.run` | a page under two policies; a download where a tab opened; `405`, `421` or `X_CSRF_BLOCKED` from `/_x`; `X_CLI_UNKNOWN_COMMAND`; `X_VERIFY_MERGE_INPUT`; `failed ≥ 1` | 172, 177, 183, 187, 188, 190 |
| 70 | read each script and CI job that calls `x`: `x help`, `x i18n add\|sync`, `x db seed`, `x db backfill`, `x doctor` behind a `PORT`, `x jobs` with an id, `x shot --out`, the `x dev` and `x mcp serve` port fixes | exit 1 where 0 was; a probe of `PORT`; `X_APP_URL_PORT_MISMATCH`; `X_JOB_UNKNOWN`; a screenshot in the cwd; `X_PORT_IN_USE` | 180–182, 184–186, 189 |
| 71 | where a repository of your own calls `checkErrorCodesThrown`: pass the codes it retired as the third argument | `X_ERROR_CODE_UNTHROWN` for a code whose row says "not thrown"; `X_ERROR_CODE_UNTHROWN_STALE` for a listed code that is constructed again | 191 |
| 72 | **before the chart upgrade:** read the values — a scraper outside the cluster in `networkPolicy.metricsFrom` (or `networkPolicy.enabled: false`); `tmp.sizeLimit` for a role that writes more than 512Mi; `existingSecret` or `roles.<role>.existingSecret` for every role. A chart `x new` wrote copies `templates/_volumes.tpl`, `templates/networkpolicy.yaml` and the two values blocks from a fresh scaffold | `helm template` failing on `tmp.sizeLimit` or on a role with no Secret; a scraper that reads nothing; a pod evicted for `/tmp` | 192–194 |
| 73 | read each test or tool that runs `x dev --port 0` or `startRoles({ port: 0 })` and dials the sync node at the web port + 1: read `syncUrl` from the boot's answer | a refused connection to web + 1 | 195 |
| 74 | `x verify` | green, or a finding whose `fix:` is the edit | — |

### Entry by entry

Tier 0 — `@ultimat3/schema` (1–5), `@ultimat3/core` (6–16). Tier 1 — `@ultimat3/i18n` (17),
`@ultimat3/time` (18–21), `@ultimat3/db` (22–29), `@ultimat3/flags` (30–31), `@ultimat3/cache`
(32–33), `@ultimat3/seo` (34), `@ultimat3/storage` (35–42). Tier 4 — `@ultimat3/render` (43).
Tier 2 — `@ultimat3/entity` (44–46), `@ultimat3/policy` (47–49), `@ultimat3/http` (50–56). Tier 5 —
`@ultimat3/testing` (57). Tier 2 — `@ultimat3/auth` (58–67). Tier 5 —
`@ultimat3/testing` again (68). Tier 3 — `@ultimat3/query` (69–70), with `@ultimat3/mcp` (71). Tier 5 —
`@ultimat3/admin` (72). Tier 3 — `@ultimat3/action` (73–78). Tier 5 — `@ultimat3/cli` (79).
Tier 3 — `@ultimat3/jobs` (80–86). Tier 5 — `@ultimat3/cli` again (87). Tier 3 —
`@ultimat3/realtime` (88–96). Tier 2 — `@ultimat3/http` again (97). Tier 4 — `@ultimat3/render`
(98–101), `@ultimat3/pwa` (102), `@ultimat3/ui` (103–107). Tier 2 — `@ultimat3/http` again
(108–109). Tier 4 — `@ultimat3/mcp` (110–114), `@ultimat3/mail` (115–116), `@ultimat3/notify`
(117), `@ultimat3/manifest` (118–120), `@ultimat3/ai` (121–131). Tier 5 — `@ultimat3/testing`
(132–135), `@ultimat3/scraping` (136–145), `@ultimat3/admin` (146–154). Tier 1 —
`@ultimat3/seo` (155). Tier 2 — `@ultimat3/policy` (156). Tier 5 — `@ultimat3/cli` (157–170),
`@ultimat3/testing` (171). Tier 2 — `@ultimat3/http` (172–173). Tier 5 — `@ultimat3/cli`
(174–190), and again (191). Deploy — the chart, with `@ultimat3/cli`'s scaffold (192–195).
Tier 4 — `@ultimat3/render` (196). Tier 5 — `@ultimat3/cli` (197). Tier 0 — `@ultimat3/schema`
(198–199), `@ultimat3/core` (200–202).

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | `t.date`, `isIsoDateTime`, `fromIso`, `timestamp()` columns, feed dates, `DateTime` | a fixture, seed, import or client sends a day its month does not have (`'2026-02-30'`, `'2026-04-31'`), month `00`/`13`, day `00`/`32`. Refused at validation; it used to roll over into the next month. Correct the date at its source |
| 2 | `t.url` | a value has a leading or trailing space or control character, or a tab, CR or LF anywhere. `value.trim()` before validating; an interior tab, CR or LF survives `.trim()` — strip or percent-encode it at the source. A stored row that already holds one fails the next time it is validated |
| 3 | `t.object`, `t.record`, `t.money` | you pass a `Map`, a `Date` or a class instance. Pass a plain object: `{ ...instance }`, `Object.fromEntries(map)`. Null-prototype objects are still accepted |
| 4 | `.default(v)` | `v` fails the schema it is declared on (`t.number.min(5).default(1)`). `X_SCHEMA_DEFAULT_INVALID` at the first import of the file; the cause quotes the rule. Edit the default, or relax the rule |
| 5 | HTTP query and form coercion | a client sends `0x10`, `0b11` or `0o17` for a number. It stays a string and fails as `expected a number`. Send decimal |
| 6 | `defineConfig` | `app.config.ts` or an overlay holds: an unknown `roles` entry, `jobs.backoff`, `database.driver` or `theme.defaultMode`; a non-boolean `database.ssl`, `realtime.enabled` or `ai.mcp.expose` (`'false'` from an env variable read as on — write `process.env.X === 'true'`); `auth.signInPath` with no leading `/` (`ai.mcp.path`, then also checked here, is deleted in 25.0.0); `cache.tiers: []`; an empty or non-string `jobs.queues` entry; one locale twice (`['EN', 'en']`); a section set to `null`. `X_CONFIG_INVALID` names each key |
| 7 | `LOG_LEVEL` | a deploy sets a value that is not `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`, lower-case — `DEBUG` and `verbose` included. The process exits at import (`X_INVARIANT`); it used to log at `info`. Unset and empty are unchanged |
| 8 | `retry()`, `retryDecision()` | `attempts` can be `NaN`, infinite, negative or a fraction, or `timeBudgetMs` `NaN` or infinite — typically `Number(process.env.X)` on an unset variable. `X_INVARIANT` before the first try. Parse and default the value before passing it. `attempts: 0` still runs once |
| 9 | `createFlightGate` | `maxConcurrent` or `maxQueued` is `NaN`, infinite, negative or a fraction (`X_INVARIANT` at construction), or `maxConcurrent` is `0` and you expected callers to wait: each is refused with `X_FLIGHT_GATE_OVERLOADED` |
| 10 | `withChildContext({ signal })` | the child's work was meant to survive the request. The child's signal now aborts when the parent's does. Move that work to a job |
| 11 | redaction: logs, audit rows, the error monitor | a test, a log query or an audit reader expects the value of a field named like a credential — `currentPassword`, `mfaSecret`, `resetToken`, `recoveryCode`, `webhookSecret`, `passwordHash`, `tokenHash`, `keyHash`. It reads `[redacted]`. A name ending in `token` (`NPM_TOKEN`, `confirmationToken`), qualified key material (`privateKey`, `AWS_ACCESS_KEY_ID`) and a value embedding a credential (`connectionString`, `databaseUrl`) read `[redacted]` too. Ask `isRedactedKey('<name>')` for any other name. `idempotencyToken`, `continuationToken`, `maxTokens`, `cacheKey` and `code` are unchanged |
| 12 | the Sentry envelope | a monitor rule, alert or saved search reads an error's `meta` key at `extra.<key>`. It is `extra.meta.<key>`. `scope.extra` keys stay at `extra.<key>`, except `fix`, `docs`, `stack`, `requestId` and `actorId`, which the framework's own values now win |
| 13 | `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, `OTEL_EXPORTER_OTLP_METRICS_HEADERS` | a deploy sets either one and also `OTEL_EXPORTER_OTLP_HEADERS`. The per-signal variable was ignored; it now replaces the generic one for that signal. Put every header the signal needs in it, or unset it |
| 14 | `OTEL_TRACES_SAMPLER=parentbased_always_on` | `OTEL_TRACES_SAMPLER_ARG` is also set. The ratio is ignored and every root is sampled. For a ratio: `OTEL_TRACES_SAMPLER=parentbased_traceidratio` |
| 15 | `hostDecision`, every `allowHosts` list | a `'*'` or `'*.suffix'` rule was how a request reached a loopback, private, link-local or metadata address literal. Add the exact rule: `allowHosts: ['*', '127.0.0.1']`. Hostnames are unaffected, including one that resolves inward |
| 16 | `ULTIMATE_CURSOR_SECRET` | a compose file or chart sets it to the empty string. Outside local development the boot is `X_CURSOR_SECRET_DEV`: `x secrets set ULTIMATE_CURSOR_SECRET`. Cursors issued under the empty key stop verifying — clients restart from page one |
| 17 | `t(key)` with no vars | a caller relied on the template coming back raw: a key whose message holds `{name}` or `{{`. It renders `⟦name⟧` and `{`. Pass the vars, or read the template with `t.raw(key)` |
| 18 | interval crons, `CronExpression` | a task with `*` or `*/n` in its minute or hour field must not run twice in a fall-back hour — make the body idempotent for that hour, or give it a fixed time. A hand-built `CronExpression` adds `wildcardTime` (TS2741) |
| 19 | cron expressions | one spells a name loosely (`mond`, `thurs`, `sept`) or has an extra `-` or `/` part (`1-5-7`, `1/2/3`). `X_CRON_INVALID` where the task is declared. Write `mon` or `monday`; write one range, one step |
| 20 | `formatRelative` | always: add `zone` (TS2741). A test that asserted on "tomorrow" / "in N days" re-reads its expectation — the count is midnights crossed in that zone |
| 21 | `addDaysInZone`, `formatDuration`, `formatDurationIso`, `plainDateUtc`, `addPlainDays`, `plainDateIn` | a computed argument can be a fraction, `NaN`, infinite, or a date outside years 0000–9999. `X_SCHEDULE_INVALID` or `X_INVARIANT` at the call. Round or default the number before passing it |
| 22 | `withTransaction` | a body catches a statement error and carries on. `X_DB_TRANSACTION_ABORTED`; it used to resolve with nothing stored. `await withTransaction(() => fallible()).catch(fallback)` around the statement, or rethrow |
| 23 | `X_DB_COMMIT_UNKNOWN`, `onRollback` | you retry on `X_DB_UNAVAILABLE` from a commit, or an `onRollback` undo had to run when the socket died mid-`COMMIT`. Neither list runs now. In a `psql "$DATABASE_URL"` session, select a row the transaction wrote; re-run only when it is absent |
| 24 | a nested `withTransaction(fn, options)` | it passes `isolation`, `readOnly: true`, `deferrable: true` or another `client` (`X_INVARIANT`). Move the first three to the outermost call; run the other client's work after the outer scope returns |
| 25 | sibling nested `withTransaction` scopes | a nested body awaits another scope under the same parent (`X_DB_SIBLING_SCOPE_TIMEOUT` after 30 s — it is a cycle), code relied on two siblings interleaving under `Promise.all`, or the first sibling runs longer than 30 s. Await them in sequence: `await withTransaction(first); await withTransaction(second)`. For a long first sibling pass `{ siblingWaitMs }`; `0` removes the deadline |
| 26 | `DriftKind`, the drift check | you `switch` over `DriftKind` exhaustively: add `case 'changed-primary-key':`. A table re-keyed by hand now fails the check; the finding's `fix:` is one `psql "$DATABASE_URL" -c '…'` command to run against that database, then `x db migrate` re-checks |
| 27 | `introspect()` | you compare `ColumnDescription.dataType` to `'numeric'`, `'ARRAY'` or `'USER-DEFINED'`, or assume every `IndexDescription.columns` entry is a column name. Compare to `numeric(12,2)`, `text[]`, the enum's name; skip entries in parentheses |
| 28 | `CatalogColumn.generated` from `@ultimat3/db/schema-dump` | you read it as a string. Read `generated.expression`; `generated.storage` says `stored` or `virtual` |
| 29 | the schema dump's `unrendered.sql` | the database holds extended statistics, forced row security, non-default column storage, an unpopulated materialized view, or a trigger on a partitioned table. `x db gen`, commit the directory |
| 30 | a temporary flag's `expiresAt` | it is not ISO-8601 (`'December 1, 2026'`, `'12/01/2026'`) or names a day its month lacks. `X_FLAG_EXPIRY_INVALID` at declaration. Write `'2026-12-01'` |
| 31 | `configureFlags({ reportEveryMs })` | the value can be `NaN`, infinite, negative or a fraction — `Number(process.env.X)` unset. `X_INVARIANT`. Parse and default it first; `0` is legal |
| 32 | `Surrogate-Key` / `Cache-Tag` from `cacheHeaders()` | a test asserts the header value, or a CDN rule parses it: each tagged response adds `e:<entity>`. After the deploy a collection bust misses edge copies cached before it until their `s-maxage` passes — purge the CDN once if that window matters |
| 33 | cache tags | a tag's entity or id holds whitespace or a comma. `X_CACHE_PURGE_FAILED` from `cacheHeaders()`, `surrogateKeys()` and the CDN tier's bust. Rename it in its `declareTags(...)` call |
| 34 | `responsiveImage()`, `usableWidths` | your image driver encodes AVIF and you relied on the default offering it: pass `{ formats: FORMAT_ORDER }`. A snapshot of `<picture>` markup loses its AVIF `<source>`. A source wider than 8192 gets `?w=8192` as its widest candidate. An intrinsic width that is `NaN`, zero or negative is `X_INVARIANT` |
| 35 | `promoteAttachment` | always: add `policy` (TS2741; `X_INVARIANT` from untyped code) — the `uploadPolicy()` the upload was granted under. An upload over `policy.maxBytes` is `X_STORAGE_TOO_LARGE` and stays under `pending/` |
| 36 | a hand-written `StorageDriver` | you ship one: add `stat(key): Promise<StorageObject \| undefined>` (TS2741) |
| 37 | `StorageListEntry.lastModified`, `StorageObject.lastModified` | you read it without a guard (TS18048), or relied on `sweepOrphans` deleting objects with no reported date. Handle `undefined` |
| 38 | `disk.get(key)` | an object can exceed the disk's `maxPutBytes` (10 MB unless set) — a presigned upload, a file written by another tool. `X_STORAGE_TOO_LARGE`. Use `disk.stream(key)`, or set `maxGetBytes` on the driver |
| 39 | stored image variants | always, if variants exist: keys are `<source key>@<transform>.<ext>` with the source's extension kept. Old-shape variants are orphaned; delete them with the commands below. A stored reference to a variant key is recomputed with `variantKey()` |
| 40 | `variantKey`, `fitDimensions` | a width or height can be `NaN`, zero, negative or a fraction (`X_INVARIANT`): round it first. A caller that relied on `contain` upscaling a small source gets the source's size |
| 41 | signed URLs on the local and memory disks | always: URLs minted before the deploy stop verifying (15 minutes by default) — a client retries with a fresh grant. A caller of `canonicalRequest` / `signConstraints` adds the base path: `signedUrlBasePath(baseUrl)` |
| 42 | upload policies | a policy allowed `video/mp4` and took AVIF, HEIC, MOV, M4A or 3GP under it. Add `image/avif`, `image/heic`, `video/quicktime`, `audio/mp4`, `video/3gpp` as needed |
| 43 | a route's `revalidate.tags` | a tag holds whitespace or a comma. `X_ROUTE_MODE_INVALID` at registration, naming the file. Rename the tag |
| 44 | a hand-built `Driver`, a hand-built `SealedMeta` | you ship or wrap an entity driver: add `transactor()` — a wrapper writes `transactor: () => inner.transactor()` (TS2741). A hand-built `SealedMeta` adds `plaintext`. A hand-built driver kept in a file under the app's own `packages/db/` moves the schema hash when it gains `transactor()`: `x verify` answers `X_DB_DRIFT`, and `x db gen "<name>"` re-records the hash and writes no migration |
| 45 | `dbDrift`, `ENTITY_ERROR_CODES` from `@ultimat3/entity` | you import `dbDrift` from entity: `import { dbDrift } from '@ultimat3/db'` (TS2305). A list built from `ENTITY_ERROR_CODES` no longer holds `X_DB_DRIFT` |
| 46 | `preload(relation)` | one page attaches more than 10,000 related rows. `X_INVARIANT_VIOLATED`; pass the bound the relation really has: `.preload('comments', { max: 50000 })`, or page the relation itself. The last `{ max }` stated on a chain wins. The refusal's `fix:` is `x entities describe <entity> --json`; the edit is in its cause |
| 47 | `assertAllowed` | a `catch` or a test expects `X_FORBIDDEN` for a caller with no actor, or for a `denied(reason, code)` with the app's own code. It is `X_UNAUTHENTICATED`, or that code, as a `PolicyDenialError` |
| 48 | `HttpDenial.status`, `problem.status`, `problem.title` | you type either status as `403`, or assert on them: no actor is 401, and the title is the code's registered title. Type them `DenialStatus` |
| 49 | policy predicates, `definePolicy({ check })` | one returns something other than a boolean or a `PolicyDecision` — `{ allowed: 'yes' }`, an object from another library, nothing. It denies now. Return `true`, `false` or `denied(reason, code)` |
| 50 | `ctx.peer` | you read the client certificate identity behind a proxy. It is `null` until `configureHttp({ trustClientCertHeader: true })` — set it only where the proxy strips or overwrites `x-forwarded-client-cert` |
| 51 | anonymous `POST` / `PUT` / `PATCH` / `DELETE` from a browser | a page on another origin posts to this app without a session — an embedded sign-up form, a marketing site on its own domain. `X_CSRF_BLOCKED` (403). List the origin: `configureHttp({ cors: { origins: ['https://www.example.com'] } })`. Requests with no `Origin` and no `sec-fetch-site` are unaffected |
| 52 | repeated 401s | a client, probe or test sends many requests that fail `auth: 'required'` from one address: past `rateLimit.defaultBucket` they are 429 with `Retry-After`. Authenticate the probe, point it at `/healthz`, or raise the bucket |
| 53 | `/healthz`, `/readyz` bodies on the web role | a monitor off the box reads `buildId`, the in-flight count or the check names. It gets `{ state, ready, role }`. `configureHttp({ healthDetailPeers: ['loopback', 'private'] })`, or an exact address. Probes that read only the status need nothing. The sync role's routes are unchanged for now |
| 54 | `cache-control` set by a handler | it says `max-age=N`, `must-revalidate` or `proxy-revalidate` with no `private`: the response is rewritten as a shared-cache offer would be. For a per-user lifetime write `private, max-age=N` |
| 55 | request bodies | a client sends a non-empty body with no `content-type`. `X_BODY_INVALID` (422). Send `content-type: application/json`; a handler that wants raw bytes reads `bodyBytes()` |
| 56 | `defineHttpConfig` | an embedder relied on `HOSTNAME` to choose the bind address: pass `hostname`. A config with `buildId: null` and `BUILD_ID` set now runs with skew detection off |
| 57 | `E2eBrowser.close()`, `LaunchedBrowser.close()`, `CdpLaunchFailedError` | a test or script calls `close()` without `await`, or reads `closed`: `await browser.close()`. A hand-built `CdpLaunchFailedError` passes `{ executable, attempts }` |
| 58 | **operator action** — `x_users.mfa_secret` | any user has MFA enrolled. Do the three steps under the table, in order. Until `x auth seal-mfa` has run, each enrolled user gets `X_MFA_SECRET_UNSEALED` (500) at the second factor. App code that writes the secret calls `saveTotpSecret(auth, userId, secret)` |
| 59 | `x_auth_failures`, `x_auth_lockouts` | always, after the rollout completes: `x doctor` reports `X_FRAMEWORK_TABLE_ORPHANED`; run `psql "$DATABASE_URL" -c 'drop table if exists x_auth_failures'`. The new `x_auth_lockouts` columns are added at boot. Failure counts restart; live lockouts carry over |
| 60 | a custom `AuthLimiter` | you implement one: replace `assertAllowed` / `recordFailure` with `reserve(key)` and `refund(reservation)` (TS2741). A caller of either removed method calls `reserve` before the check and `refund` on success |
| 61 | `verifyApiKey`, `apiKeyActor` | you call either: read `.record` off the result and pass a store with `findUserById`. A key whose owner is disabled or gone stops working. A key issued with a `userId` that is not an `x_users` id: reissue it without `userId` |
| 62 | API key scopes | a key holds `*` or `<res>:*`, or more than its owner is granted: the extra scopes are dropped. `issueApiKey` with a wildcard is `X_CONFIG_INVALID` — list the scopes. Where users hold roles, pass `apiKeyResolver(store, { grantsOf })` or their keys resolve with no scopes |
| 63 | `X_MFA_REQUIRED` | a client or handler reads `meta.userId` to run the second factor. Read `meta.challenge` and call `completeMfa(auth, challenge, code)` within 5 minutes |
| 64 | `redeemRecoveryCode`, `mfaRequired`, `authNotImplemented` | you import any (TS2305). A recovery code goes to `completeMfa`; throw the challenge with `mfaChallengeRequired(auth, userId)` |
| 65 | a custom `AuthAdapter` | you ship one: implement the eight members TS2741 names. `BuiltinAdapter` and `MemoryAdapter` are the references |
| 66 | `BuiltinAdapter` write errors | you match `X_DB_UNIQUE_VIOLATION` on a user write. Match `X_AUTH_WRITE_FAILED` and read `meta.column` (`email`, `external_id`, `id`) |
| 67 | `oauthLogin` | neither `baseUrl` nor `APP_URL` is set. `X_ENV_MISSING` at the start leg: set `APP_URL` to the app's public origin |
| 68 | `E2eSession.offline()` | an e2e test toggles offline while a page refuses the script — a page mid-navigation, a crashed tab. `X_CDP_CALL_FAILED` where the call used to resolve and leave that page online. Wait for the page to settle, or close it, before `offline()` |
| 69 | `compareValues`, `compareRows`, `matchesFilter`, `isAfterKey` from `@ultimat3/query` | you wrote a custom `SqlSource` or matcher: delete `compareValues` (TS2305) and pass `kindsOf(shape.entity)` as the kinds argument of the other three (TS2554) |
| 70 | a read with `.limit()` | a client pages it past the limit with `.page()` / `?_first=` and a cursor. The listing now ends at the limit: the last page inside it answers `hasMore: false` and `nextCursor: null`. Drop the `.limit()` to page to the end. A cursor a client held across the deploy on a limited read is `X_CURSOR_INVALID` once — restart from the first page |
| 71 | the MCP tool of a `single: true` read | an agent, prompt or test reads `{ rows }` from it. It answers the row itself, or `X_NOT_FOUND`; its `outputSchema` is the row |
| 72 | `adminPermissions`, permissions declared by importing `@ultimat3/admin` | you import `adminPermissions` (TS2305), or your own closed permission set relies on the import having declared `admin:*` before `defineAdmin()` runs: add `...ADMIN_PERMISSIONS` to `definePermissions([...])` |
| 73 | `mutator({ … })` | always, for every mutator: add `idempotent: true` (TS2741; `X_MUTATOR_NOT_IDEMPOTENT` from untyped code). `x g mutator` writes it. Running more than one replica: `configureIdempotency({ scope: 'shared' })` |
| 74 | `openapi.json` | always, if the file is committed: the `Problem` schema gained `instance`, `requestId`, `issues`, `meta` and lost the `code` pattern. `x manifest`, commit. A generated client that validated `code` against the pattern regenerates |
| 75 | `packages/db/schema/` | always, if the dump is committed: `x_idempotency` gains `tx_bound`. `x db gen`, commit. The column itself is added at boot |
| 76 | an idempotent action inside `withTransaction` | a test or caller expects the idempotency record `settled` after a rollback: it is `in-flight`, and the key can be retried. A retry that overtakes a slow first attempt makes that attempt fail `X_IDEMPOTENCY_RESERVATION_LOST` (409) |
| 77 | `postgresIdempotencyStore` | you build the store yourself: add `origin: () => client` and `reclaimAfterMs: requestDeadlineMs` (TS2741). The framework's boot needs nothing |
| 78 | `cache.invalidates`, `bustAfterCommit` | a test reads the cache inside the transaction and expects the bust to have happened, or uses `bustAfterCommit`'s return value unguarded: it is `undefined` when deferred to the commit |
| 79 | the `manifest` step, `x manifest --check` | a script reads `X_MANIFEST_DRIFT` for a missing `x.manifest.json` — it is `X_MANIFEST_MISSING`; or relied on `contract-diff` to report a stale `openapi.json` — the `manifest` step does, as `X_MANIFEST_STALE` |
| 80 | a job whose worker can die mid-run | it declares `retry.attempts: 1`, or relied on being re-claimed after every lapse. A lease that lapses on the final attempt buries the row `dead` (`failed` with `retry.deadLetter: false`), `lastError` `LEASE_LAPSED_FINAL_ATTEMPT`. Raise `retry.attempts`; requeue a buried row with `x jobs retry <id>` |
| 81 | a custom `JobDriver`, `SchedulerState` or `Lease`; a caller of `SQL_CLAIM` / `SQL_SCHEDULER_FIRE` | you ship one: `claim` buries a final-attempt lapse and reports it through `onExhausted`, honouring `dropExhausted`; `fire` lands `watermarkMs`; `Lease` adds `abandon()`. `SQL_CLAIM` binds a fifth parameter and returns buried rows; `SQL_SCHEDULER_FIRE` binds `$4` |
| 82 | `cancel` on a finished job | a script or admin action cancels a `dead`, `failed`, `done` or `cancelled` job: `X_JOB_NOT_CANCELLABLE`. To remove a dead letter: `x jobs rm <id>` |
| 83 | step writes after a lapsed lease | a job body runs longer than its visibility timeout: its next `step` write is `X_JOB_LEASE_LOST`. Raise the job's visibility timeout or split the step. A custom `StepStore.put` accepts the second argument |
| 84 | `enqueue(..., { runId })` | you pass a `runId` that is not a lowercase uuid — an upper-case uuid, a slug, a number as text. `X_ID_INVALID` before anything is staged. Pass `crypto.randomUUID()`, or omit it |
| 85 | a custom `EventBus` / `EventLookup` | you ship one: `purgeExpired()` returns `Promise<number>` and rejects on failure; the lookup adds `now(): Promise<number>` (TS2741 / TS2322) |
| 86 | list cursors, `backfills.list({ runId })`, `retry.attempts` | a cursor's id is not a uuid (`X_JOB_PAGE_INVALID`), a ledger `runId` is not one (`X_ID_INVALID`), or `retry.attempts` is `Infinity` or a fraction. Take the cursor from the previous page; declare a whole number of attempts |
| 87 | a hand-built `RetentionStores`, a reader of `PurgeReport.swept` | you build the stores yourself: add `events` (TS2741). `swept` has a sixth entry, `x_job_events` — read it by name, not by position |
| 88 | **operator action** — the sync websocket's origin rule | always, where `APP_URL` is set on the `sync` role or `allowedOrigins` is passed: a declared origin is the whole allow-list, so it must be the origin the pages are served on. Otherwise every socket is `403 X_SOCKET_ORIGIN_REFUSED`; its `fix:` is the `export APP_URL=…` that admits the origin that asked. Compose requires `APP_URL` on `sync`; the Helm chart sets it from `ingress.host`; `x dev` adds its own web origin to the list. Undeclared, the node admits the origin it was reached on. A hand-built `SocketOriginRefusedError` passes `{ reason, asked, admitted }` |
| 89 | **operator action** — channels declared with params | the app declares one: `x db gen "replica identity full"`, then `x db migrate`. Until then deletes on those channels are not announced, and the replicator logs `replication.channel_identity_partial` |
| 90 | **operator action** — the replication connection | the server asks the replication role for a cleartext or md5 password and the URL's `sslmode` is `prefer` (the default) or `allow`: `X_REPLICATION_FAILED`. Append `?sslmode=verify-full` (or `verify-ca`), move the role to scram-sha-256, or state `?sslmode=disable`. `require` also connects, but verifies no certificate — it protects the password from a passive listener only |
| 91 | `parseEnvelope`, `parseChange`, the bus wire | you read change rows off the bus: `timestamp()` columns are `Date`, `bytes()` columns `Uint8Array` (base64 on the wire). A fleet with `replicator` and `sync` on different majors does not interoperate — deploy both together |
| 92 | a custom `Transport`, `AdvisoryLock`, `ChangeFeed`, `UpgradeTarget`, `UpgradeDeps` | you ship one: add `Transport.onReconnect(listener)`, `AdvisoryLock.onLost(listener)` and `AdvisoryLock.abandon()`, `ChangeFeed.abandon()`, `requestIP(request)`, `healthDetailPeers` (TS2741). `abandon()` is synchronous and writes no goodbye |
| 93 | `/healthz`, `/readyz` bodies on the sync role | a monitor off the box, or any reader whose request carries `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP` or `Via`, reads more than `{ state, ready, role }`. List the reader in `healthDetailPeers` and reach the node directly. Status codes are unchanged |
| 94 | channel guards and subscribes | a subscriber with no actor sat on a channel that declares `row`, or a guard throws a tenancy refusal: the seat is denied (`X_TOPIC_FORBIDDEN`). A guard that throws anything else suspends the seat until a later pass. A channel param value over 128 characters is refused, and a socket holding `maxTopicsPerSocket` latched denials gets no new topic |
| 95 | the offline queue | a write is queued, in flight or being flushed while the principal changes — sign-out, switch of org. It rejects with `X_OFFLINE_QUEUE_ABANDONED` and is not sent. Handle the rejection as any outbox refusal; `useMutation` already rolls its optimistic row back. Not covered: the server does not bind a replayed write to its principal — see [Known gaps](Known-Gaps) |
| 96 | decoded `records.adopt` / `records.remove` / channel `params` | you call `.hasOwnProperty(…)` or rely on `Object.prototype` members on them: use `Object.hasOwn(value, key)` |
| 97 | a catch-all route (`/docs/*path`) | a test or client expects a 404 at the bare prefix (`/docs`, `/docs/`), or the handler assumes a non-empty rest: it is reached with `path: ''`. Handle `path === ''`, or declare a static `/docs`, which still wins the prefix |
| 98 | `revalidate: { ttl }` | an `isr` route's only trigger is a zero-length string — `'0s'`, `'0ms'`, `'0m'`. `X_ROUTE_MODE_INVALID` at registration; the page never expired. Write a positive `ttl`, or `tags`. `parseTtlMs('0s')` is `null` |
| 99 | `NativeReason` | you `switch` over it exhaustively: add `case 'unparsable':` — an `href` or form action no URL parses, left to the browser |
| 100 | CSS modules (`*.module.css`, `*.module.scss`) | always, after a rebuild: every scoped class name changes once — the suffix hashes the compiled CSS. A snapshot holding one updates. An escaped class (`.w-1\.5`) is one key, `styles['w-1.5']`; it was `styles['w-1']`. A word in a declaration or comment (`local(Inter.Regular)`) is no longer a key of `classes` |
| 101 | `CompiledPattern.specificity`, `compilePattern` | you store or compare against a number: it is a positional rank, every value changed, higher still wins — compare two patterns' `specificity`. The regex now also matches a catch-all's bare prefix and a percent-encoded literal |
| 102 | push notification `url` | a sender links a tap to another host or a non-http scheme: the app root opens instead. Link to a page of the app. Only an app handing `generateServiceWorker` a `vapid` key emits the handler |
| 103 | a hand-built `ThemeEnv` | you build one — a test fake, a server env: add `current()` (the document's `data-theme`) and `appDefault()` (its `data-theme-default`), TS2741. A fake that answers `null` for both keeps the OS rule; a wrapper spreads `browserThemeEnv()` |
| 104 | `clearTheme()`, `watchOsTheme()`, `resolveTheme()`, `ThemeToggle` | `theme.defaultMode` is `'light'` or `'dark'` and a user or test expected "System" or an OS change to follow the OS: it returns to that mode and ignores the OS. Set `defaultMode: 'system'` for an OS-following app. A `ThemeEnv` that overrode `prefersDark` with the booted theme — the `bootedEnv()` an `x new` app carries in `apps/web/shared/theme-toggle.island.tsx` — must drop it: under `'system'` it freezes the OS answer at mount. Delete it and render `<ThemeToggle mode="toggle" />` with no `env` |
| 105 | `THEME_INLINE_SCRIPT`, `themeInlineScriptTag`, `themeInlineScriptHash`, `themeInlineScriptCspSource` | you import any (TS2305). Delete the import, the hand-inlined `<script>` and its `sha256-…` in `script-src`; the boot already inlines `themeScript` and admits its hash |
| 106 | `Popover`'s `trigger` | the callback annotates `'aria-controls': string`, or hands it to a prop typed `string` (TS2322). It is `string \| undefined`, absent while closed; spread the control object, or widen the type |
| 107 | `Dropzone`, `FileInput` | a server, an e2e test or a handler expects to receive a file the control refused by `accept`, `maxBytes` or `maxFiles`: the input holds only accepted files, and a pick that refused everything empties it — a `required` control then blocks the submit. Read the refusal from the `onSelect` selection's `rejected` |
| 108 | a hand-written `RateLimitStore` or `RateLimiter` | you ship one: add `peek` (TS2741). A store answers `peek(key, bucket, nowMs)` from the state it keeps — `rateLimitPeek(bucket, refilledTokens(bucket, stored, lastMs, nowMs))`, or `rateLimitPeek(bucket, bucket.capacity)` for a key it holds nothing for — and writes nothing. A limiter forwards `peek(key, bucketName)` to its store |
| 109 | `auth: 'required'` routes behind one address | a probe, a test or a client sends failing credentials from an address others share. Once `rateLimit.defaultBucket` under `unauthenticated\|ip:<address>` is spent, every request from that address to a required route is `429 X_RATE_LIMITED` until it refills — a valid credential included, signed-in users behind the same NAT included. Point the probe at `/healthz`, authenticate it, give it its own address, or raise the bucket |
| 110 | MCP error text from `defineAppMcp` (`errorAudience: 'caller'`) | an agent, prompt or test reads the `cause` of a 5xx code core's `hasPublicCause` does not list — `X_DB_STATEMENT_FAILED` above all. It reads a fixed sentence pointing at the logs, and `fix: x errors explain <CODE> --json` unless the error carries a `callerFix`; `resources/read` error data likewise. Read the cause in the log line or the error monitor. `createMcpServer` defaults to `'developer'` and is unchanged |
| 111 | `db.query` | an agent's query quotes an identifier as `U&"…"`, or calls `query_to_xml*`, `cursor_to_xml*`, `table_to_xml*`, `schema_to_xml*`, `database_to_xml*`, `ts_stat`, `ts_rewrite` or `pg_import_*`: `X_MCP_QUERY_REJECTED`. Spell the identifier plainly; run the inner statement as the query |
| 112 | `surface: 'meta'` and a hand-registered tool | the tool omits `destructive` and writes: it is listed as `query`, was `action`. Declare `destructive: true` |
| 113 | `manage_resource` list calls | a call passes an optional input key the query's `listParams` leaves out (`includeDeleted`, `status_in`): an `isError` result carrying `X_INPUT_INVALID`. Add it to `mcp.listParams`, or call the query's own tool. Required input keys are still admitted |
| 114 | the MCP endpoint, `mcpHttpRoute`, `x mcp serve --transport http` | a client sends missing or wrong bearer tokens from an address an agent also uses: past 20 failures a minute the address is `429 X_MCP_RATE_LIMITED` before `resolveToken` runs, a right token included. Set `rateLimits: { read, write, unauthenticated: <n> }` on `defineAppMcp` or `mcpHttpRoute`. A host of its own that calls `route.handle(request)` without `{ address }` is not metered |
| 115 | `send()` inside `withTransaction` | a handler relied on the mail going out though the transaction rolled back, or a test reads the queue before the commit: the `mail.send` job is staged and published after `COMMIT`, and a rollback sends nothing. A facade installed with `mode: 'required'` refuses a `send()` outside a transaction (`X_OUTBOX_NO_TX`) — wrap the call in a transaction, or pass `{ sync: true }` |
| 116 | mail recipients, `unsubscribeUrl`, the `mail.send` job | a `to`, `cc`, `bcc` or `replyTo` holds a control character, `<`/`>` in the mailbox, or a non-ASCII mailbox: `X_MAIL_ADDRESS_INVALID` at `send()` on every driver — Resend and memory delivered it. Write the domain as punycode; a non-ASCII local part needs another mailbox. An unparseable `unsubscribeUrl` is `X_VALIDATION_FAILED`. Always, where `x.manifest.json` is committed and the app sends mail: `contract-diff` reports `jobs.mail.send.input` until `x manifest` |
| 117 | `packages/db/schema/` | always, if the dump is committed: the boot creates `x_notify_digests` and its indexes. `x db gen`, commit |
| 118 | `x.manifest.json` | always, if the file is committed: every query gains `input`. `x manifest`, commit. The first diff against a file without it reports no change |
| 119 | manifest facts | a declaration publishes `NaN`, `Infinity` or `-0` — a budget, a rate limit, a retry count read from an unset variable: `X_MANIFEST_FACT_INVALID` at `x manifest`, naming `meta.path`. Replace `-0` with `0`, and `NaN` or `Infinity` with a finite number |
| 120 | an entity column's default | a release drops the default of a NOT NULL column: `contract-diff` reports `…hasDefault` as breaking, so the gate is `X_MANIFEST_BREAKING` without a major bump. Keep the default, or bump the major in `package.json` |
| 121 | a hand-written `BudgetStore` | you ship one: add `take(key, tokens, limit)` (TS2741) — add `tokens` only when the total stays at or under `limit`, in one atomic step on the store (a Redis `EVAL`, one conditional `update`), answering `{ taken, spent }` with `spent` read before the take. Never `spent` then `add`: that pair is the race. Another answer is `X_INVARIANT` at the reservation |
| 122 | a hand-written or wrapping `Gateway` | you ship one: implement `callLedger(keys: BudgetKeys)` (TS2741), or pass keys at a `callLedger()` call (TS2554). A wrapper forwards `keys` to the wrapped gateway's |
| 123 | `createGateway({ budget: { actor, org } })` | the ceiling is declared: every `llm()`, `agent()` and hive member with no `scope()` open counts against `actor:<kind>:<id>` and `org:<orgId>` of its caller, so a caller past it is `X_AI_BUDGET_EXCEEDED` where the call ran. Every anonymous caller is one counter. Raise the ceiling or drop it; key each `gateway.scope()` with `budgetKeysFor(actor)` so a scoped and an unscoped call of one actor share a counter. A hive's members also run under the gateway's `request` ceiling now |
| 124 | `agent()` tool failures | the model, a prompt or a test reads the cause of a tool's 5xx code that core's `hasPublicCause` does not list — an app code with no `registerErrorStatus` row counts as 500. It reads `CODE: ` and a fixed sentence, plus a declared `callerFix`. Give a refusal the model should act on a 4xx (`registerErrorStatus({ X_ORDER_LOCKED: 409 })`) or `registerProblemMeta({ X_ORDER_LOCKED: { publicCause: true } })` |
| 125 | `fnv1a` | you import it from `@ultimat3/ai` (TS2305). Use core's `fingerprint`; a 32-bit number is `Number.parseInt(fingerprint(text).slice(0, 8), 16)` |
| 126 | `HashEmbedder` | a vector store, a seeded database or a fixture holds vectors it wrote, or a test pins a ranking or a vector: every vector changes. Re-run `indexDocument` over each document; update the snapshot |
| 127 | an OpenAI-format `finish_reason` | a provider, fake or recorded fixture sends one this build does not know: it reads `max_tokens`, was `end_turn` (or no finish, streamed). An answer that also fails its schema is `X_LLM_TRUNCATED` with no repair turn; `.stream()` throws it. Send `stop` from a fake |
| 128 | vector reads in an org's request | a `search`, `searchText` or `hybrid` runs on a store with no tenant bound — no `scope`, or an `allow` list alone — while the ambient actor has an `orgId`: `X_VECTOR_UNSCOPED` (500). `store.scoped({ tenant: ctx.actor.orgId })`; a deliberate cross-tenant read opens the store with `scope: UNSCOPED` or calls `.scoped(UNSCOPED)`. A comparison against `UNSCOPED`'s old `{}` fails — it is `{ crossTenant: true }` |
| 129 | a hand-written `VectorStore` | you ship one: add `prune(filter, keep)` (TS2741) — delete every in-scope row `filter` matches except the ids in `keep` |
| 130 | `chunk()` metadata | a caller passes its own `metadata.source`: it is overwritten with the document id, the key `indexDocument` prunes by. Store the value under another key |
| 131 | `numericTolerance` | the bound is `NaN`, infinite or negative — often read from an unset variable: `X_INVARIANT` where it is called. Pass a finite bound of at least 0; `0` is exact match |
| 132 | `describeApp`'s `app()` | a test reads it while the `describe` block registers, before `beforeAll`, and asserts `toBeInstanceOf(ReferenceError)`: it is `X_TEST_APP_NOT_BOOTED`. Assert `toBeUltimateError('X_TEST_APP_NOT_BOOTED')`, or read `app()` inside a `test` body |
| 133 | `assertDeterministic` | a test relied on two results differing only in key order failing `X_TEST_NONDETERMINISTIC`: it passes. Results compare by core's `canonicalJson`; a BigInt, Date or Map result compares instead of throwing `TypeError`, a cyclic one by `Bun.deepEquals`. A top-level `undefined`, function or symbol compares by its type: `undefined` then `null` is `X_TEST_NONDETERMINISTIC`. Assert the order itself |
| 134 | `frozenClock(now, body)` | a test counts `onClockMoved` announcements: each call adds two, entering and restoring, so frozen-scheduler lease renewals fire inside and after the body. A listener that throws on entry rejects the call, the body does not run, and the earlier instant is restored. Update the count |
| 135 | `mountIsland` | a test relied on module state carrying from one mount to the next: each mount loads from its own directory, a fresh module instance. Set the state up in each mount |
| 136 | `localBrowser({ options: { args } })` | `args` holds `--proxy-server`, `--proxy-bypass-list`, `--proxy-pac-url`, `--proxy-auto-detect` or `--no-proxy-server` (`-` or `--`, any case), or is not a list of strings: `X_SCRAPE_LAUNCH_ARGS_INVALID` before anything launches, exit configured or not. Set the exit with `localBrowser({ proxy })` or `scrape({ egress })`; the caller's other args are kept and the exit appended after them |
| 137 | `CdpBrowserLike.target()` | you ship a launcher or a test double that hands back a browser without it (TS2741): add `target()` answering `{ createCDPSession() }`, whose session has `send` and `on` (`CdpBrowserSessionLike`). Puppeteer has it. A browser that refuses browser-level `Fetch.enable` fails `open()` with `X_SCRAPE_BROWSER_UNREACHABLE` |
| 138 | a CDP browser with no `cookies()` or `setCookie()` | `session()` on it, or `restore()` of a session holding cookies: `X_NOT_IMPLEMENTED`, was an empty jar or dropped cookies. Use a puppeteer-core that exposes both, or set `auth: { reuse: false }` on the `scrape()` definition |
| 139 | `burnSession(plan, seen)` | you call it with one argument (TS2554): pass `recordVersion(restored)`, the version of the record the run used. A record another run saved since is kept. A hand-written `ScrapeSessionStore` keeps the new optional `SessionState.version` it is handed. A refused login now also tombstones over a record the run found but did not reuse (`reuse: false`, past `maxAge`) |
| 140 | `expect.maxDrop` | the value is `1` or above (`50` for 50%) or negative: `X_INVARIANT` at `scrape()`. Write a fraction in `[0, 1)` — `0.5` |
| 141 | `urlSecretValues`, `redactSecrets` | a log, artifact or snapshot expected every query value and the whole path concealed: only credential-shaped ones are — a query key whose words (split on `_`, `-`, `.`, camelCase) include a credential word (`apiKey` does, `keyboard` does not), a 16+ character value mixing letters and digits, or the id after `/devtools/<browser\|page>/`. `redactSecrets` also redacts each secret's percent-encoded (hex in either case), form-encoded and HTML-escaped spellings. Update the snapshot |
| 142 | headers on the HTTP leg | a declared header shares a name with the session's in another case and a request relied on the two being joined (`BrowserUA, Mine`): the declared one replaces it. Declare the whole value |
| 143 | `allowHosts` wildcards on the HTTP leg and the robots read | a host admitted only by a wildcard resolves to an address that is not public: `X_SCRAPE_HOST_BLOCKED`, and the connection is pinned to the approved address. Add an exact rule for the internal host. Exact rules and proxied runs are unchanged; the browser leg is not pinned |
| 144 | the robots read, `createRobotsGate`, `robotsFetcher` | a site's `robots.txt` redirects more than 5 times, or to a host off `allowHosts` — every hop screened, the first included — or, on a gate built by hand with no `allowHosts`, to any hostname other than the starting one (a subdomain included; a scheme upgrade, its port change and a moved path are followed): the hop is never requested and the read is "no robots", so no rule applies. List the host it redirects to; pass `allowHosts` to a gate built by hand. A `scrape()` run always passes its own |
| 145 | `X_SCRAPE_FIXTURE_STALE` | a recorded fixture's `recordedAt` is not a date and `maxAgeMs` is set: the recording is stale, was fresh. Re-record it |
| 146 | `KeysetBound.value`, `AdminCursor.value` | you ship an `AdminRepo` whose `list` reads `keyset.value` as a string (TS2345 / TS18047): it is `string \| null`, `null` for a NULL sort value, was `''`. NULL sorts as the largest value — last ascending, first descending |
| 147 | the admin edit form, `_version` | a script, a test or a hand-built page posts an edit without the `_version` the form rendered, or after the row changed: `409`, nothing written, a `failed` entry with `admin.error.row-changed`. Post `rowVersion(row)` of the row the edit was made against. `adminUpdate` with no `version` — MCP, a script — is unchanged |
| 148 | `AdminFormProps.version` | you render `AdminForm` yourself (TS2741): pass `rowVersion(row)` for an edit, `null` for a create |
| 149 | `CrudResult` | a `switch` over `kind` is exhaustive: handle `'stale'` — `row` as it is now, `version`, `audit` — which `adminUpdate(…, { version })` answers when the version no longer matches |
| 150 | create and update policies | a rule reads the subject's `input`: an admin create or update is decided again after validation with the written values as `input` (an update beside `row`), so the rule now fires there. A write it refuses is denied and audited as one |
| 151 | `/admin/audit`, a row's history card | an actor with an `orgId` — a test, an operator — expected another org's entries: only its own org's are listed. An actor with no `orgId` still reads every tenant's |
| 152 | an admin action, a set-based `matching` call, a queued batch | a test expects the work to stay written when its audit entry cannot be: on `postgresAuditLog` the work rolls back with the entry, and the log holds one `failed` entry. A queued batch's id is derived from its content, so a retry dedupes onto chunks still live |
| 153 | `?scope=*`, `listHref({ scope: null })` | a list scope is declared as `*`: `X_ADMIN_FILTER_INVALID`, rename it. `listHref({ scope: null })` writes `?scope=*` and opens every row; it opened the default scope |
| 154 | admin list filters | a link or bookmark sends a number filter as a blank, hex (`0x10`), an exponent (`1e3`) or `Infinity`, or a date the calendar lacks (`2026-02-30`): `X_ADMIN_FILTER_INVALID`. Send a decimal or a real day |
| 155 | split sitemap parts | a CDN, an object store, a search console or a link holds `/sitemap-<n>.xml`: the parts are `/sitemaps/<n>.xml` (`SITEMAP_PARTS_DIR`), served by the web role, the index unchanged at `/sitemap.xml`. Rebuild, upload `sitemaps/`, delete or redirect the old files, re-submit the index |
| 156 | `restorePermissions(names, declaredAt)` | you call it with one argument (TS2554): capture `permissionDeclarationSites()` with `knownPermissions()` and pass both back. The one-argument call restored names with no declaration site, which the `policy` step never judges — `X_PERMISSION_BORROWED` was silently off for them. Pass `{}` only when you mean no provenance |
| 157 | `x build --target static --out <dir>` | the directory exists, is not empty and holds no `.x-export`: `X_BUILD_OUT_UNSAFE`, was deleted. An `--out` that is the app root or holds it is `X_BUILD_OUT_UNSAFE`, was `X_CLI_BAD_FLAG`. Empty it once or build to `.x/static` (exempt); every build writes the marker |
| 158 | a static build | a module of the app fails to import: `X_BUILD_FAILED`, the last export left as it was; the build succeeded without that page. `x verify --only manifest --json` lists each module |
| 159 | `x build` flags | `--tag` off the docker target, `--out` on it, or any of `--tag`, `--out`, `--no-preflight` on prebuilt: `X_CLI_BAD_FLAG`, was ignored. Drop the flag |
| 160 | `x g --dry-run` | a script reads `ok` or `data.files`: `ok: false` with the real run's conflicts, and `data.files` lists only what would be written |
| 161 | `x g` and `apps/web/api/index.ts` | the primitive's camelCased file name is already bound in the index — another feature's module, `api`, `defineApi`, `health`: `X_GENERATE_CONFLICT` before anything is written. Run the `fix:` — the same command under a feature-prefixed name |
| 162 | `x g` names | a plural `resource` or `entity` name, a non-ASCII letter, or a name whose type the generated code uses (`promise`, `omit`, `partial`, `row`): `X_CLI_BAD_FLAG`. Run the `fix:` — `x g resource post`, `x g entity uber`, `x g resource promise-resource` |
| 163 | `x affected`, `x test --affected` | a CI job relies on a change under `scripts/`, `guards/`, `bin/` or to `tsconfig.base.json` selecting nothing: any non-doc path no workspace owns is root-wide — every workspace, every test file |
| 164 | test discovery | an app has a directory named `build`, `examples` or `dummy` below its root: its tests run under `x test` and on the gate's steps, `live` and `e2e` included, and may fail. Fix them; only the root's are skipped |
| 165 | `filesize`, `errors`, `i18n` | a `guards/*.ts`, `apps/*/server.ts` or `apps/*/prerender.ts` is over 500 lines or has a `fix:` that is not one runnable command: the gate fails. Split it or make the fix a command. The `i18n` step no longer reads `guards/` |
| 166 | `/robots.txt`, `/sitemap.xml`, `/sitemaps/<n>.xml` on a running web role | a test or an operator expects a change to the app's routes or SEO settings on the next request: each origin's answer is kept an hour, 8 origins at most. Restart the process |
| 167 | `x new`'s `solid-js` | a fresh scaffold pins `1.9.15`, was `1.9.14`. An existing app moves its pin by hand |
| 168 | `x new`'s app `typecheck` scripts | a fresh scaffold's `apps/web` and `apps/admin` run `tsc --noEmit -p ../../tsconfig.json`, the root program: slower, and it reports a type error another workspace's declaration causes. An existing app keeps its scripts until it changes them |
| 169 | the `policy` step | an app action, query or route guard requires a permission only a package declared — `defineAdmin()`'s `<entity>:read\|write\|delete`: `X_PERMISSION_BORROWED`. Add the name to the app's own `definePermissions([...])`; the finding names the file |
| 170 | the `drift` step | a params channel's `records` table or a live query's `subscribes:` table needs `REPLICA IDENTITY FULL` and no migration records it: `X_DB_SCHEMA_UNMIGRATED`. `x db gen "record replica identity full"`, then `x db migrate`. A `subscribes:` name no entity declares is `X_QUERY_SUBSCRIBES_UNKNOWN` |
| 171 | `ProcessRegistrySnapshot` | you build one by hand (TS2741): add `permissionSites` — `permissionDeclarationSites()`, or `{}` |
| 172 | a handler's own `content-security-policy` | a handler sets one — to loosen the app's, or a test reads the header: it is kept and the app's is added beside it, both enforced. Loosen through `security.csp.extend`; read both policies in the test. The report-only header follows the same rule |
| 173 | the `fix:` of `X_ROUTE_NOT_FOUND`, the duplicate-route and mount-conflict errors | a monitor, script or test matches `x routes list --json`: it reads `x routes --json`. Codes unchanged |
| 174 | a serving role's boot, `ROLE=migrate` | a deploy starts `web`, `sync`, `worker`, `scheduler` or `replicator` on an external `DATABASE_URL` before `ROLE=migrate` ran this build, or never runs it: `X_FRAMEWORK_SCHEMA_UNAPPLIED`, the pod refuses to boot. Run `ROLE=migrate` (`x db migrate`) first — the shipped chart's hook and `docker-compose.prod.yml` already do. An embedded database applies its own |
| 175 | `TRUSTED_PROXY_HOPS` | a malformed value: `X_TRUSTED_PROXY_HOPS_INVALID`, was `X_PORT_INVALID`. Write decimal digits, 1 to 64; repoint an alert on the old code |
| 176 | `PORT`, `METRICS_PORT`, `ROLE` | a port written `0x1F90`, `8e3` or `+80`: `X_PORT_INVALID`, was read as a number. Write decimal digits. A blank `ROLE` now boots `web`, where it was refused |
| 177 | `/_storage`, `/media` | a link opens an uploaded file that is not a raster image, audio or video — PDF, SVG, HTML, XML — in a tab: it downloads, with `content-security-policy: sandbox`. Embed images, audio and video as before; link to a viewer page for the rest |
| 178 | `worker`, `scheduler`, `replicator` on SIGTERM | a process relied on `drain.readinessGraceMs` before it stopped claiming: it stops at once. `web` and `sync` keep the grace |
| 179 | the replicator's readiness, the chart | an alert reads a not-ready replicator as an outage, or a chart was written by `x new`: the replicator is ready only while its stream runs (`/readyz?deep=1` on the metrics port), and its metrics Services publish not-ready addresses. Copy the two edits from `docker/helm/templates/_helpers.tpl` and `service.yaml` into a scaffolded chart |
| 180 | `x help <name>` | a script asks for a name no command has: `X_CLI_UNKNOWN_COMMAND`, exit 1 — was the catalogue and 0. Use the name the fix names |
| 181 | `x i18n add`, `x i18n sync`, `x db seed`, `x db backfill` | a run reports a finding — an app module that will not import, included: exit 1, was 0. Fix the module the finding names |
| 182 | `x doctor`, `DoctorProbe` | `PORT` is set and `--port` is not: the probe reads `PORT`, was always 3000. A loopback `APP_URL` on another port is `X_APP_URL_PORT_MISMATCH`, a malformed one `X_CONFIG_INVALID`. A hand-built `DoctorProbe` adds `appUrl: string \| undefined` (TS2741) |
| 183 | the `/_x` dev dashboard | a script runs `GET /_x/db?sql=`, posts from another origin, or reaches `x dev` under a Host that is not loopback: `405 X_METHOD_NOT_ALLOWED`, `X_CSRF_BLOCKED`, `421 X_DEV_HOST_REFUSED`. `curl -sS -H 'accept: application/json' --data-urlencode 'sql=select 1' http://localhost:3000/_x/db` |
| 184 | `x jobs show\|retry\|cancel\|rm\|promote <id>` | the id is not a uuid: `X_JOB_UNKNOWN`, was `X_DB_STATEMENT_FAILED` on Postgres. Pass the job's id |
| 185 | `x shot --out <relative path>` | a script ran it outside the app root: the file lands relative to the cwd, was the app root. Pass the path from where you run it |
| 186 | `x dev`'s `X_PORT_IN_USE` | a script parses the fix: it suggests `--port N+2`, was `N+1` |
| 187 | `x verify merge` | a part's step has no numeric `durationMs` or malformed findings: `X_VERIFY_MERGE_INPUT`. Sharded `files` that repeat a file or do not hash to `corpusHash`: red. Shard every job by one rule — all with `--timings`, or none |
| 188 | MCP `tests.run` | an agent or test read `failed: 0` from a run with an error outside any test, or a non-zero exit: each counts as a failure |
| 189 | `x mcp serve --transport http` | the port is taken: `X_PORT_IN_USE`, with a neighbouring port as the fix, was `X_CLI_UNEXPECTED` |
| 190 | `x routes` | a script passes a word — `x routes list --json`: `X_CLI_UNKNOWN_COMMAND`, exit 1. `x routes --json`, `--surface <s>` to filter |
| 191 | `checkErrorCodesThrown` (`@ultimat3/cli`) | a repository of your own calls it and relied on a reference row saying "not thrown" or "thrown by nothing" to waive a code: the code is `X_ERROR_CODE_UNTHROWN`. Pass the retired codes as the third argument — `checkErrorCodesThrown(root, page, new Set(['X_MY_RETIRED']))`; it defaults to this repository's `UNTHROWN_CODES`. A listed code that is constructed again is `X_ERROR_CODE_UNTHROWN_STALE` |
| 192 | the chart's NetworkPolicy | the cluster's CNI enforces policies and something outside the cluster scrapes `/metrics`, or reaches a port other than `http`: refused. List the scraper in `networkPolicy.metricsFrom`, narrow `networkPolicy.httpFrom` to the ingress controller if you want, or set `networkPolicy.enabled: false` |
| 193 | `tmp.sizeLimit` | a role writes more than 512Mi to `/tmp`: the pod is evicted. A values file that drops `tmp.sizeLimit` does not render. Raise it per your measurement |
| 194 | `existingSecret`, `roles.<role>.existingSecret` | the release-wide `existingSecret` is empty and a role names none of its own: `helm template` fails naming the role. Set one or the other for every role; the migrate Job reads `migrate.existingSecret` |
| 195 | the sync listener at port 0 | a test or tool runs `x dev --port 0`, `startRoles({ port: 0 })` or a scratch server and dials the web port + 1: the sync node is on its own kernel-chosen port. Read `syncUrl` from the boot's answer; pages dial `/_x/sync` on their own origin and are unaffected |
| 196 | `budget.lcp` on `defineRoute` | a route declares `lcp`: a type error, and `X_ROUTE_MODE_INVALID` at `registerRoute`. Delete it from every `budget: { … }`. A reader of `lcp` in `x routes --json`, of `budget.lcp` in `x.manifest.json` or of `lcpMs` in `.x/build-stats.json` drops it |
| 197 | `x test --worker I` | a script passes it: `X_CLI_BAD_FLAG`, exit 1. `x verify --only unit --shard i/n` |
| 198 | `toWireSchema`, `toOutputSchema` (`@ultimat3/mcp`), `mcpSchemaOf` (`@ultimat3/action`), `toMcpInputSchema` (`@ultimat3/schema`) | you import one: not exported. `import { toWireSchema, toWireOutputSchema } from '@ultimat3/schema'`; for a full draft-07 document `toJsonSchema(s, { dialect: 'draft-07', includeDialect: false })` |
| 199 | a tool schema: `.tool().inputSchema`, `@ultimat3/ai`'s `JsonSchema` | you read `format` off it, or build a `ProjectableAction` with `additionalProperties: <schema>`: no `format` is published, and `additionalProperties` is a boolean — write `true`. The action's parse still enforces the format |
| 200 | `defineConfig`'s `name` | the config is JavaScript or untyped and has no string `name`: `X_CONFIG_INVALID` at load. `defineConfig({ name: 'my-app', … })` |
| 201 | `storageNotImplemented`, `dbNotImplemented`, `scrapeNotImplemented`, `JobsNotImplementedError`, `CliNotImplementedError`, `NotImplementedError` (`@ultimat3/pwa`, `@ultimat3/realtime`) | you import one, or catch `X_NOT_IMPLEMENTED` as `instanceof StorageError` or another package base: not exported, and no longer an instance. `import { NotImplementedError } from '@ultimat3/core'`, or match `err.code === 'X_NOT_IMPLEMENTED'` |
| 202 | `readCookie` (`@ultimat3/auth`), `escapeAttribute` (`@ultimat3/seo`) | you import one: not exported. `import { escapeHtml, readCookie } from '@ultimat3/core'` |

Entry 58, **the one step an operator must not skip.** A deployment with MFA-enrolled users:

| Order | Do | Until it is done |
|---|---|---|
| 1 | make the master key exist: `x secrets init`, or set `ULTIMATE_SECRETS_KEY` in the deploy | `X_SEAL_KEY_MISSING` at `login()` for an enrolled user |
| 2 | deploy this release | — |
| 3 | `x auth seal-mfa --json`, once | `X_MFA_SECRET_UNSEALED` (500) at the second factor for every enrolled user; `x doctor` reports the count |

Step 3 answers `{ sealed, alreadySealed, skipped }`. It is idempotent, and `skipped` counts rows
that changed while it ran — run it again and they are `alreadySealed`. A custom adapter calls
`sealMfaSecrets({ adapter })`. A deployment with no MFA users needs none of this.

Entry 39, the orphaned variants. These commands were **not run against a real disk or bucket** for
this page — list first, read the list, then delete. The pattern matches a variant of either shape,
so new-shape variants already written are deleted too and regenerate on the next request. A key
of your own that ends in such a suffix (`photos/team@w640.png`) matches as well.

```sh
# local disk — list, then repeat with -delete in place of -print
find <root> -type f -regextype posix-extended -regex '.*@(full|((w|h|q)[0-9]+|cover|contain)(-((w|h|q)[0-9]+|cover|contain))*)\.(avif|webp|jpg|png)' -print
# their sidecars live under <root>/.meta/ as <key>.json — the same pattern with \.json appended
find <root>/.meta -type f -regextype posix-extended -regex '.*@(full|((w|h|q)[0-9]+|cover|contain)(-((w|h|q)[0-9]+|cover|contain))*)\.(avif|webp|jpg|png)\.json' -print
# s3 — list, then `aws s3 rm s3://<bucket>/<key>` for each key
aws s3 ls s3://<bucket> --recursive | grep -E '@(full|[whq][0-9]+|cover|contain)[^/]*\.(avif|webp|jpg|png)$'
```

### Not breaking, but you will see it

| Surface | What changed |
|---|---|
| a union in HTTP coercion | every member is tried: `t.union(t.literal('auto'), t.number)` reads `'12'` as `12`. A string a member accepts as a string is never converted |
| `SchemaError#toJSON()` | carries `retry: 'terminal'`; a `bigint` or a cycle in `meta` no longer throws |
| image errors | a header declaring a zero, negative, fractional or `NaN` size is `X_IMAGE_DECODE_FAILED`, was `X_IMAGE_TOO_LARGE`. A HEIC (`mif1` only) is no longer sniffed as AVIF |
| OTLP export | an endpoint with a query string keeps it after the signal path; a `NaN` or infinite attribute is dropped |
| `X_VERIFY_STEP_TIMEOUT` | names the test file still running and its `fix:` runs it; `--json` findings gain `meta` |
| `fix:` lines | `X_REGISTRAR_MISSING` / `X_REGISTRAR_CONFLICT` name the owning package; `X_SECRETS_KEY_INVALID` names the key file when the file is what is wrong |
| `x db gen` and a changed `primaryKey` | the migration is written — drop `<table>_pkey`, add the new key, `drop not null` for a declared-nullable column leaving it. `X_MIGRATION_IRREVERSIBLE` for a key another table's foreign key references, and for a new key over a column the same migration adds with no default, or a `null` one: add and backfill the column in one migration, change the key in the next |
| `x tasks` | `next`, `last` and `upcoming` are unchanged in form; they come from `isoInZone` in `@ultimat3/time` |
| db error codes | a syscall error (`EPIPE`, `E2BIG`) is `X_DB_UNAVAILABLE`, was `X_DB_STATEMENT_FAILED`; a ragged array or Invalid Date parameter is `X_INVARIANT` on both drivers, was `X_DB_UNAVAILABLE` |
| `addBusinessDays`, `businessDaysBetween` | the wall time survives a DST day; a date the zone skipped is not counted |
| `Accept-Language` | a `q` that is not a plain decimal ranks 0, not 1 |
| `formatMoney({ trimZeroFraction: true })` | 1250 USD is `$12.50`, was `$12.5`; a whole amount still drops `.00` |
| `robots.txt` | `seo.robots.disallow` is in every group, and a `User-agent: *` group is emitted when none is declared |
| ISR documents | carry `Surrogate-Key` and `Cache-Tag` from `revalidate.tags`; a response rewritten to `private` or `no-store` drops both |
| feeds | Atom gains the channel `<author>`, `<rights>`, `<icon>`; RSS an item author and `<media:content>` for an item `image` |
| storage error codes | a refused write is `X_STORAGE_PUT_FAILED`, a refused read `X_STORAGE_READ_FAILED`, a local-disk key under another key `X_STORAGE_KEY_CONFLICT` — each was a bare error. An empty org is `X_STORAGE_ORG_MISMATCH` (404), was `X_STORAGE_PATH_UNSAFE` (400) |
| `GET /_storage/:disk/*key` | no `Last-Modified` when the disk reports no date |
| the Redis cache tier | one extra round trip before each `load()` and one after the `SET`; a fill whose load outlives 60 s is not written to Redis |
| `transition(column, id, move)` | an `undefined` or `null` id is `X_NOT_FOUND` and moves no row; on Postgres it moved every row in the `from` state |
| entity tests on `memoryDriver()` | a unique declared as `invariant(name, c.unique([...]))` is enforced (`X_DB_UNIQUE_VIOLATION`); `bigint()` refuses a value outside int8; `trimmed()` strips spaces only; `url()` refuses what the column's CHECK refused — each as Postgres already did |
| `update` / `updateWhere` under an app-only invariant | on Postgres a refused write is rolled back; it used to stay written |
| seed `dryRun` | runs every verb in a transaction and rolls back, so its metrics are a real run's and a seed that would fail fails |
| drift findings | each `fix:` is one runnable command, mostly `psql "$DATABASE_URL" -c '…'` then `x db migrate`; for a table outside `public` it sets `search_path` first, and unexpected tables and objects are schema-qualified |
| `X_CSRF_BLOCKED` | title is "an unsafe request that did not prove same-origin"; code and status unchanged |
| 5xx problem documents | a withheld cause carries `callerFix` or `x errors explain <CODE> --json`, never the developer `fix:` |
| `requestTimeoutMs`, `x-request-timeout-ms` | above 2,147,483,647 the config is `X_CONFIG_INVALID` and the header is ignored; both used to time every request out at once |
| redirects | a non-http(s) target is never handed to the client router; the locale-prefix redirect stays on this origin |
| `Set-Cookie` | two set in one request both reach the wire |
| `X_CDP_LAUNCH_FAILED` | Chrome gets a 60 s launch deadline and one retry; the error lists each attempt in `cause` and `meta.attempts` |
| `disableUser` | also revokes the user's live API keys; the result gains `apiKeysRevoked` |
| `updatePrivileges` with a `passwordHash` | ends the user's other sessions; the result gains `sessionsRevoked` |
| OAuth route failures | the body carries one fixed `cause` and `x errors explain <CODE> --json`; the detail is the `auth.oauth.refused` log line |
| OAuth discovery and JWKS | a document answering for another issuer is refused; a key set with no importable key keeps the cached keys |
| `x doctor` | two auth probes: unsealed second-factor secrets, and an orphaned framework table |
| `X_CDP_TIMEOUT` | `meta.reading` says `target-gone`, `lost-in-transport` or `no-answer`, with the frames seen since the call |
| `search()` refusals | `X_INPUT_INVALID` (400), were `X_INVARIANT` (500) |
| entity tests on `memoryDriver()`, again | decimal kinds compare by value: `'2.5'` matches a stored `'2.50'`, `10` matches a `bigint()` column — as Postgres does |
| the typed read client | a `Date` input goes as its ISO instant; an omitted required array reads `[]` |
| `transition()` | declared idempotent; its `id` input follows the entity's key instead of always `t.uuid`, so the published schema of a transition on a non-uuid key changes |
| `.contract()` | checks the registry-wide OpenAPI document; an unregistered `.named()` twin of a registered route is `X_CONTRACT_DRIFT` |
| `ERROR_STATUS` | unchanged for importers; the table now lives in per-tier files |
| `requeue` of an unknown id | `X_JOB_NOT_FOUND` (404) on both drivers; was `X_INVARIANT` on memory, `X_DRIVER_UNAVAILABLE` on Postgres |
| `BulkResult.remaining`, `stats()` | `remaining` counts only what a second call would move; queues are ordered by code unit on both drivers |
| worker logs | new lines `jobs.claim.exhausted`, `jobs.worker.slot-renewal-failed`, `jobs.step.failure-unrecorded`; the claim loop no longer spins during a database outage |
| `x_job_events` | swept by the hourly `x.purge`; no DDL changed in this slice |
| the replicator | a stream that ends is restarted on `retryDelayMs`; a web+replicator process answers `/readyz` 503 while its stream is down or a change is still being refused by the bus; `ReplicatorStats` gains `restarts` and `failure` |
| the page socket | beats every 10 s by default, was 15 s; the node names the real beat in `hello.heartbeatMs` |
| realtime `fix:` lines | nine Postgres-client fixes are `x doctor --json`; a bad `NATS_URL` is named without echoing it |
| records channels | a bus reconnect or a sequence gap sends `replay-gap` on every open records channel, not only to live queries |
| the outbox | a store that cannot be opened or wiped warns `X_LOCAL_STORE_UNAVAILABLE` and queues in memory instead of rejecting for the rest of the tab |
| a zone that is not a string | `X_TIMEZONE_INVALID` from every zoned function in `@ultimat3/time`, was a bare `TypeError` |
| a static route outside ASCII | matches its percent-encoded request (`/precios-espa%C3%B1a`), was a 404; a server declaring one starts, where `Bun.serve` threw |
| ISR regeneration | a render that never settles frees its path after `regenerateDeadlineMs` (default 30,000); a render slower than that overlaps the next one, and its late page is dropped when a newer one started |
| ISR route lookup | a stored path is filed under the most specific matching route, as the request router picks it, not the first in table order |
| the client router | a reload or full-load Back lands at the saved offset; the page can enter the back/forward cache; `<a href="#">` is the browser's; form line breaks go as CRLF; an aborted navigation's stylesheets are retired. Router script +774 B raw |
| render refusals | a non-text `prerender()` item or param is `X_PRERENDER_FAILED`, `asset()` of a non-string `X_ASSET_MISSING`, a non-string island resolver answer `X_ISLAND_INVALID` — each was a bare `TypeError` |
| `display_override` | follows `display`: `fullscreen` → `fullscreen, standalone, minimal-ui`; `minimal-ui` → `minimal-ui`; `browser` → none; `standalone` unchanged |
| the service worker | a non-JSON push body is the notification text; the install fill skips another build's stamped answer; route rules match encoded literals and a catch-all's bare prefix, in the request router's order — `sw.js` changes once |
| `personalPages: 'last-member'` | a personal page declaring `offline: 'precache'` is kept in the member's partition; it was never kept |
| the boot's theme script | stamps `data-theme-default` too: 52–54 B longer, a new `script-src` hash the boot admits itself. `BUILD_STATS_RULES` is 4, so an old `.x/build-stats.json` is stale until `x build --target static` |
| `<QrCode>` | every code changes its modules — it now decodes; each was unreadable. A snapshot of its markup updates |
| `DataTable` | leaves its error or empty state when the query recovers; those states now render inside the table's wrapper, which carries `class` |
| `defineTheme()` | a role overridden in light only is answered with the shipped dark channels in the dark media block; that brand's CSS and `brandStyleCspSource()` hash change |
| `createFormBinding` | a local `validate` that throws or rejects is a failed submit, not a `submit()` that rejects and stays `submitting` |
| `CommandPalette`, `Tooltip`, `Popover` | centred under `dir="rtl"`; `Popover`'s inline placements sit beside the anchor, and `align` applies to `block-*` placements only; the vertical `Tabs` indicator mirrors |
| `useId` in an island | `<prefix>-<scope>-<n>` with a per-bundle random scope; server ids unchanged |
| `Textarea` in an island | sets `.value`; the leading newline is written on the server only |
| `RelativeTime`, `BarChart`, `linkTarget`, `Meter` | "1 hour ago", was "60 minutes ago"; bars still drawn from 201 points; `//host`, `HTTPS://…` and a leading space are external; `aria-valuenow` clamped to the drawn bar |
| the icon generator | a non-JSON body or a malformed node is `X_UI_INVALID_VALUE`; `bun run --filter @ultimat3/ui icons --bump` moves the pin and regenerates |
| a `.pattern()` with flags | its JSON Schema carries `x-ultimate-pattern-flags` beside `pattern`, in OpenAPI and MCP `inputSchema`; the input's fact in `x.manifest.json` moves with it, so step 45 covers it. MCP argument validation applies the flags — `/^[a-z]+$/i` accepts `ABC` |
| `db.query` | a column named like a keyword plus digits (`set2`) is read, was refused as `SET` |
| outgoing mail headers | `Reply-To` encodes a non-ASCII display name; an ASCII one holding a special is quoted (`"Doe, Jane" <jane@x.test>`); `List-Unsubscribe` is punycode and percent-encoded. `X_MAIL_HEADER_INVALID` gains `meta.reason` |
| `SMTP_URL` | a `%` in the user or password that starts no escape is `X_CONFIG_INVALID`, was a bare `URIError` |
| `registeredMails()` | ordered by code unit, as `registeredMailIds()` is |
| notify fan-out | a recipient id named twice is delivered once; it failed `X_STEP_DUPLICATE` part-way through the audience |
| `x.purge` | sweeps `x_notify_digests` windows closed longer ago than `PgDigestStore.retentionMs` (7 days); `PurgeReport.swept` has seven entries — read them by name |
| `BudgetStore` traffic | an `actor` or `org` counter is written only where that ceiling is declared — an app with no `budget` writes nothing. Under a declared ceiling the default `MemoryBudgetStore` holds one counter per caller who spent, per process (no window; a counter that returns to zero is deleted; `size()` reports the count). A daily or monthly ceiling needs a shared store whose keys expire |
| `llm()` / `agent()` with a non-object `output` | `respond`'s schema is `{ value: <output> }`; the answer comes back unwrapped, and a prose answer that is not JSON is taken as the text |
| the gateway response cache | every key is a 16-hex `fingerprint` over the whole request, tools included, so every entry misses once; a failed `cache.set` is the log line `ai.cache.write_failed`, the answer still returned |
| the semantic cache | an entry is written under `<prompt hash>:<fingerprint>`; lookup is by embedding, so stored entries still answer — unless `HashEmbedder` wrote them (entry 126) |
| `estimateTokens`, `reserve` | the completion is capped at the model's `maxOutput`, so a `maxTokens` above it reserves less |
| provider failure details | read to 4 KiB, 300 characters shown, on every transport; `RemoteEmbedder` scrubs its key from them |
| eval regressions, `numericTolerance(0)` | both sides and the drop rounded to 3 decimals, so a drop of exactly `tolerance` passes; an exact match at `tolerance: 0` scores 1, was 0 |
| `chunk()` | no chunk exceeds `size`: the carried overlap yields to a unit it does not fit beside, so a re-index may cut differently |
| the install | `@ultimat3/ai` depends on `@ultimat3/http` |
| island mount cleanup | the `disposeLiveIslands` file-boundary hook ships with the island fixture, not `@ultimat3/testing/preload`: any preload that installs the leak guard runs it. Each mount's scratch directory goes on dispose, on a throw, or at the next file boundary — none left in the temp root |
| island template parsing | `<!>` and `<!-- … -->` are one empty node; `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;` and numeric references are decoded once in text and attributes — a reference to 0, a surrogate or past U+10FFFF is U+FFFD |
| a failed scrape session save | after a successful login it is the log line `scrape.session.write_failed` (`step: 'session.save'`) and the attempt goes on; it failed the run |
| admin list paging | rows sharing a sort value are neither skipped nor repeated at a page boundary, and a backward page answers rows; relation labels resolve every id on the page |
| an admin datetime edit | a field left untouched is left out of the patch, so its stored seconds and sub-seconds survive |
| admin search | a repo that throws lists its resource under `skipped` (`admin.search.skipped.failed`), not a failed search |
| the timeline and cache dev panels | only `DevSourceUnavailableError` is drawn as "unavailable"; any other error from a source is thrown |
| `BATCH_QUEUED_REASON` | declared in `batch-queue.ts`, still exported from `@ultimat3/admin` |

### Where the sites are

```sh
grep -rnE "\.default\(" apps packages --include=*.ts --include=*.tsx
grep -rnE "retry\(|retryDecision\(|createFlightGate\(|withChildContext\(|allowHosts" apps packages --include=*.ts --include=*.tsx
grep -rnE "LOG_LEVEL|ULTIMATE_CURSOR_SECRET|OTEL_(EXPORTER_OTLP_(TRACES|METRICS)_HEADERS|TRACES_SAMPLER)" docker .github apps packages
grep -rnE "(ssl|enabled|expose): *process\.env" apps packages --include=*.ts
grep -rnE "withTransaction\(" -A12 apps packages --include=*.ts | grep -E "catch|Promise\.all|isolation|readOnly|deferrable|client:"
grep -rnE "formatRelative\(|addDaysInZone\(|formatDuration(Iso)?\(|cron: |expiresAt|reportEveryMs|introspect\(|\.generated\b|DriftKind" apps packages --include=*.ts --include=*.tsx
grep -rnE "promoteAttachment\(|\.lastModified|implements StorageDriver|: StorageDriver = |canonicalRequest\(|signConstraints\(|variantKey\(|fitDimensions\(|\.get\(|allowedContentTypes|responsiveImage\(|usableWidths\(|declareTags\(|revalidate:" apps packages --include=*.ts --include=*.tsx
grep -rnE "assertAllowed\(|X_FORBIDDEN|definePolicy\(|status: 403|\.preload\(|dbDrift|ENTITY_ERROR_CODES|: Driver = |implements Driver" apps packages --include=*.ts --include=*.tsx
grep -rnE "ctx\.peer|trustProxy|cache-control|defineHttpConfig\(|healthz|readyz|\.close\(\)|\.closed\b|CdpLaunchFailedError" apps packages docker .github --include=*.ts --include=*.tsx --include=*.yml --include=*.yaml
grep -rnE "mfaSecret|redeemRecoveryCode|mfaRequired|authNotImplemented|verifyApiKey\(|apiKeyActor\(|actorFromApiKey\(|issueApiKey\(|apiKeyResolver\(|assertAllowed\(|recordFailure\(|implements AuthAdapter|: AuthAdapter = |: AuthLimiter = |X_DB_UNIQUE_VIOLATION|oauthLogin\(|meta\.userId" apps packages --include=*.ts --include=*.tsx
grep -rnE "compareValues|compareRows\(|matchesFilter\(|isAfterKey\(|adminPermissions|single: true|\.limit\(|_first=" apps packages --include=*.ts --include=*.tsx
grep -rnE "mutator\(|postgresIdempotencyStore\(|configureIdempotency\(|bustAfterCommit\(|invalidates:|X_MANIFEST_DRIFT" apps packages scripts .github --include=*.ts --include=*.tsx --include=*.yml
grep -rnE "attempts: 1\b|cancelJob\(|\.cancel\(|runId:|purgeExpired|EventLookup|SQL_CLAIM|SQL_SCHEDULER_FIRE|RetentionStores|\.swept|implements JobDriver|: JobDriver = " apps packages scripts --include=*.ts --include=*.tsx
grep -rnE "APP_URL|SYNC_URL|sslmode|allowedOrigins" docker .env.production .github 2>/dev/null
grep -rnE "NativeReason|\.specificity|compilePattern\(|ttl: *'0|/\*[A-Za-z]+|notificationclick|showNotification" apps packages --include=*.ts --include=*.tsx
find apps -type d -name '[[]...*[]]'
grep -rnF '\.' apps --include='*.module.css' --include='*.module.scss'
grep -rnE "channel\(|parseEnvelope\(|parseChange\(|implements Transport|: Transport = |AdvisoryLock|UpgradeTarget|hasOwnProperty\(|OfflineQueue" apps packages --include=*.ts --include=*.tsx
grep -rnE "ThemeEnv|prefersDark|clearTheme\(|watchOsTheme\(|THEME_INLINE_SCRIPT|themeInlineScript|aria-controls|<Dropzone|<FileInput|defaultMode" apps packages --include=*.ts --include=*.tsx
grep -rnE "RateLimitStore|RateLimiter|defaultBucket|rateLimits|errorAudience|mcpHttpRoute\(|\.handle\(|destructive|listParams|createJobsFacade\(" apps packages --include=*.ts --include=*.tsx
grep -rnE "send\(|replyTo|cc:|bcc:|unsubscribeUrl|SMTP_URL" apps packages docker --include=*.ts --include=*.tsx --include=*.yml --include=*.env*
grep -rnE "BudgetStore|callLedger|createGateway\(|\.scope\(|fnv1a|HashEmbedder|finish_reason|VectorStore|\.scoped\(|UNSCOPED|chunk\(|indexDocument\(|numericTolerance\(|agent\(" apps packages --include=*.ts --include=*.tsx
grep -rnE "describeApp\(|ReferenceError|assertDeterministic\(|frozenClock\(|onClockMoved|mountIsland\(" apps packages --include=*.ts --include=*.tsx
grep -rnE "localBrowser\(|args:|CdpBrowserLike|burnSession\(|maxDrop|urlSecretValues|redactSecrets|allowHosts|createRobotsGate\(|robotsFetcher\(|recordedAt" apps packages --include=*.ts --include=*.tsx
grep -rnE "existingSecret|sizeLimit|networkPolicy|metricsFrom|port: 0|--port 0|syncUrl" docker deploy helm charts apps packages --include=*.yaml --include=*.yml --include=*.ts --include=*.tsx
grep -rnE "ROLE=|migrate|TRUSTED_PROXY_HOPS|METRICS_PORT|PORT=|readinessGraceMs|readinessProbe|content-security-policy|/_storage|/media|/_x/db|x routes list|x help |DoctorProbe|tests\.run|x verify merge|x shot" docker .github apps packages scripts --include=*.ts --include=*.tsx --include=*.yml --include=*.yaml --include=*.tpl --include=*.sh
grep -rnE "sitemap-[0-9]|restorePermissions\(|ProcessRegistrySnapshot|--out|--tag|--no-preflight|--dry-run|--affected|solid-js|\"typecheck\"" apps packages scripts .github --include=*.ts --include=*.tsx --include=*.json --include=*.yml
grep -rnE "keyset\.value|AdminCursor|<AdminForm|CrudResult|adminUpdate\(|_version|listHref\(|scope=|scopes:|definePolicy\(" apps packages --include=*.ts --include=*.tsx
```

Tier 0: the `typecheck` step finds none of 1–16 — every entry is a value, not a type. A typed
`app.config.ts` already refused most of entry 6 at compile time; the ones it did not are
`'/'`-less paths, empty lists and a locale spelled twice. Entries 4 and 6 throw at the first import;
7 and 16 at boot; 8 and 9 where the call is made. Entries 1–3, 5, 10 and 11 need the unit,
contract and e2e suites; 12–15 need a read of the deploy environment and the monitor.

Tier 1: the `typecheck` step finds 20, and 18, 26 and 28 where a literal, a `switch` or a string
read exists. Entries 19 and 30 throw at the first import of the declaring file; 24 and 31 at the
call. It finds none of 17, 21–23, 25, 27 or 29 — run the unit, contract, job and live suites, and
read every `catch` and every `Promise.all` inside a `withTransaction` body.

Slice 03: the `typecheck` step finds 35, 36, 37 and the changed signatures of 41. Entry 43 throws
at registration and 33 where the response is built. It finds none of 32, 34, 38, 39, 40 or 42 —
run the unit, contract and e2e suites, and do step 13 by hand after the deploy.

Slice 04, entity and policy: the `typecheck` step finds 44, 45 and a `403`-typed status in 48. It
finds none of 46, 47 or 49, nor a test asserting on 48's status or title — run the unit, contract
and policy suites.

Slice 04, http and testing: the `typecheck` step finds a read of `closed` and a
`CdpLaunchFailedError` built with `detail` (57). It finds none of 50–56 and no unawaited
`close()` — run the unit, contract and e2e suites, and read the deploy's proxy, probe and monitor
configuration for 50, 52 and 53.

Slice 05, auth: the `typecheck` step finds 60, 64, 65 and the changed shapes of 61. `x doctor`
finds 58 (the count of unsealed rows) and 59. Nothing finds 62, 63, 66 or a missing `APP_URL` (67)
before a request does — run the unit, contract and e2e suites and sign in once with an MFA user
after step 20. The e2e suite finds 68.

Slice 06, query, mcp and admin: the `typecheck` step finds 69 and the removed `adminPermissions`
of 72. It finds neither 70, 71 nor a permission set that leaned on the import — run the unit,
contract and e2e suites.

Slice 06, action and cli: the `typecheck` step finds 73 and 77. The gate finds 74 and 79 (the
`manifest` step) and 75 (the `drift` step). It finds neither 76 nor 78 — run the unit, contract
and job suites.

Slice 07, jobs: the `typecheck` step finds the interface members of 81, 85 and 87. It finds none
of 80, 82, 83, 84 or 86, nor an unbound statement parameter in 81 — run the unit and job suites,
and do step 30 by reading.

Slice 08, realtime: the `typecheck` step finds 92. Nothing finds 88–90 before the deploy does —
they are steps 32–34, done by reading the deploy's environment. Entries 91 and 93–96 need the unit,
live and e2e suites; 91 also needs both roles deployed together.

Slice 09, http, render and pwa: the `typecheck` step finds 99. Entry 98 throws at registration. It
finds none of 97, 100, 101 or 102 — run the unit, contract and e2e suites after a fresh `x build`,
and read each push sender's `url` for 102.

Slice 09, ui: the `typecheck` step finds 103, 105 and an annotated or `string`-typed trigger in 106.
It finds neither 104 nor 107 — run the unit and e2e suites after `x build --target static`, and
read `theme.defaultMode` in `app.config.ts` for 104.

Slice 10, first half — http, mcp, mail, notify and manifest: the `typecheck` step finds 108. The
gate finds 116's job schema and 118 (the `manifest` and `contract-diff` steps), 117 (the `drift`
step), 119 at the first manifest build and 120 at `contract-diff` the day a default is dropped.
It finds none of 109–115 or 116's recipient rule — run the unit, contract, job and e2e suites,
and read the deploy's probes and agents for 109 and 114.

Slice 10, ai: the `typecheck` step finds 121, 122, 125 and 129. Entry 131 throws where
`numericTolerance` is called — an eval file's import — and 128 at the first unscoped read in an
org's request. It finds none of 123, 124, 126, 127 or 130 — run the unit, eval and e2e suites, read
the gateway's `budget` before the deploy for 123 (step 49), each agent tool's thrown codes for
124, and re-index what `HashEmbedder` wrote for 126.

Slice 11, testing and scraping: the `typecheck` step finds 137 and a one-argument `burnSession`
(139). Entry 140 throws at `scrape()` — the declaring file's import — and 136 when the browser
launches. It finds none of 132–135, 138 or 141–145 — run the unit, job and e2e suites, and read
each `allowHosts` wildcard and each site's `robots.txt` redirect for 143 and 144.

Slice 11, admin: the `typecheck` step finds 146, 148 and 149. Entry 153's `*` scope throws where
the resource is declared. It finds none of 147 or 150–152, nor 154's links — run the unit, contract
and e2e suites, read each policy rule over `input` for 150, and each script that posts an edit form
for 147.

Slice 12a, seo, policy, cli and testing: the `typecheck` step finds 156 and 171. The gate finds
169 (the `policy` step), 170 (the `drift` step) and 165 (`filesize`, `errors`); 164 is a test that
now runs. `x build` finds 157–159 and `x g` 161–162 at the call. Nothing finds 155, 160, 163 or
166 — read the sitemap's host, each script that reads `x g --dry-run` or `--affected`, and each
check that expects a fresh SEO answer. 167 and 168 change only a fresh scaffold.

Slice 12b, http and cli: the `typecheck` step finds 182's `DoctorProbe`. Entries 174–176 stop the
boot — 174 on every serving pod until `ROLE=migrate` ran, which is step 65, done before the deploy.
Each command in 180, 181, 183–187, 189 and 190 refuses at the call. Nothing finds 172, 173, 177,
178, 179 or 188 — run the unit, contract and e2e suites, and read each handler's CSP, each link to
an upload, the chart's replicator and each monitor that matches a fix string.

Slice 13a, cli: nothing finds 191 but the call — a repository of your own that runs
`checkErrorCodesThrown` reads its findings once after the upgrade.

Slice 13b, the chart: `helm template` finds 193's missing `tmp.sizeLimit` and 194's role with no
Secret — before the deploy, if it runs in CI. Nothing finds 192 but a scraper that stops reading,
nor 195 but a dial that is refused — read each values file and each port-0 test.

## 22.x → 23.0.0, entry by entry

**Sixty-six entries**, the `23.0.0` section of `CHANGELOG.md`, in its order — which is the order
an existing app meets them.

### What changed for an agent

Six things an agent-written app does differently from 23.0.0 on. Each is the idiom the
generators now emit, so copying generated code copies it.

| Do | Instead of | Read |
|---|---|---|
| read and write through the typed handle: `db.<table>.where({ id }).one()`, `repo.list(limit)` | `sql` template literals and an `orgId` argument in `repo.ts` — the handle scopes every read to the actor's org | [Entities and migrations → The repo](Entities-And-Migrations#the-repo) |
| call the server from an island through `browserClient` / `browserQueries` (`apps/web/shared/browser-client.ts`) | `fetch(` — the gate refuses it | [Client data](Client-Data) |
| store a credential in a `text().sealed()` column | a plaintext column, or a vault of your own | [Entities and migrations](Entities-And-Migrations) |
| record a run's ending in `onSettled` | a status column written from the body, or a second job that polls | [Jobs and workflows](Jobs-And-Workflows) |
| keep the tests `x g` emits, and raise the floor in `x.verify.json` when coverage rises | deleting an emitted test, or a floor nobody states | [Testing → Coverage](Testing#coverage) |
| operate the queue at `/admin/jobs`, and give an operator a screen by declaring `resources:` / `actions:` (`when`, `batch`) on `defineAdmin()` | a hand-written jobs page, or an admin page per operation | [Admin dashboard](Admin-Dashboard) |

### The upgrade, top to bottom

Run each step; the entries it closes are in the last column.

| # | Do | What you see until you do | Entries |
|---|---|---|---|
| 1 | pin every `@ultimat3/*` to the one new version, `bun install` | nothing yet — a mixed install is untested | — |
| 2 | add `RUN bun node_modules/@ultimat3/cli/src/bin.ts build --target prebuilt` to `docker/Dockerfile`, after the runtime stage's `COPY . .`, above `ENV NODE_ENV=production` | every web pod logs `X_IMAGE_NOT_PREBUILT` at boot and compiles every island and stylesheet | 1, 2 |
| 3 | `x db gen`, then commit `packages/db/schema/` and `packages/db/.gitattributes` | the `drift` step is `X_SCHEMA_DUMP_DRIFT` | 3–6 |
| 4 | `x verify --only unit --json`, then paste the `coverage` line its finding carries into `x.verify.json` | the `unit` step is `X_COVERAGE_FLOOR_UNSTATED` | 7–10 |
| 5 | rewrite each raw request the `boundaries` step names (table under entry 11) | `X_BROWSER_TRANSPORT_BYPASS` / `X_BROWSER_SERVER_BARREL`, one finding per site | 11, 12 |
| 6 | `git mv` a `defineAdmin()` under `apps/*/src/` to `apps/admin/app/admin/admin.ts`; then `x manifest` and commit `x.manifest.json` | the `manifest` step is `X_ADMIN_UNSCANNED`, then `X_MANIFEST_DRIFT` | 13, 14 |
| 7 | `x doctor --json`, then `x g guard <name>` for each name in `data.guards.missing` you adopt, and fix what `x verify --only boundaries` reports | nothing — upgrading installs no guard | — |
| 8 | drop `--feature <other>` from `x g resource` and `--live` from every `x g` but `query` in your scripts; read `x tasks --json` rows by key; `git mv apps/admin/src/pages apps/admin/app/admin/pages` | `X_CLI_BAD_FLAG` | 17–22 |
| 9 | `bun run typecheck` and fix each job, driver, export, scraping, admin and type-union site it names | TS2741 / TS2345 / TS2339 / TS2353 at each hand-built literal, driver, store or option | 23–43, 55–57, 63, 64 |
| 10 | delete the admin host: every `page.tsx` under an admin URL — `/admin/jobs` included — the `AdminRepo` adapter, the admin action routes, a hand-written jobs nav item; declare `defineAdmin({ entities, db })` | `X_ADMIN_REPO_UNBOUND` at load, `X_ROUTE_DUPLICATE` for each page file, `X_ADMIN_PAGE_PATH_INVALID` for a `pages:` entry under `/jobs` | 49–55 |
| 11 | `x verify --only policy,i18n`, then grant every permission it names in the role map and add every admin key it names to each non-`en` catalog | `X_PERMISSION_UNGRANTED`, one per permission a mounted admin route asks for; `X_CATALOG_MISSING_KEYS` per locale | 15, 16 |
| 12 | `x verify --only unit,job` and fix the tests it fails | a test that leaned on `runJobs` calling the body directly or on a lease that never renewed, an event published in `beforeAll`, a row action's old redirect, an admin write or action the row scope now refuses, a social tag on a `noindex` page | 44–46, 48, 58–61 |
| 13 | `x secrets init` where no master key exists; correct any credential a site had refused before the first scrape | `X_SEAL_KEY_MISSING` before the browser opens; every stored session is logged in again | 62, 65, 66 |
| 14 | `x verify` | green, or a finding whose `fix:` is the edit — `X_PACKAGE_SHAPE` for a published package's fixture | 47 |

### Entry by entry

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | the app image | your `docker/Dockerfile` predates 23.0.0. `x build --target docker` no longer writes `.x/islands/`; the store is built inside the image. Add the step-2 line. `app.config.ts` must import with no deployment environment while `NODE_ENV` is unset — the line runs above `ENV NODE_ENV=production` |
| 2 | `ROLE=worker`, `ROLE=scheduler` | a job reaches a `defineService`, `defineStorage` or `defineCatalogs` only through a module that also imports a component. Import that module from `apps/web/api/index.ts`. The image needs `x.manifest.json` and a stamped `BUILD_ID` for the smaller load; without either the role imports everything and logs the fix. A gap is `X_ROLE_LOAD_INCOMPLETE`, at boot and in the `manifest` step |
| 3 | `packages/db/schema/` | the app has a migration. Step 3. A release that changes a framework table changes `framework/`, and this one does: `x_jobs`, `x_outbox`, `x_scheduler_state`, and four new tables (`x_job_pauses`, `x_job_workers`, `x_job_counters`, `x_admin_audit`). `x db gen` needs `@electric-sql/pglite`: `bun add -d @electric-sql/pglite   # then: x db gen` |
| 4 | an extension the embedded database does not ship (`vector`, `postgis`) | a migration creates one. Set `TEST_DATABASE_URL` (or `DATABASE_URL`) to a server that has it, with a role that may create a database, in CI and wherever `x db gen` runs. Contrib extensions (`citext`, `pgcrypto`, …) need nothing |
| 5 | `x db gen`'s exit code | a script treats exit 1 as "nothing written". It now exits 1 after writing the migration when the dump fails; the cause names the migration — keep it |
| 6 | `x db migrate`, `DriftKind` | your dev database holds a trigger, function, view, type or sequence no migration creates (`unexpected-object`, `X_DB_DRIFT`) — add the migration or drop the object. An exhaustive `switch` over `DriftKind` adds `case 'unexpected-object':` |
| 7 | `x.verify.json` `coverage` | always. Step 4. Under 95 the line needs a `"why"`; an `exclude` entry is `{ "glob": "…", "why": "…" }`. Keep the floor at the measured number — it is `X_COVERAGE_FLOOR_STALE` once the tree passes it by 1.5 points, and `X_COVERAGE_BELOW_FLOOR` names the ten worst files when it drops |
| 8 | a slow gate step | a step runs past 8 minutes (`unit`, `contract`, `live`, `job`, `e2e`, `eval`) or 5 (every other): `X_VERIFY_STEP_TIMEOUT`. Raise one with `"stepTimeoutMs": { "unit": 900000 }` in `x.verify.json` |
| 9 | `x verify --json` in a pipeline | you parse `2>&1` as JSON. Read stdout only; stderr carries one `{"step","ok","ms"}` line per finished step |
| 10 | test-order dependence | a unit test relied on which files shared a `--parallel` worker. The step runs slices of at most 16 files, one process each |
| 11 | `fetch(`, `new WebSocket(`, `new XMLHttpRequest(`, `new EventSource(` in browser code | any `*.island.tsx`, anything that calls `clientTransport`/`pageClient`, or anything they import holds one. The finding names the line; rewrite with the table below |
| 12 | a value import of `@ultimat3/entity` / `@ultimat3/query` in browser code | import `@ultimat3/entity/record` or `@ultimat3/query/client`; `import type` is unaffected |
| 13 | `x.manifest.json` | always: step 6. It gains an `admin` section (each resource's filters, sorts, scopes, row scope, `sections`, `formGroups`, `related`, `actions`, and the audit store's `kind`), a `concurrency` member on a job that declares one, `onSettled: true` on one that declares that |
| 14 | `defineAdmin()` under `apps/*/src/` | your admin is declared there — the reference app's was. No boot imports that directory, so `/admin` was never mounted; the `manifest` step now says so: `X_ADMIN_UNSCANNED`. `git mv apps/admin/src/index.ts apps/admin/app/admin/admin.ts`, repoint its relative imports, `x verify --only manifest` |
| 15 | the `policy` step and a mounted admin | a role should open the admin but the role map does not grant every permission its routes ask for. Each one is `X_PERMISSION_UNGRANTED`, one finding per permission per mount: grant `admin:read` and `<table>:read\|write\|delete` — and `job:read` / `job:manage` for the jobs dashboard, `audit:read` for the audit screen — in the role map |
| 16 | the `i18n` step and a mounted admin | a locale lacks a key a mounted admin renders — resource titles, field labels, sections, scopes, columns, the nav, action labels (`admin.action.<name>` with no `labelKey`) and their input labels, the branding key: `AdminApp.catalogKeys()`. The step was green while the page drew `⟦admin.<table>.title⟧`; it is now `X_CATALOG_MISSING_KEYS` naming each. `en` is answered by the framework's catalog; a non-`en` app adds the framework admin keys to its own |
| 17 | `x g entity`, `x g resource` | you generate after upgrading. New repos read through `db.<table>`, export `list(limit)` (was `listByOrg(orgId, limit)`), and refuse a read under an actor with no org (`X_TENANCY_ACTOR_ORG_REQUIRED`). Existing repos keep working. The first `x g entity` in an older app writes `packages/db/src/client.ts` and exits with `X_DB_HANDLE_UNREGISTERED` naming the line for `packages/db/src/index.ts` |
| 18 | `x g resource <name> --feature <other>` | a script passes it. Drop the flag (`X_CLI_BAD_FLAG`) |
| 19 | `x g <kind> --live` for any kind but `query` | a script passes it. It was ignored on a resource (whose list query is already live); it is `X_CLI_BAD_FLAG`, fix `x g query <name>-feed --feature <name> --live` |
| 20 | a query `x g query` / `x g resource` generates | you generate after upgrading. The read takes `{ limit }` — no `orgId` input, no `.where({ orgId })`: the org is the actor's, scoped by the typed handle. The generated `can<X>Read` checks only that the actor has an org. Already-generated slices keep working; a caller of a newly generated one passes `{ limit }` |
| 21 | `x g admin:page` | a script or doc expects `apps/admin/src/pages/`, which the app scan never imported. It writes `apps/admin/app/admin/pages/` by default: `git mv apps/admin/src/pages apps/admin/app/admin/pages`, then update the import in `apps/admin/app/admin/admin.ts` |
| 22 | `x tasks` | a script runs it with no queue reachable, or reads `--json` rows by position. It opens the queue when a task is declared; rows gain `lastMs`, `last`, `lastFiredAtMs` |
| 23 | `<job>.run({ … })` by hand | a test calls it. Add `finalAttempt: isFinalAttempt(<job>.retry, attempt)` and `progress: () => undefined` |
| 24 | a hand-built job literal or exhaustive `switch` | over `JobOutcome` (`'refused'`, `'dropped'`), `QueueStats` (`failed`), `WorkerStats` (`refused`, `dropped`, `pollDelayMs`), `JobHandle`, `JobDescriptor`, `JobRecord`, `JobTrace`. Add the member the compiler names |
| 25 | a hand-written `JobDriver` | you ship one. `ack`/`nack` take `{ workerId, claim }` and answer `Promise<boolean>`: `driver.ack(id, claimOf(claimed))`. Increment a claim ordinal in `claim()`, fence both settles on it, file a row `failed` when `nackState(options)` says so, and answer an existing `EnqueueRequest.id` with that job and `deduped: true` |
| 26 | a hand-written `JobIntrospection`, or a caller of `list()` | you implement one: add every member TS2741 names — `promoteMany` among them, which the admin's jobs dashboard calls. A caller that asked `list()` for more than 200 rows walks pages with `list({ after: jobCursor(lastRow) })`; over 200 or a foreign cursor is `X_JOB_PAGE_INVALID` |
| 27 | a hand-written `LeaseStore`, `SchedulerState`, `LeaderElection`, or `createFleetSlots` caller | add `holders(key)`; `fire(driver, { task, occurrenceMs, jobs })`; `renewEveryMs`; read `acquire`'s `SlotGrant` |
| 28 | a custom `EventBus`, `createPgEventBus({ clock })` | add `stored` and `now()`; delete the `clock` option. `eventPrompt()` on a bus with `stored: false` is `X_DRIVER_UNAVAILABLE` outside development and test |
| 29 | a staged `enqueue()` | you read its `id` or `runId`: they are now the job's own. A custom `OutboxStore` persists `runId` |
| 30 | `retry: { deadLetter: false }` | a job declares it. An exhausted run is now `failed` (outcome `dropped`) instead of re-run forever — check what relied on the loop |
| 31 | `concurrency: 0`, a negative, a fraction | caught as `X_INVARIANT`. It is `X_JOB_DECLARATION_INVALID` |
| 32 | `lastError` | you compare it to a rendered message. It ends with ` — fix: …` now; compare a prefix |
| 33 | the memory job driver | a test relied on a `Date`, an `undefined` member or a non-enumerable property surviving the queue. The payload is its JSON form, as on Postgres |
| 34 | `exportRows({ sink })` | always: `sink` is a thunk, `sink: () => disk('exports')`, resolved per write. A value is a type error — at runtime `definition.sink is not a function` on the first part — and evaluated `disk()` at module load, before boot |
| 35 | `rpc({ pathStyle })` in island code, a match on `X_ROUTE_NOT_FOUND` | delete the `pathStyle` — the document carries it. A wrong style is `X_CONTRACT_DRIFT` (still 404) |
| 36 | a live query's source | it names an org by hand. Drop the argument: the source is read as the subscriber's tenant. `LiveQueryDefinition.snapshot` receives `{ input, tenant }` |
| 37 | `EntityCore<Row>['$schema']`, a hand-built `RecordProjection` | read the type off the `entity()` result (`typeof posts.$schema`); add `sealed: []` to the projection |
| 38 | `x secrets rotate` | something asserts on `secrets.enc.json`'s exact contents. It now keeps `ULTIMATE_SECRETS_RETIRED_KEYS`; drop a key with `x secrets rotate --drop <keyId>` once nothing is sealed under it |
| 39 | `interface X extends LinkProps` / `PaginationProps` / `DataTableProps<Row>` | extend one member: `TextLinkProps`/`ButtonLinkProps`, `PaginationCallbackProps`/`PaginationLinkProps`, `DataTableCallbackProps<Row>`/`DataTableLinkProps<Row>` |
| 40 | `guard.check(root)` in a test | pass `guardSources(root)` from `@ultimat3/cli` as the second argument |
| 41 | `checkAppBoundaries`, a `switch` over `BuildTarget` | delete the import; add `case 'prebuilt':` |
| 42 | a hand-written e2e driver | read the third argument, `{ timeoutMs }` |
| 43 | a hand-written `E2eApp` double | you build one. `E2eApp` has a required `log(): string` — the spawned app's bounded output, which a failed e2e test now prints (its last 40 lines). Add `log: () => ''` |
| 44 | `runJobs` in a test | a test relied on it calling the body directly. Each pass is a real worker's `tick()`: keyed `concurrency` waits, `whenBusy: 'fail'` refuses with `X_JOB_KEY_BUSY`, and runs claimed in one pass run concurrently. A test that expected two runs of one key to both complete sees a refusal or a wait |
| 45 | `clock.advance()` past the visibility timeout in a `runJobs` test | a run is in flight while the test advances. `runJobs` renews its lease on the test clock as a real worker does, so the lapse is `X_JOB_LEASE_LOST`, as it would be in production. A test that cancels a running job then awaits `runJobs.drain()` adds `clock.advance(1)` after the cancel |
| 46 | the jobs event bus in a test | a test published an event in `beforeAll` and read it in a test. The app's test preload resets the bus before every test: publish inside the test |
| 47 | a non-private workspace package with a `src/**/*-fixture.ts` | you publish one. Its `files` must carry `!src/**/*-fixture.ts`, and a fixture reachable from an entry point is `X_PACKAGE_SHAPE` naming the file to rename. Private packages — every generated app's — are exempt |
| 48 | `og:*` / `article:*` / `twitter:*` on a `robots: { index: false }` page | a test or a crawler expected them. A document that may not be indexed carries none |
| 49 | `defineAdmin` | always: `defineAdmin({ entities, db })` (`adminEntitiesOf(db)` lists every entity on the handle). Delete each `page.tsx` under an admin URL, the `AdminRepo` adapter and the admin action routes. Without `db`: `X_ADMIN_REPO_UNBOUND`; a leftover page: `X_ROUTE_DUPLICATE` |
| 50 | `guardedPage`, `AdminRouteConfig.component`, `RegisteredRepo`, `adminRouteConfig(route)` | `guardedScreen(app, route, body)` or `route.respond(…)`; `adminRouteConfig(app, route)`. The admin view components take no handlers and no `loading` |
| 51 | `AdminList`, `pageRequestOf`, `adminList` | you render the list yourself: `hrefFor={(location) => listHref(basePath, resource, location)}` plus `request`, `scope`, `counts`. An unknown URL parameter is `X_ADMIN_FILTER_INVALID`, not ignored |
| 52 | the tenant column in the admin | a form posted it. It is stamped from the actor; the posted value is ignored |
| 53 | `describeRoutes()`, `Stylesheet` | you list routes or build a `Stylesheet` by hand: mounted routes carry `mount`, a stylesheet carries `claimed` |
| 54 | `/admin/jobs/*`, a hand-written jobs page or nav item | always: every `defineAdmin()` now serves the jobs dashboard — resources `x_jobs`, `x_job_queues`, `x_job_tasks`, `x_job_workers` and the overview at `/admin/jobs`. Delete the page and the nav item; a `pages:` entry at those paths is `X_ADMIN_PAGE_PATH_INVALID`. A test that renders `/admin/jobs` installs a queue first: `setJobDriver(createMemoryDriver())` |
| 55 | `defineAdmin({ jobs })`, `AdminApp.jobs` | delete both: the dashboard reads the queue itself. TS2353 names the site |
| 56 | a hand-written `AuditLog`, or a caller of `entries()` | `entries(query)` is async and takes `AuditQuery` (`entity`, `entityId`, `actorId`, `orgId`, `limit`, `before`, `changes`): write `await log.entries(…)`. A custom log adds `atomic(run)` and `kind` |
| 57 | `InvokeResult` | you read `decision` off a failure. Failures carry `kind: 'denied' \| 'not-applicable' \| 'invalid'`; narrow on `kind === 'denied'` first |
| 58 | a posted row action's redirect | a test asserts its `Location`. It is the row (303), not the list |
| 59 | a row-scoped resource's create and update | a write put a row outside the actor's `rows(actor)`. It is refused before the repo is called and audited as `admin.error.row-out-of-scope`. A text `gt`/`lt` row scope cannot be decided here and refuses every write |
| 60 | an action on a row the actor cannot see | it ran. A row that is gone or outside `rows` is refused, `when` or none: `X_ADMIN_ACTION_NOT_APPLICABLE`, 409, the same over MCP |
| 61 | `permissionsForOperation('admin', op)` | you read a second element. It answers one permission (`['admin:read']`), not the same one twice |
| 62 | stored scraping sessions | always. Step 13. **Sessions and refusal markers stored before 23.0.0 are deleted on first load**, so every run logs in again, and a credential the site had already refused is presented once more. Correct it first on a site that locks an account after repeated failures |
| 63 | `storageSessionStore(disk)`, `artifacts: { storage }` | pass a thunk: `storageSessionStore(() => disk('sessions'))` |
| 64 | a hand-built `PromptRequest`, `AuthContext`, `ScrapeSecrets`, `ScrapeReport`, `SessionInit`, a `createPrompt` call | add the members TS2741 names; `createPrompt({ scrape, handler, page, runId, clock, … })` |
| 65 | `meta.cdpUrl` of `X_SCRAPE_CDP_ATTACH_FAILED` | you read the full URL from it. It is `wss://host:port` |
| 66 | `localBrowser({ proxy })` with credentials | your launcher's page has no `authenticate()` (`X_SCRAPE_EGRESS_UNSUPPORTED`). Upgrade the launcher or drop the credentials from the URL |

Entry 11, the rewrite for each raw request:

| It was | Write |
|---|---|
| `fetch('/api/…', { method: 'POST' })` — an action | `await browserClient.<action>(input)` |
| `fetch('/_x/query/…')` — a read | `useQuery(<QUERY_REF>, input)`; outside a component, `await browserQueries.<query>(input)` |
| `new WebSocket(…)` / `new EventSource(…)` | `useQuery(<QUERY_REF>, input)` for rows, `useChannel(<CHANNEL_REF>, params, { onEvent })` for events |
| an upload, `fetch` or XHR to a signed URL | `await uploadFile({ file, grant, onProgress })` from `@ultimat3/storage` |
| anything else | `await clientTransport({ method: 'GET', url })` from `@ultimat3/core/page` |

An app scaffolded before 23.0.0 has no `apps/web/shared/browser-client.ts`; write it as
[Client data](Client-Data) shows, and add `export type Api = typeof api` to `apps/web/api/index.ts`.

### Where the sites are

```sh
grep -rnE "fetch\(|new (WebSocket|XMLHttpRequest|EventSource)\(" apps packages --include=*.tsx --include=*.ts | grep -v -E "route\.ts|\.test\.ts"
grep -rnE "\.run\(\{|ack\(|nack\(|E2eApp|createPgEventBus|storageSessionStore\(|createPrompt\(|guardedPage|adminRouteConfig\(|checkAppBoundaries|pathStyle|exportRows\(|\.entries\(|InvokeResult|permissionsForOperation\('admin'" apps packages --include=*.ts --include=*.tsx
grep -rlE "page\.tsx" apps/admin
grep -rlE "defineAdmin\(" apps/*/src
ls apps/admin/src/pages 2>/dev/null
grep -rnE "x g [a-z:]+ .*--(live|feature)" scripts package.json .github 2>/dev/null
```

The `typecheck` step finds entries 23–29, 34, 37, 39–43, 50, 51, 55–57, 63 and 64. The gate finds
3, 4, 7, 11–16, 47 and 54; `x db migrate` finds 6; `x g` finds 18 and 19. It does not find entry 2
(a worker that misses a side-effect registration logs it at boot), 20, 21, 32, 33, 36, 44–46, 48,
58–61 or 62 — run the unit, job, live and scraping suites, and read the first boot's log.

## 21.x → 22.0.0, entry by entry

**Twenty-three entries**, the `22.0.0` section of `CHANGELOG.md`. Entries 4, 7, 9, 10, 11, 12, 13, 14, 18, 20 and 21 are compile
errors, and so are parts of 3 (`planDeploy`'s fourth argument), 6 (a declaration with no `policy`)
and 19 (`selectTransport`'s second argument, `'redis'`). Entry 15 throws when a `sync` pod boots,
entry 19 when any realtime role boots with a transport and `NATS_URL` that disagree, and entry 6
when a channel module loads. Entries 1, 2 and 5 compile unchanged and refuse a string they used to
accept; entry 17 changes a `meta.code`, and entry 23 throws where a query silently answered `[]`.
Entry 3 also installs a **new** helm release beside the old one unless you name it. Entry 16 is a
dependency you can drop, entry 22 is one `x db gen` if `drift` asks for it, and entry 8 needs no
edit. 22.0.0 is plan 101's deep sweep: every framework package, both tracked apps and the deploy
path.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | `t.date` | you send a date that is not ISO-8601 in shape (`'March 14, 2026'`, `'3/14/2026'`, `'12'`). It is refused at validation now (`coerceQuery` no longer rewrites it). `new Date` read it at the host's local midnight, so the stored day depended on `TZ`. Send `'2026-03-14'`. Epoch-ms numbers and `Date` objects are unchanged |
| 2 | `timestamp()` columns | you write a string with no `Z` and no offset (`'2026-03-14T09:00'`) or a non-ISO one. Refused now; it used to be parsed in the host's zone. Write `'2026-03-14T09:00:00Z'` or a `Date` |
| 3 | `x deploy --method helm`, `planDeploy` | you deployed with helm before. The release is now named after `app.config.ts`'s `name`, not the literal `app`, so the next deploy installs a **second** release beside the old one. Keep the old one with `x deploy --method helm --release app`, or `helm uninstall app` after the new one is up. The deploy now waits for the rollout (default `--timeout 15m`) and reports `data.rollout`. `planDeploy(image, 'helm', root)` needs a fourth argument, `{ release, namespace, timeout }`. `--release`, `--namespace` and `--timeout` are refused on `--method compose` |
| 4 | `invokeAdminAction({ … expectedConfirmation })` | you pass `expectedConfirmation`. Delete it; the gate derives the token from the action's entity and `subject.id`, and the browser still echoes `confirmationToken(entity, id)` in `confirmation`. With both fields omitted a destructive action used to run unconfirmed; it is refused now |
| 5 | `@ultimat3/ui` `DateTime`, `toDate` | you pass a non-ISO string (`'August 14, 2026 09:00'`, `'8/14/2026'`). Pass an ISO date, a date-time with `Z` or an offset, or a `Date` |
| 6 | `channel(name, { … })` with no `policy` | a declaration omits it. It is a type error and throws `X_CHANNEL_DECLARATION_INVALID` at load. A public channel says so: `policy: allow('public')`. `ChannelDescription.policy` is `string`, no longer `string \| null` — delete a `null` branch |
| 7 | a custom `QueueStore` or `LocalStore` | you implement one. `QueueStore.save(state)` → `write(change: QueueChange)`, and `LocalStore.saveQueue(scope, state)` → `writeQueue(scope, change)`: one change per mutation, by key. Whole-queue records a 21.x page wrote are converted on first read, so queued writes survive the upgrade. The shipped stores need nothing |
| 8 | the page's SharedWorker | nothing to edit. The worker is named per build now (`workerName(scope, buildId)`, internal), so tabs of two deploys never share a socket host |
| 9 | `ChangeOp` | you `switch` over it exhaustively. Add `case 'truncate':` — a rowless change: a `TRUNCATE` empties the affected live windows and starts a new epoch on every open channel topic |
| 10 | `Result`, `Ok`, `Err`, `ok`, `err`, `map`, `mapErr`, `isOk`, `isErr`, `tryCatch`, `unwrap`, `unwrapOr` from `@ultimat3/core` | you import any of them. Gone: `throw` an `UltimateError` and `try`/`catch` it |
| 11 | `X_USERS_TABLE`, `X_SESSIONS_TABLE`, `X_ACCOUNTS_TABLE`, `X_VERIFICATIONS_TABLE`, `X_API_KEYS_TABLE`, `X_USERS_MIGRATION_1_3` from `@ultimat3/auth` | you import them, or pasted them into a migration. Delete both: every boot applies `AUTH_TABLES` (the 1.3 upgrade included, as `add column if not exists`) |
| 12 | internals removed from package barrels | you import a runtime value that no other package used — `CHANGELOG.md`'s `22.0.0` section lists them per package (auth, ui, core, http, entity, query, mcp, ai, mail, notify, pwa, render, scraping, manifest). None is an error class, a code table or a documented API. Copy the constant into your app, or use the documented API it served |
| 13 | the e2e driver: `installE2eDriver`, `e2eFixtures`, `startE2eApp`, `e2eApp`, `e2eBaseUrl`, `e2eBrowser`, `openE2eBrowser`, `cdpConnect`, `cdpE2eTab`, `findChrome`, `launchChrome`, the `Cdp*Error` / `E2e*Error` classes and their types, from `@ultimat3/cli` | you import any of them. Import them from `@ultimat3/testing`; the test preload is `@ultimat3/testing/e2e-preload`. `FRAMEWORK_SCRIPTS` and `FRAMEWORK_INLINE_SCRIPTS` stay on `@ultimat3/cli`. The `X_E2E_*` / `X_CDP_*` codes are unchanged |
| 14 | `entityRow`, `camel` from `@ultimat3/realtime/server` | you decode WAL tuples yourself. `entityRow(physical)` → `entityRow(relation, physical, 'before' \| 'after')`; it decodes through the registered entity (`decodeRow`, `.column()` renames and money included) and refuses a table with no registered entity (`X_REPLICATION_PROTOCOL`). `camel` is gone |
| 15 | a `sync` role on a real database | it has no reachable change feed. It refuses to boot with `X_REALTIME_TOPOLOGY`; it used to come up healthy and deliver nothing. Set `NATS_URL` on `web`, `sync` and one `replicator`, or leave `sync` off. (`x dev --role sync,replicator` runs both in one process, for development.) The scaffolded chart (`roles.sync.enabled: false`) and Compose file (`replicas: 0`) ship `sync` off, with the enable recipe beside the switch; a chart or compose file you copied earlier keeps whatever it had |
| 16 | `x shot`, `x shot --island`, the `ui.*` MCP tools | you installed `puppeteer-core` for them. They drive Chrome over raw CDP on the e2e step's launcher now: `bun remove puppeteer-core` if nothing else imports it. `X_SHOT_BROWSER_MISSING` now means "no Chrome to launch" — `export CHROME_PATH=<binary>` where Chrome is not at `/usr/bin/google-chrome` or the other probed paths, or pass `--cdp-url`. A request to a host off the allow list is refused inside the browser and recorded as `refused: "host"` in the verdict |
| 17 | `ui.interact` step failures | you match `meta.code` against `X_SCRAPE_*`. A failed step carries `X_SHOT_ELEMENT_MISSING`, `X_SHOT_ELEMENT_UNREADY` or `X_SHOT_KEY_INVALID` now |
| 18 | `backoffDelay` from `@ultimat3/realtime` | you import it. Import core's: `import { backoffDelay } from '@ultimat3/core'`, and pass `attempt: n + 1` — realtime's copy counted from 0, core's counts from 1. A failed channel catch-up now retries after the base wait, not twice it |
| 19 | `realtime.transport`, `NATS_URL`, `selectTransport` | your deploy relied on `NATS_URL` alone to pick the bus. `realtime.transport` decides now: `'nats'` dials the variable `realtime.urlEnv` names and refuses the boot (`X_CONFIG_INVALID`) when it is unset — it used to fall back to in-process in silence — and `'memory'` with `NATS_URL` set refuses too. Set `transport: 'nats'` where the fleet shares a bus, or unset `NATS_URL`. `realtime.enabled: false` now starts no `sync` node and no replicator. `transport: 'redis'` (never built) no longer typechecks. `selectTransport(env)` → `selectTransport(env, { transport, urlEnv })` |
| 20 | `startLiveReplicator`, `LiveReplicator`, `LiveReplicatorOptions` from `@ultimat3/testing` | you import them — a live-query test or a hand-rolled dev boot. Import them from `@ultimat3/realtime/server`; `@ultimat3/testing`'s `subscribe` fixture needs nothing |
| 21 | `@ultimat3/cli`'s barrel | you import anything from it but `newCommand`, `dbCommand`, `verifyCommand` and the documented API — 236 internals are gone (command objects, scan internals, report helpers, option types). `maskLiterals` / `stripComments` → `import { maskLiterals, stripComments } from '@ultimat3/core'`. The CLI no longer depends on `@ultimat3/scraping`, so a workspace that reached scraping through it declares it itself |
| 22 | `x db gen`'s schema hash | `x verify --only drift` reports drift right after the upgrade with no entity edited: the hash now uses core's `canonicalJson`. Run `x db gen` once. Neither tracked app needed it |
| 23 | a query's `sql: () => from(…)` over rows its loader `select`ed | the query filters (`where`) or sorts (`orderBy`) on a column the loader's `select({ … })` leaves out. That read used to answer `[]` in silence; it throws `X_QUERY_COLUMN_UNSELECTED` (`QueryColumnUnselectedError`) now. Add the column to the loader's `select`, or drop the filter if the loader already applies it. The reference app's `publicPostSlugs` was one — the blog prerendered no article until `publishedSlugs` selected `status` and `publishedAt` |

### Where the sites are

```sh
grep -rnE "from<|from '@ultimat3/cli'|LiveReplicator|puppeteer|X_SCRAPE_|backoffDelay|selectTransport|transport: 'redis'|expectedConfirmation|planDeploy\(|\bResult<|\b(tryCatch|unwrapOr|mapErr)\(|X_(USERS|SESSIONS|ACCOUNTS|VERIFICATIONS|API_KEYS)_TABLE|X_USERS_MIGRATION_1_3|saveQueue|entityRow\(|\bcamel\b|case 'delete':" apps packages --include=*.ts --include=*.tsx
grep -rnE "from '@ultimat3/cli'" apps packages scripts --include=*.ts | grep -E "e2e|cdp|Chrome|E2e|Cdp"
grep -rnE "channel\(" apps packages --include=*.ts | grep -v policy
```

The `typecheck` step finds every removed name, `planDeploy`'s arity and a missing `policy`. It does
not find a non-ISO date string in a fixture, a seed or a client — those fail at validation, so run
your contract and e2e suites — nor a helm release still named `app`.

## 20.x → 21.0.0, entry by entry

**Twenty-seven entries.** Entries 1–3, 5, 8, 9, 11–17, 20–23 and 27 are compile errors. Entry 24
is a stale file one rebuild replaces, entry 25 is a `budgets` finding, and entry 26 is capacity
planning, not code. Entry 10
throws when the module loads, and entry 18 when `docker compose up` starts. Entry 19 is a
number that means something else. Entries 4, 6 and 7 compile
unchanged and answer differently: a wider `isSuperseded`, a coded error where a bare `TypeError`
or `SyntaxError` used to arrive, and a new response body for non-framework HTTP clients. Entry 2
also changes what `'last-write-wins'` keeps, and entry 8 leaves two error codes that nothing
throws. 21.0.0 is the client data layer: one record store per tab, one HTTP seam and one socket
per origin. The entries are `CHANGELOG.md`'s `21.0.0` section.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | `AsyncState` | you import it from `@ultimat3/ui`. It moved to `@ultimat3/core` unchanged, and ui does not re-export it. `import type { AsyncState } from '@ultimat3/ui'` → `import type { AsyncState } from '@ultimat3/core'`, plus `@ultimat3/core` in that workspace's `dependencies` if it is missing. `AsyncRegion`, `asyncBranch`, `AsyncBranch` and `AsyncFlags` stay in ui |
| 2 | a mutator's `conflict: custom(merge)` | you wrote a `merge`. It now receives the local and server **rows** of the record, not the mutator's parsed outputs: `custom<PostRow>((local, server) => ({ ...server, title: local.title }))`. The output-shaped merge never ran. Realtime's rebase holds rows, so it dropped the policy without a word and used its default. Also: `resolveConflict` moved to `@ultimat3/core` (its answer is `Row`, so narrow it); `Conflict`, `CustomConflict` and `strategyOf` are gone from `@ultimat3/action`, and `strategyOf(c)` is `typeof c === 'string' ? c : c.kind`. **No compile error warns you** that `'last-write-wins'` now keeps the local row only when its `updatedAt` is newer than the server's. A row with no numeric clock resolves to the server's |
| 3 | `ConflictLike`, `custom`, `CustomMerge`, `MergeArgs` or `ConflictStrategy` from `@ultimat3/realtime` | you import any of them. Types: `import type { ConflictPolicy } from '@ultimat3/core'`. Realtime's own `custom(({ local, base, server }) => …)` becomes action's `custom((local, server) => …)`: no `base`, and the merge must return a row with a string `id`, or the rebase throws `X_REBASE_CONFLICT`. **Delete any branch that returned `null` to accept a delete.** The merge is no longer called when the server deleted the row or the client never held one; the server's answer lands as it is |
| 4 | `isSuperseded(error)` | you took `true` to mean `X_SUPERSEDED`. It is also `true` for `X_CLIENT_SCOPE_CHANGED`, a read in flight when the page changed principal. Code that branches on `isSuperseded` needs nothing; code that needs the specific code reads `error.code` |
| 5 | `QueryRequestFailedError`, `QueryProblem` from `@ultimat3/query` | you import either. A query's failure is a plain `UltimateError` now: `if (e instanceof QueryRequestFailedError)` → `if (isUltimateError(e))`, then switch on `e.code`. A query's non-2xx with no framework code is `X_CLIENT_TRANSPORT_FAILED`, not `X_RPC_FAILED`, so update a match on the old code |
| 6 | a typed client's network fault, non-JSON 2xx, or non-2xx with no framework code | you catch `TypeError`, `SyntaxError` or `RpcFailedError`, or match `'X_RPC_FAILED'`, around `rpc()`, `.client()`, `queryClient()` or `@ultimat3/storage`'s `uploadFile()` on its no-XHR fallback (`fetchSignedPut`). All of them are `X_CLIENT_TRANSPORT_FAILED` now: `if (isUltimateError(e) && e.code === 'X_CLIENT_TRANSPORT_FAILED')`. `RpcFailedError` still exports and nothing throws it, so an `instanceof` check against it compiles and never matches. `RemoteActionError` (the server's own code) and `X_CONTRACT_DRIFT` are unchanged |
| 7 | the body and OpenAPI `200` of an action whose output references an entity row | something other than an `@ultimat3/*` client reads it: a generated SDK, `curl`, a test posting with `fetch`. Under `x-ultimate-records: 1` the output is `body.data`, beside `records`. Regenerate an SDK from the new `openapi.json`. `rpc()` and `.client()` strip the envelope, so typed callers need nothing |
| 8 | `@ultimat3/pwa`'s background sync | you pass `backgroundSync: { flushEndpoint }` to `generateServiceWorker`, import `DEFAULT_FLUSH_ENDPOINT` or `BackgroundSyncOptions`, call `backgroundSyncSource(opts)`, or mounted `/_x/outbox/flush` yourself. Delete the option and the imports, call `backgroundSyncSource()` with no arguments, and delete the route. The worker now posts `OUTBOX_DRAIN_MESSAGE` to open tabs, and the page's outbox replays. `pwa.backgroundSync: true` in `app.config.ts` is unchanged. **Also delete any branch matching `X_PWA_SYNC_FLUSH_FAILED` or `X_PWA_SYNC_INCOMPLETE`:** both stay registered, nothing throws them, and such a branch compiles and never runs |
| 9 | `ClientScope.principal` | you narrow it with `!== null` and use it as a `string`. It is `string \| null \| undefined` now. `undefined` is an unscoped page, rendered for nobody, for which nothing is persisted. Test `typeof principal === 'string'`, and give a `switch` an `undefined` arm |
| 10 | a mutator declaring `conflict: 'last-write-wins'` | its entity has no **number** `updatedAt` the server writes (a `timestamp()` string does not count), or its output carries no entity row. It now throws `X_MUTATOR_CLOCK_MISSING` when the module loads. Add `updatedAt` as a number column (epoch ms) that the server writes on every update, or declare `conflict: 'server-wins'`. Without a clock the server row already won every time, so `'server-wins'` changes no behaviour |
| 11 | `setLiveClient`, `clearLiveClient`, `hasLiveClient`, `LiveClient`, `ClientSocket` | your island builds a `LiveClient`. Delete the socket adapter, the sync-URL module, `new LiveClient(…)`, `client.connect()` and `setLiveClient(client)`. Add `installRealtime({ signal: createSignal })` in `mount` before the first render. `hasLiveClient()` → `hasPageSocket()`. `client.subscribe(topic, fn)` → `useChannel(decl, params, { onEvent, onPresence })` or `usePresence(decl, params)` |
| 12 | `useLive`, `LiveRows`, `LiveInput`, `liveHookFor` | you read a live query. `useLive<Row>({ name }, input)` → `useQuery<Row>({ name, live: true }, input)`. `feed.state() === 'live'` → `feed().status === 'ready'`, the rows are `feed().data`, and `unsubscribe()` → `release()`. Delete `liveHookFor` bindings |
| 13 | `IdentityMap`, `privateScope`, `rowKey`, `RowScope`, `RowKey` | you import them. `RecordStore`, `recordKey(type, key)`, `RecordKey`; read one record with `useRecord(type, key)` |
| 14 | `createOpfsLocalStore`, `RebaseLog`, `reconcile`, `rebaseFrame`, `strategyName`, `serverRenderLiveClient`; the journalling `MemoryLocalStore` / `LocalStore` | you pass a store, queue or log to the client, or use them in a test. Delete them: the optimistic apply needs nothing now. `MemoryLocalStore` and `LocalStore` still export, but name the **persistence** store now (`rows`, `write`, `queue`, `wipe`), not 20.x's journal (`apply`, `rollback`, `commit`), so code written against the old shape stops compiling. Durable offline writes ship: an entity declared `persist: true` is restored from IndexedDB by the page boot (`openLocalStore`, `pageLocalStore`), and its queued mutations replay through `pageOutbox()` |
| 15 | `useMutation`, `useMutationQueue`, `MutatorLike` | you call `drain()`, set `entity:` on a `MutatorLike`, or re-query after a write. Delete `drain()` and `entity:`. The call resolves with the action's output, so read it directly. Writes go over HTTP, so a mutation now persists where it used to answer `X_NOT_IMPLEMENTED`. With no response at all (`meta.failure: 'network'`) the call resolves `undefined` and the write is queued; code that needs the output checks for it. A `'status'` or `'body'` failure still rejects |
| 16 | sync protocol 3; `createSyncNode({ onMutate })`, `MutationHandler` | you run a `sync` node. Delete `onMutate`, and redeploy clients and nodes together: a v2 client and a v3 node refuse each other with `X_PROTOCOL_VERSION` |
| 17 | `topic` / `Topic` from `@ultimat3/realtime/server` | you import it there. Import it from `@ultimat3/realtime` |
| 18 | Compose deploys: `docker-compose.prod.yml`, the scaffold, both tracked apps | you deploy with Compose. `web` now refuses to start without `SYNC_URL`. Set `SYNC_URL=ws://<host>:3001/_x/sync` in `.env.production` and run Compose with `--env-file .env.production` (`x deploy` does), or proxy `/_x/sync` to `sync` and set `SYNC_URL=wss://<host>/_x/sync`. A copied compose file adds the same line to `web` |
| 19 | `x verify --json` → `data.durationMs` | you sum step times or read the total as a sum. It is wall time now; the static steps overlap the serial suites |
| 20 | the `presence` frame, `PresenceFrame` | you read rosters. Declare the room `channel(name, { …, events: true })` and read `readPresence(frame.event)` in its events handler; a roster is an `events` frame `{ presence: op, members, total? }` now |
| 21 | `ChannelHub#guard`, `subscribe(socket, topic)`, `publish(topic)`, `publishFrame`, `channelFrame`, `TopicGuard*`, `nodeId`, `{ kind: 'topic' }` | you run a hub. Declare each channel with `channel(name, { params, policy, row?, catchUp, records?, events? })`. Build the hub as `new ChannelHub({ transport, sockets })`. `guard` → the declaration's `policy`; `publish(topic, event)` → `hub.publishEvent(decl, params, event)`. Delete `nodeId`. An undeclared name is `X_TOPIC_FORBIDDEN` |
| 22 | `LocalTable`, `LocalRow`, `tx.<type>.insert(row)` / `upsert(row)` / `update(id, …)` | you write rows in a `local` twin, or type one. Tables are addressed by record key: `tx.posts.insert(post.id, post)`, `upsert(key, row)`, `update(key, patch)`, `delete(key)`, and `get(key)` / `all()` to read. `LocalRow` is gone: `LocalTable<Post>` |
| 23 | `cdpE2ePage`, `CdpE2ePageOptions` from `@ultimat3/cli` | your e2e suite opens a page itself. Use `openE2eBrowser()` and its page tab, `session.newTab()` for a second tab, or `cdpE2eTab({ … })` on an existing connection |
| 24 | `.x/build-stats.json` | you ran `x build` before upgrading. Every budgeted route reads `X_BUDGET_UNMEASURED` until `x build --target static` runs again, because the stats file carries the measurement rules that wrote it and v1 files are not read |
| 25 | `hasPageSocket()` as a guard in page code | a module no island imports calls it (an offline banner, an update prompt in a layout). The `budgets` step now reports it as `X_LIVE_ROUTE_NO_ISLAND`. Move the module into an island: `x g island <route-dir> --at <route-dir>`, import it from the island's `mount()`, declare `island({ src })` |
| 26 | a browser's reconnect backoff | you sized a sync node on the 30 s spread of reconnects. Browsers now redial within 4 s (`equal` jitter from 500 ms). Check the node's `AcceptBudget` sheds a SIGKILL herd arriving in 2–4 s. Nothing to change in app code |
| 27 | `LaunchedBrowser.endpoint` from `@ultimat3/cli` | you launch Chrome yourself for tests. `cdpConnect(browser.endpoint)` → `browser.connection`, which is already answering over the debugging pipe. `cdpConnect(url)` remains for a remote browser |

### Where the sites are

```sh
grep -rnE "import type \{[^}]*AsyncState[^}]*\} from '@ultimat3/ui'" apps packages --include=*.ts --include=*.tsx
grep -rnE "ConflictLike|ConflictStrategy|CustomMerge|MergeArgs|CustomConflict|strategyOf|resolveConflict|custom\(|QueryRequestFailedError|QueryProblem|X_RPC_FAILED|instanceof (TypeError|SyntaxError|RpcFailedError)|isSuperseded|flushEndpoint|DEFAULT_FLUSH_ENDPOINT|BackgroundSyncOptions|outbox/flush|X_PWA_SYNC_|\.principal|last-write-wins|LiveClient|useLive|liveHookFor|IdentityMap|rowKey|privateScope|LocalStore|RebaseLog|reconcile|serverRenderLiveClient|drain\(|onMutate|realtime/server|PresenceFrame|\.guard\(|publishFrame|channelFrame|TopicGuard|nodeId" apps packages --include=*.ts --include=*.tsx
```

The `typecheck` step finds every removed name for you. It does not find a `custom(` merge whose
type argument is still the output type: `custom<TRow>` takes any object type, so that merge
compiles and reads `undefined` for every output field that is not a column of the row. The second
grep lists every `custom(`. Read each one.

## 19.x → 20.0.0, entry by entry

**Both entries are `@ultimat3/ui` component behaviour, and neither changes a type** — so nothing
fails to compile and nothing throws. They change what a screen DOES, which is why they are a major:
a silent rendering change is worse than a build error, and you would have found these by looking.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | `DataTable` while reloading | you relied on skeletons appearing on every load. A FIRST load (`rows: []`) still renders skeletons; a RELOAD now keeps the existing rows, dimmed, under `aria-busy`. Replacing rendered content with placeholders on every refresh is a second layout change for no news, and it is what makes a fast list feel slow — the reader has already read those rows, and taking them away to say "loading" tells them nothing they can act on. No edit if you pass fresh `rows` on each load, which is the ordinary case. If you genuinely want the placeholder back on a refresh, pass `rows: []` while the fetch is in flight |
| 2 | `Button` with `loading` | you style `button[disabled]`, or you assert on the `disabled` attribute in a test. `loading` no longer sets the native attribute — it sets `aria-disabled` + `aria-busy` and refuses the click in `onClick` with `preventDefault()`. The click is still refused; the mechanism moved. A `disabled` control loses focus the moment it becomes disabled — mid-flow, with no announcement — is exempt from the WCAG contrast minimum precisely because nobody is meant to read it, which is wrong for a control you are asking someone to WAIT on, and it does not actually prevent a double submit, because that race is server-side and always was. The edit is one selector: style `button[aria-disabled='true']` beside `button[disabled]`, and assert on `aria-disabled` |

**`defineTheme()` can now refuse your brand** — `X_UI_CONTRAST_INSUFFICIENT`. Listed here rather
than as a third entry because it throws at declaration with the measured ratio, the required one and
the role to move, so it cannot ship silently and needs no search. An override whose RESOLVED
channels put a pairing below WCAG 2.2 AA (4.5:1 text, 3:1 focus ring, 1.4:1 border) fails at boot.
Only pairings your brand can have CHANGED are measured — blaming an app for the framework's own
colours is how a rule gets switched off. The usual defect is half a pairing: a new `accent` against
the shipped white `accent-fg`. `@ultimat3/ui` exports `contrastRatio` and `roleContrast` so you can
measure a candidate before shipping it. AA and never APCA: APCA is not a standard, and AA is the
operative legal benchmark.

**Nothing else in this release costs an edit.** The five new app guards ship in `x new` only; an
existing app gains one with `x g guard <name>` (since 23.0.0; `x doctor --json` lists the shipped
ones it lacks in `data.guards.missing`), one file per rule, and deleting one drops that rule. `x shot --all-islands` is additive, and
`x g island` / `x g resource` now write a `.island.states.ts` beside what they generate.

## 18.x → 19.0.0, entry by entry

**Both entries cost an edit only if you had `pwa.enabled: true`** — the same block 18.0.0 grew, for
the same reason one release later: 18.0.0 wired the web manifest and left the service worker with
zero callers, so `pwa.offline` steered nothing and `/offline` was a path no build precached.
`x dev`, the container and `x build --target static` all emit `sw.js` and `x-sw-register.js` now,
and the config had to be able to say what they emit.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | `AppConfig.pwa.offline` | you set `pwa.enabled: true`. It was `'precache' \| 'runtime' \| 'network-only'` — an app-wide **default** for a field `defineRoute` makes **required** on every route, so it defaulted nothing and was read by nobody. It is now `{ fallback, image, font, neverCache }`, and **`fallback` is required** once `enabled` is true: an absolute route path, screened at `defineConfig` rather than at `x build`. The edit is one line — `offline: 'runtime'` → `offline: { fallback: '/offline' }` — plus a route at that path. A relative value is refused because it resolves against whatever document registered the worker, so `offline` served under `/posts/1` is `/posts/offline`: a 404 cached as the answer to every offline navigation. **Or set `pwa.enabled: false`.** Per-route `offline:` is unchanged, and is still where the strategy is declared |
| 2 | `x new`'s scaffold | you regenerate an app, or you copied the old scaffold. The offline fallback is `apps/web/site/offline/page.tsx`, not `apps/web/app/offline.tsx`: the directory is the URL and `<name>.tsx` is not a route file, so the old path shipped a component nothing imported and left `/offline` a URL that did not exist. `site/` and `render: 'static'` deliberately — the document that answers a lost network must render with no network, no session and no database, which `app/` (`ssr \| stream`) cannot promise. An existing app moves the file and adds `offline: 'precache'`, `hydrate: 'never'` and `robots: { index: false }` to its `defineRoute` |

**`x build --json` renames one field**: `precacheWarnings` → `serviceWorkerWarnings`, and the
terminal row is labelled `service-worker`. It is listed here rather than as a third entry because
no released build ever wrote the old key — `PrecacheManifest.warnings` had no reader at all until
this release. The list carries the precache byte ceiling **and** `pwa.push: true` with no VAPID key
to sign a subscription with, which is the one PWA capability still unwired.

## 17.x → 18.0.0, entry by entry

**Two of the five cost an edit only if you had `pwa.enabled: true`**, which until this release did
nothing at all — no Ultimate app had ever served a web manifest, so the block was a switch with no
reader. **One is `bun upgrade`.** The other two are types.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | the Bun floor, `>=1.4.0` in `engines.bun` and in `x`'s own check | you run Bun below 1.4.0. **The edit is `bun upgrade`.** The floor said `>=1.3.0` while `x test` emitted `bun test --isolate`, a flag Bun introduced in **1.3.13** — so on 1.3.0..1.3.12 the gate's dominant step died on an unknown flag and `x doctor` called the runtime fine. `1.4.0` rather than `1.3.13` because a floor is a claim about a runtime somebody tested: CI pins `1.4.x` and both images build on `oven/bun:1.4-*` |
| 2 | `AppConfig.pwa` | you set `pwa.enabled: true`. It now also requires `pwa.name` and `pwa.colors.light` / `pwa.colors.dark`, each with `themeColor` and `backgroundColor`. `defineConfig` refuses an incomplete block **at boot**, not at `x build`, and the `fix:` carries the whole block. There is nothing to derive them from: `app.name` is a slug, so an install prompt offering `ledger-demo` is wrong rather than rough, and a browser paints the install splash before a stylesheet loads. Raw hex is legal here — one of two places in an app it is, beside `theme.tokens` (itself removed in 25.0.0). **Or set `pwa.enabled: false`**, which is what it effectively was |
| 3 | `@ultimat3/pwa`'s exports | you import `PwaConfig`, `ThemeTokens` or `SchemeColors` from it. `PwaConfig` is now `WebManifestInput` — two exported types of one name with no map between them is axiom 1, and this was the one that lied: its doc said "the `pwa` block of `app.config.ts`" and it was the generator's input. `ThemeTokens`/`SchemeColors` are `PwaColors`/`PwaSchemeColors` from `@ultimat3/core`, which is where the config lives |
| 4 | `x test --json`, and four `@ultimat3/cli` exports | you read `data.shards[]` or `data.failed`, or import `planShards`, `shardArgs`, `SHARD_COMMAND_PREFIX` or `Shard`. `x test` runs one `bun test --parallel=N` now, so there are no shards to report: read `data.ok` instead of scanning for a failure and `data.reproduce` instead of rebuilding the rerun. `testArgs(…)` builds the argv, `filesIn(command)` reads the file list back out. `X_TEST_SHARD_FAILED` still exists and is `x test --worker I`'s alone |
| 5 | `ScrapeTarget` / `ScrapePage` | you implement either interface yourself. `ScrapeTarget` gains `setColorScheme` and `ScrapePage` gains `colorScheme`; a driver of your own stops compiling until it has both. Calling `@ultimat3/scraping` rather than implementing it costs nothing |

**`x test live --workers 8` now runs one worker, and that is a fix rather than a regression.** The
gate always ran `live` and `e2e` serially and the command did not, so the same files ran eight
processes under one entry point and one under the other. A logical replication slot is named at the
Postgres **cluster** level, so a per-worker database never isolated it. `--workers` is still
accepted and clamps to 1.

## 16.x → 17.0.0, entry by entry

**Three breaking entries, and all three are the same sweep**: a numeric option that used to accept
`NaN`, `±Infinity`, a fraction or a negative now refuses it. The refusal is at **boot or at the call
boundary**, never mid-request, so one `bun test` or one `x verify` surfaces every one of them at
once and each `fix:` line carries the edit.

**An app passing real numbers is unaffected.** An app that was passing `NaN` was not working: the
bound it declared was not being enforced, and nothing said so. `??` guards *nullish*, and `NaN` is
not nullish — so `Number(process.env.X)` on an unset variable walked past the default and landed on
the bound intact. `Math.max`, `Math.min` and `Math.floor` all propagate `NaN`, and this repo was
relying on all three as guards.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | Every numeric option in the table under 17.0.0's **Changed** heading — across `http`, `query`, `jobs`, `realtime`, `auth`, `ai`, `render`, `pwa`, `mail`, `manifest`, `mcp`, `notify`, `ui`, `scraping`, `testing`, `cli`, `admin`, `core`, `time` | you pass one a value that is not finite, or is fractional or negative where the option counts things. Read the row for the floor: **`0` stays legal wherever it means something** — `port: 0` asks the OS for a free port, `timeout: 0` is one look, `seed: 0` is a seed, `maxAgeSeconds: 0` is "revalidate every time", `concurrency: 0` is one worker |
| 2 | `http.trustedProxyHops` | you declare `0`. That was the **failure state, not a setting**: `forwarded.ts` returns `undefined` for `hops < 1`, so a declared `0` silently trusted nothing while reading as configured. The domain is `1…64`. It is a boot-owned key, so no app can write it — the blast radius is embedders calling `defineHttpConfig` directly |
| 3 | `search().page(input, { first })` | your page would **cut rows**. A window narrower than the read is now served when nothing is dropped, and refused — naming both edits — when rows would be lost. This is a *widening* against 16.x for the common case: `limit` defaults to 20 and `first` has no default, so `search({…}) + .page(input, { first: 10 })` used to mint a cursor that page two then threw on |

**`TRUSTED_PROXY_HOPS` widened from 1–16 to 1–64** and is listed here only so the change is not a
surprise: it accepts strictly more than 16.x did, so no configuration that worked stops working.

## 15.x → 16.0.0, entry by entry

**One breaking entry**, and it fires at `entity()` — before a migration exists, before anything
reaches a database. Nothing migrates, and an app whose patterns are already portable emits exactly
what it emitted at 15.x.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | `c.<col>.matches(/re/)` refuses an unportable construct | your pattern uses `\b`, `.`, `\w`, `\s`, a backreference, a named group, an inline flag, a POSIX class, `\A`/`\Z`, `\x`, a leading `]` in a class, or a non-ASCII range endpoint |

### 1. `matches(/re/)` refuses what the two engines read differently

At 15.x this accepted **any** `RegExp` and emitted a maybe-equivalent POSIX pattern. That is the
defect, not the refusal: `matches(/\bfoo/)` shipped a CHECK that compiled cleanly, errored nowhere,
and enforced a **BACKSPACE** — measured on 18.4, `'foo' ~ '\bfoo'` is FALSE while `/\bfoo/.test('foo')`
is true. Two rules under one name, with nothing anywhere to report it.

Nothing is translated now either, and that is the mechanism: `pattern.source` is the string
`.test()` runs **and** the string spliced into the constraint. That is only safe because every
construct where the engines disagree is refused at declaration.

**How to find them:** run your entities — `bun test`, or `x db gen`. The refusal is at `entity()`
time, so one run surfaces every one, and each names the construct, its index, both readings, and
the repair.

| Construct | Measured on 18.4 | Write instead |
|---|---|---|
| `\b` | `'foo' ~ '\bfoo'` **false** — ARE reads BACKSPACE | a predicate: `matches((v) => /\bfoo/.test(v))`, app-only, `sql: null` |
| `.` | `'a\nb' ~ 'a.b'` **true**, JS false | `[^\n\r]` |
| `\w` `\W` | `'é' ~ '^\w$'` **true** — locale alnum class | `[A-Za-z0-9_]` |
| `\s` `\S` | `'\u00a0' ~ '^\s$'` **false**, JS true | `[ \t\n\r\f\v]` |
| `\A` `\Z` | anchor in ARE, a letter in JS | `^` / `$` |
| `\x` | `'Д' ~ '^\x414$'` **true** — ARE takes 3 hex, JS 2 | a predicate |
| leading `]` in a class | `[]a]` differs | `\]` |
| `\1`–`\9`, `(?<name>…)`, `(?i)`, `[[:alpha:]]`, non-ASCII range endpoint | backreference, named group, inline flag, POSIX class, collation-ordered range | a predicate |

Kept, and each measured to AGREE: literals, `^ $ | ( ) * + ?`, lazy quantifiers, `{n}`/`{n,}`/`{n,m}`,
`(?:` `(?=` `(?!` `(?<=` `(?<!`, `\d \D \n \r \t \f \v`, punctuation escapes, bracket expressions
with ASCII ranges, non-ASCII *members*, and `\uwxyz` at exactly four hex digits.

Two of those earn a note. **`\d` is in by measurement, not by reading** — POSIX pins `[[:digit:]]`
at the ten ASCII digits, and `'٣'`/`'５'` are false on both sides. **`\uwxyz` is in because Bun
escapes a regex literal's non-ASCII characters** (`/^é$/.source` is `^\u00E9$`), so refusing it
would have refused every i18n pattern written the ordinary way.

**The subset is falsifiable, not asserted.** One live test runs every refused construct against a
real server and asserts the two engines still disagree; another runs the kept subset and asserts
they agree. A future Postgres that grows JavaScript's `\b` turns those red rather than leaving a
stale exclusion in place.

### Not breaking, but you will see it

`x db gen` now emits `drop index` / `drop constraint` for a recorded index no entity declares.
At 15.x it emitted nothing, so those objects stayed on the database while the next sidecar stopped
recording them — and `drift` was green over it. Your first generation after upgrading may carry
drops you did not expect; read them, they are objects your entities genuinely no longer declare.
A recorded unique CONSTRAINT gets a `drop constraint … if exists` **before** the `drop index`,
because `drop index` on a constraint-backed index is `2BP01` and `if exists` does not suppress it.

## 14.x → 15.0.0, entry by entry

**One breaking entry**, and it is a compile error only for code that exhaustively switches over a
type it does not own. Nothing changes at runtime and no data migrates.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | `DriftKind` gains `missing-check` | you `switch` over `DriftKind` with **no `default`** |

### 1. `DriftKind` gains `missing-check`

The same shape 4.0.0 recorded when it gained `changed-foreign-key`. Add a `default`, or handle the
new member:

```ts
case 'missing-check':
  // the snapshot names a CHECK constraint the catalog does not hold
  break;
```

**It compares `conname` and never the definition**, and that is not an optimisation — it is the
only comparison that can work. `pg_get_constraintdef` answers Postgres' *own rewriting*:
`status in ('draft','published')` comes back as
`CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text])))`. Comparing that text against a
generated predicate would report a correct database as drifted, forever.

Only the **declared** side is judged, so a `NOT NULL` (`contype='n'` on PG17+), an `enumerated()`
column's old anonymous constraint and an extension's own constraints are all silent.

## 13.x → 14.0.0, entry by entry

**Eight breaking entries.** **Four** are compile errors the moment you upgrade (3, 4, 5, 8). **Two**
are security fixes that change behaviour with nothing failing to compile (1, 2). **One** changes the
text of a validation issue path (6), and **one** is a driver interface (7).

**No `app.config.ts` key moves.** No codemod: each entry names its own manual edit.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | a frame verb acts on the frame, not the parent document | never — a **fix**. `frame(…).fill()` used to clear the parent's same-id field and append to the frame's |
| 2 | a session key hashes each segment | never an edit — but **every stored session logs in once more**, see below |
| 3 | `$migration()`, `toSql`, `invariantsToSql`, `constraintName` removed | you called one — nothing in this repo did, and `$migration()` rendered `ALTER TABLE "<entity name>"`, a relation that does not exist |
| 4 | `t.number.int()` demands a **safe** integer | you relied on `2^53` passing a boundary that the row write then refused |
| 5 | `and()` / `or()` refuse an empty clause list | you build a policy from a list that can filter to empty — `and()` used to answer **allowed** |
| 6 | a `t.record` issue path names the entry by **position** | you parse issue paths and expect the caller's key. The key *is* caller data and reached the log line |
| 7 | `ScrapeTarget.setOfflineMode` required; `CdpTargetInit.ringCapacity` deleted | you implement `ScrapeTarget` yourself |
| 8 | `Repo.insert`/`insertAll`/`upsertAll` take `RowWrite<T>` | you implement `Repo` — otherwise this **accepts more** than before |

### 2. Every stored session key changes spelling

Segments used to be sanitised by collapsing every run of non-`[a-zA-Z0-9._-]` to a single `-`, so
`alice@corp.com` and `alice-corp.com` produced **one key**. The browser then loaded account A's
cookies, `auth.validate()` answered `true` — the session *is* valid, for the wrong account — and
A's rows were stored under B's tenant.

**Nothing to run.** A stored record is not found under the new spelling, a miss reads as "no
session", so the run logs in again and writes the new key: one extra login per stored session, no
error, and the old objects are orphaned until your bucket's lifecycle rule collects them.

### 5. `and()` with no clauses used to admit anonymous callers

```ts
// before — answered ALLOWED, and admitsAnonymous() agreed, so http did not 401 first
policy: and(...requiredCaps.map(can))   // requiredCaps filtered to empty

// after — refused where it is written
policy: requiredCaps.length === 0 ? allow('public') : and(...requiredCaps.map(can))
```

`allow('public')` is the explicit spelling for "no clauses required"; `deny('<reason>')` is the one
that carries a reason. Both are refused because a combinator with no clauses states nothing, and
`and()` stated the opposite of what its author meant.

### 8. `Repo`'s whole-row writes take `RowWrite<T>`

They took the **row** type where money's **write** type belongs, so `Repo.insert` demanded a
`MoneyValue` while `narrowMoney` exists precisely to narrow a `bigint` handed to a driver — a
compile error on public API for a value the framework documents, implements and stores correctly.
`RowWrite<T>` accepts both spellings. If you implement `Repo`, widen those three signatures; if you
only call them, this accepts strictly more than before and costs you nothing.

## 12.x → 13.0.0, entry by entry

**Two breaking entries**, and both are compile errors the moment you upgrade. Nothing changes at
runtime, no data migrates, no cursor or protocol moves. This major is wide in what it ADDS —
notifications, full-text search, webhooks, exports, state machines, form binding — and narrow in
what it breaks.

**No `app.config.ts` key moves.** No codemod: each entry names its own manual edit.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | `ServiceFactory` receives `CtxFacts`, not `Ctx` | your `defineService` factory annotates its parameter `(ctx: Ctx)`, or reads a **sibling service** off it |
| 2 | `PageLike.content()` is deleted | you called it in an e2e test, or implement `PageLike` yourself |

### 1. `ServiceFactory` receives `CtxFacts`

`defineService`'s factory is handed the framework's own facts — `actor`, `now()`, `clock`, `tz`,
`locale`, `requestId` — and **not** the app's augmented services. It always worked this way; the
type said otherwise.

```ts
// before — compiles, and is circular: the factory that BUILDS ctx.posts
// declares that ctx.posts must already exist
export const posts = defineService('posts', (ctx: Ctx) => ({ … }));

// after — the documented form, which cannot drift from the signature
export const posts = defineService('posts', (ctx) => ({ … }));
```

Drop the annotation. If you genuinely need to name the type, `CtxFacts` is now exported from
`@ultimat3/core` — it was the parameter type all along and the barrel never re-exported it, so no
app could name what its own factory was handed.

**Reading a sibling service inside a factory no longer typechecks.** That was already documented as
unsupported — factories run in registration order and a sibling may not exist yet — but the type
permitted it. Move the read into the method that needs it, where `useService()` resolves at call
time.

### 2. `PageLike.content()` is deleted

`PageLike`'s comment claimed *"every member is one the reference app's e2e suite already calls"*.
An audit found that false for three of eleven: `content()` had **zero call sites anywhere in the
repository**, and `title()` / `reload()` are named only by `x g route`'s generated template, which
nothing executes.

`content()` is gone. `title()` and `reload()` stay, with the caveat recorded on each. If you drive
a browser yourself, delete `content` from your `PageLike` implementation; if you called it, read the
DOM through `evaluate()` instead.

## 11.x → 12.0.0, entry by entry

**Sixteen breaking entries**, in three groups. **Eight** are compile errors the moment you upgrade
(4, 5, 6, 8, 9, 13, 14, 16). **Four** need an action before or at the deploy and nothing fails to
compile (1, 2, 3, 11) — every persisted pagination cursor stops working, rows sharing a sort value
change order, one index migration, and **`sync` nodes and browser clients must ship together**. The
last **four** are visible only to a caller at runtime (7, 10, 12, 15).

**No `app.config.ts` key moves**, because the surface this major opens never had one: `AppConfig` has
never carried an `http` member, so `configureHttp()` is an addition and not a migration — see the
last table. No codemod: every entry names its own manual edit.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | every cursor minted before 12.0.0 is `X_CURSOR_INVALID` | you persisted a cursor — in a URL, a job payload, a client store. Nothing fails to compile |
| 2 | the primary-key tiebreak takes the **last declared** key's direction | you depended on the order of rows sharing a sort value. Nothing fails to compile |
| 3 | an index declaring `where` or `order` is renamed `<table>_<cols>_<hash8>_idx` | you declared one — **a migration, before the deploy** |
| 4 | a physical column or table name must be `[a-z_][a-z0-9_$]*`, at most 63 bytes | you wrote `.column('createdAt')` or an `entity(name)` / `table` that is not lower-snake |
| 5 | `Repo` gains `aggregate` and `approximateCount`; `ReadBuilder` gains five terminals | you implement `Repo` or `Driver` yourself |
| 6 | `Operator` gains `contains`, `contained-by`, `overlaps`, `has-key` | you `switch` exhaustively over `Operator` |
| 7 | `introspect()` returns app tables only | you read its output, or assert how many catalog queries it issues |
| 8 | `rateLimitKey` is deleted; `RateLimitConfig.tenantBucket` is required | you called `rateLimitKey`, or built a full `RateLimitConfig` |
| 9 | `Ctx` gains a required `deadlineAt` | you hand-build a `Ctx` — a test fixture, a custom host |
| 10 | `traceHeaders()` sends the remaining request budget | never for the caller; a downstream service now receives `x-request-timeout-ms` |
| 11 | `PROTOCOL_VERSION` 1 → 2, and five realtime exports are deleted | you imported one — and **every** deployment redeploys clients and `sync` nodes together |
| 12 | MCP rate limits are enforced, 120 read / 20 write per minute per actor | an agent exceeded them; it was previously unmetered |
| 13 | `memoryAuditSink()` is bounded at 1,000 and discards oldest-first | you used it as a system of record, or implement `MemoryAuditSink` |
| 14 | `RouteBudget.css`, `.cls` and `.tbt` are deleted | you declared one — it was ignored, and now it does not compile |
| 15 | `claim({ queues: [] })` is refused; the memory driver's `claim` is `async` | you call a `JobDriver` directly |
| 16 | `DoctorProbe` gains a required `database()` | you implement `DoctorProbe` |

### Entries 4, 5, 6, 8, 9, 13, 14 and 16 — a compile error the moment you upgrade

**4. Spell every physical name lower-snake.** `X_INVARIANT_VIOLATED` at `entity()`, before any
statement runs.

```diff
- createdAt: timestamp().column('createdAt'),
+ createdAt: timestamp().column('created_at'),
```

A **derived** name is unaffected: `columnName` is `meta.name ?? snake(property)` and `snake()`
lower-cases, so `createdAt: timestamp()` still writes `created_at`. What changed is that the derived
branch is now checked too — for three majors only `meta.name` was, so a property named
`n" , "x" text); drop table t; --` put a real `drop table` inside a generated `create table`.
Quoting is not a defence against a value that can close the quote. `entity(name)` and `table` go
through the same assertion.

**5. Implement the two new `Repo` members, or stop hand-rolling one.** `TS2739`.

```diff
  const repo: Repo<Post> = {
    findById, findMany, insert, update, delete: remove, count, countBy,
+   aggregate: (fn, column, args) => driverAggregate(fn, column, args),
+   approximateCount: async () => null,        // `null` is "never analysed", and always legal
  };
```

`approximateCount` may answer `null` unconditionally — that is the documented value for a table
nobody has `ANALYZE`d, and every caller already handles it. `aggregate` cannot be stubbed the same
way: a wrong number is worse than no number, so raise `X_AGGREGATE_UNSUPPORTED` if you will not
implement it.

**6. Widen the `switch`.** `TS2366`, or a silent fallthrough if it had a `default`.

```diff
    case 'is-not-null': return sql`${col} is not null`;
+   case 'contains':      return sql`${col} @> ${bind}`;
+   case 'contained-by':  return sql`${col} <@ ${bind}`;
+   case 'overlaps':      return sql`${col} && ${bind}`;
+   case 'has-key':       return sql`${col} ? ${bind}`;
```

The four exist so a declared `json()` or `arrayOf()` column is no longer write-only from the query
language.

**8. `rateLimitSpends` answers a LIST, not a key.** `TS2305`.

```diff
- const key = rateLimitKey(route, ctx);
- await limiter.assert(key, bucket);
+ for (const spend of rateLimitSpends(route, ctx, config)) {
+   await limiter.assert(spend.key, spend.bucket);
+ }
```

One request spends the caller's bucket and then the tenant's, stopping at the first refusal. The old
builder answered `actor` **else** `org` **else** `ip`, exclusively — and the anonymous actor answers
`null` for both of the first two — so no HTTP request ever spent an org bucket. `RateLimitConfig`
gains a required `tenantBucket: string | null`; `null` is "this app has no per-tenant allowance",
which is the default and the previous behaviour.

**9. Add `deadlineAt` to a hand-built `Ctx`.** `TS2741`.

```diff
  const ctx: Ctx = {
    requestId, traceId, locale, tz, buildId, role, actor, now,
+   deadlineAt: null,        // null is "no deadline", which is what a job or a test has
  };
```

`createContext({ … })` already defaults it, so only a literal pays. It is what
`remainingBudgetMs(ctx)` reads and therefore what entry 10 propagates.

**13. `memoryAuditSink()` is not a system of record.** The interface break is `TS2739` on
`size`/`dropped`; the behaviour break is silent.

```diff
- setAuditSink(memoryAuditSink());
+ setAuditSink(postgresAuditSink({
+   executor: { query: (text, values) => db().query({ text, values }) },
+ }));
```

Past 1,000 records the memory sink drops the **oldest** on every write, so an audited action can run,
succeed, be recorded and leave nothing behind. `{ maxRecords }` raises the bound and does not remove
it. `dropped` is non-zero exactly when the sink is telling you it is the wrong one. `x_audit` is
applied at boot beside the jobs, idempotency and rate-limit tables, so there is no migration to write.

**14. Delete the budget key.** `TS2353`.

```diff
  budget: {
    js: '40kb',
-   css: '12kb',
-   cls: 0.1,
  },
```

There is nothing to replace them with. All three were declared on the route contract, flattened away
by `registerRoute` — which projects a budget to `budgetJs` + `budgetLcp` and nothing else — and read
by no consumer anywhere, so a declared CSS budget was ignored while the `budgets` step reported
green. A new budget key is now a build error until the descriptor projects it
(`_EveryBudgetKeyIsProjected`, `packages/render/src/type-pins.tsx`). `budget.lcp` survives and is
**published, not enforced**: nothing in the build observes a paint.

**16. Implement `DoctorProbe.database()`.** `TS2741`. Only a hand-written probe pays — `x doctor`'s
own is unchanged.

```diff
  const probe: DoctorProbe = {
    bunVersion, root, port, production, devCursorSecret, devStorageSecret,
+   database: () => probeDatabase(process.env['DATABASE_URL']),
  };
```

`x doctor` answered "shippable" while probing the web port alone: a wrong password or a database that
does not exist accepts the socket and refuses the session, which a port check cannot see. It now
probes both ports and the database.

### Entries 1, 2, 3 and 11 — do this before the deploy

**1. Drop every persisted cursor.** Nothing fails to compile; a stored cursor is refused at decode
with `X_CURSOR_INVALID`.

| Where a cursor lives | Do this |
|---|---|
| a URL a client holds | nothing — request the first page (`after: null`) and re-mint |
| a job payload, a resumable `inBatches()` position | re-enqueue from the start, or from a business key of your own |
| a client store, a saved view | clear it on the version bump |

Two changes make an old cursor unreadable, and both were forced by one defect. A `timestamp()` sort
key is now carried as a **microsecond epoch** rather than an ISO string, because `ORDER BY` evaluates
`timestamptz` at microsecond precision while the seek treated a whole millisecond as one equality
class — two different equality classes over one page boundary. Reproduced against Postgres 16: three
rows inside one millisecond, uuid-v7 ids, `orderBy('createdAt','desc').limit(1)` returned **1 of 3
rows and stopped**, every time. And every entry is **tagged** — `~` for an absent value, `!` before a
present one — so an absence can be told from the text that spells it, which is what nullable sort
keys need.

The seek is now a plain `<` / `>` / `=` against `$n::timestamptz`; `nextMillisecond` and the
`>= v and < v + 1ms` window are gone. A read ordered by a `timestamp()` column carries one extra
output column on the wire, `"<col>$US"` — a name no entity can declare, stripped by `decodeRow`, so
it reaches no caller's row. **Only a test that asserts SQL text sees it**, which is exactly the suite
that hid this defect for three majors.

**2. The default total order is uniform-direction.**

```diff
- ORDER BY created_at DESC, id ASC
+ ORDER BY created_at DESC, id DESC
```

`totalOrder` appends the primary key in the **last declared** key's direction rather than always
ascending, so `orderBy('createdAt','desc')` runs `created_at desc, id desc`. **Rows sharing a sort
value come back in the opposite order to before**, and no page is lost either way — the seek matches
the order it is built from.

Two things follow. A mixed-direction order was un-indexable by this framework's own index DSL, so the
default one could never be served by a declared index. And a uniform order is now emitted as a row
comparison `(a, b) < ($1, $2)`, measured on PG16 as an `Index Only Scan` against `BitmapOr` + `Sort`
for the or-chain. The or-chain remains for an order you wrote as mixed yourself, and for one whose
keys are not all `NOT NULL`: a row comparison has no null ordering, so a NULL on either side makes
the whole comparison unknown.

**3. Rename the indexes that declare `where` or `order`.** A declared index is matched by name, so
the old one is not dropped and the new one is not created until you say so.

```sh
x db gen "rename partial and ordered indexes"   # then read the emitted up/down before applying
```

```sql
-- what the generated migration looks like, one pair per affected index
alter index posts_author_id_idx rename to posts_author_id_9f2c1ab4_idx;
```

The discriminator is `sha256("<order>|<where>")`, first 8 hex. **Plain and `unique()` names are
unchanged**, deliberately: Postgres names a column-level `unique()` index `<table>_<column>_key`
itself, so a discriminator there would make the generator emit a second `create unique index` for an
index that already exists (`42P07`), and a foreign key's own index is deduped against a hand-declared
one by the plain name.

Without it, two **different** partial indexes on one column were one name — `posts_author_id_idx` for
both `where status = 'published'` and `where status = 'draft'` — and the second was dropped with no
error, no warning and no drift finding. So this migration may create an index you declared years ago
and never had. A name over 63 bytes is now refused at declaration rather than truncated by the server
in silence.

**11. Redeploy clients and `sync` nodes together.** `PROTOCOL_VERSION` moves 1 → 2 and a skewed peer
is refused with `X_PROTOCOL_VERSION`, in **both** directions — a cursor rides the client's `subscribe`
and the node's `snapshot`, and the deleted fields were decoded through `str()` / `num()`, which throw
on absence. There is no rolling window in which the two versions interoperate.

```diff
- import { digestOf, DIGEST_UNVERIFIED, fnv1a } from '@ultimat3/realtime';
+ // nothing replaces them
```

`LiveCursor.digest` and `LiveCursor.count` are gone with them. Every snapshot ran `canonicalJson`
over every row and hashed it for a value no code path read — a full serialize-and-hash of every
result set, per live query, per reconnecting socket, in the restart storm this package is benchmarked
on. `count` would have been wrong had it ever gained a reader: `advance` seeds its set from the
already-truncated `ids`, so a delete past `CURSOR_ID_LIMIT` never decremented it. `@ultimat3/flags`
and `@ultimat3/ai` keep their own `fnv1a` and are untouched.

### Entries 7, 10, 12 and 15 — a caller can see the difference

**7. `introspect()` returns app tables only.**

| Relation | Before | Now |
|---|---|---|
| an ordinary or partitioned table | returned | returned |
| a view, a materialised view, a foreign table | returned | **excluded** |
| anything Postgres records as extension-owned (`pg_depend`, `deptype = 'e'`) | returned | **excluded** |
| a table someone created by hand | returned | returned, and still `unexpected-table` |

`IntrospectOptions.exclude` no longer decides the set on its own — it narrows what survives the rule
above, and cannot bring an excluded relation back. **This is what makes a stock managed Postgres
deployable**: `create extension pg_stat_statements` in `public` is the CNPG, RDS, Supabase and Neon
default, and its view read as `unexpected-table` with `x db gen "add pg_stat_statements"` as the
printed fix — so every deploy failed terminally and following the fix would have written an
extension's internal view into the app's migration set. Ownership rather than a name prefix, because
that rule covers the view and misses PostGIS's `spatial_ref_sys`.

**Edit only if a test asserts the statement count**: it issues four catalog queries where it issued
three.

**10. A downstream service now receives `x-request-timeout-ms`.** No edit on the calling side —
`traceHeaders()` is spread by both typed clients before your own headers, so an explicit value still
wins.

| Situation | Header sent |
|---|---|
| in a request with 12s left of its budget | `x-request-timeout-ms: 12000` |
| in a request whose budget is spent | none — **never `0`**, which the far side reads as "the caller asked for nothing" |
| in a job, a test, a browser | none; there is no ambient deadline |

The receiving end may only be **shortened** by it: `resolveTimeoutMs` takes the minimum of its own
configured budget and the header. Before this, a 30s gateway budget already spent to t=29 handed the
next service a fresh 30s, so work ran for another half minute holding a pool slot and a vendor
connection after the caller's socket had already been answered `X_TIMEOUT`.

**12. MCP callers are metered.** 120 read and 20 write per minute, per actor, per class —
`X_MCP_RATE_LIMITED`, 429, with `Retry-After`.

```ts
mcpHttpRoute({ server, resolveToken, rateLimits: { read: 600, write: 60 } });
// or defineAppMcp({ …, rateLimits: { read: 600, write: 60 } })
```

A `tools/call` naming a `destructive: true` tool spends `write`; **so does any call this server
cannot resolve**, fail-closed, so a probing client never gets the cheap bucket. Everything else,
`initialize` included, spends `read` — a coarse per-route rule would have thrown an agent off on its
handshake. The key names the actor and never reaches the caller.

**Behind more than one replica, pass the store too** — the default counts per process, which is
honest for `x mcp serve` and a lie for N replicas behind one URL, each enforcing the full allowance
on its own:

```ts
mcpHttpRoute({ server, resolveToken, rateLimitStore: postgresRateLimitStore({ executor }) });
```

`X_MCP_RATE_LIMITED` is its own code and not `X_RATE_LIMITED` because the knob differs: that one's
`fix:` names the HTTP pipeline's buckets, which do not govern this route, so raising them would run
and change nothing.

**15. Name the queue.** `X_JOB_CLAIM_QUEUES_EMPTY` from both drivers.

```diff
- await driver.claim({ queues: [], limit, visibilityTimeoutMs, workerId });
+ await driver.claim({ queues: ['default'], limit, visibilityTimeoutMs, workerId });
```

An empty list named no queue and meant two different things: **every** queue on the memory driver,
**the `default` queue** on Postgres, with `ClaimOptions.queues` documenting neither. Each meaning is
silently wrong in the other's deployment — one takes work this worker was never configured for, the
other drains nothing and reads as an idle queue. There is no third meaning to pick.

`createWorker` passes exactly one queue per pass, so only an embedder calling a driver directly is
affected. The memory driver's `claim` is now `async` to raise the refusal, so a caller that read its
return synchronously gets a `Promise`.

### Added and fixed in the same release, and none of it costs an edit

Read these if you built a workaround for one.

| Change | What it means |
|---|---|
| **read replicas** | `DATABASE_REPLICA_URL` plus a `withReplicaReads(fn)` scope. Opt in **twice** and byte-identical when unconfigured. Read-your-writes is the rule, not an option: one write at any depth pins the rest of the scope to the primary, and a transaction is always the primary's. Three consecutive replica failures park it for ten seconds. **The URL must name a read-only standby** |
| **`configureHttp()`** | the entire HTTP tuning surface — CORS origins, body limit, request timeout, max in-flight, rate-limit buckets — was reachable from **no app config key that existed**. `AppConfig` has never had an `http` member, so every `fix:` line naming `http.<key>` in `app.config.ts` resolved against nothing. Call it at module scope in a file under `apps/*/`. `rateLimit.scope` stays boot-owned |
| **a durable audit sink** | `postgresAuditSink({ executor })`, append-only, no purge — retention is a legal question with a different answer per app. The row is a fixed allow-list and never a walk of the `Ctx`, which on an HTTP surface carries the caller's `Authorization` and `Cookie` |
| **aggregates and containment** | `sum` / `avg` / `min` / `max` / `approximateCount`, and four containment operators. `min`/`max` on text is refused (Postgres orders by collation, JS by code unit); `avg` over money is refused, naming `sum()` + `count()` |
| **nullable sort keys order** | `asc nulls last` / `desc nulls first`, with the null position carried in the cursor. Only a nullable **primary-key** column is still refused — `null = null` is unknown, so the tiebreak cannot break a tie. The refusal also moved to plan time: it used to fire only when a next page existed, so it was green on 15 seeded rows and `X_INVARIANT_VIOLATED` on the first real read |
| **a `policy` gate step**, twentieth | every permission an app grants or requires must be one it declares. the scaffold shipped an app that answered `X_PERMISSION_UNKNOWN` on two of its three routes — status 500 — under a green gate. It skips in the framework monorepo, which declares no roles |
| **`X_MANIFEST_MISSING`** | an app root with no `x.manifest.json` fails the `manifest` step. Nothing ever ran `x manifest`, so the file did not exist in any app `x new` produced while the step reported green. Run `x manifest` once and commit it |
| **`scripts/declaration-readers.ts`** | every leaf key of every primitive declaration needs a reader in shipped source. 173 leaves across 18 roots, ratchet at zero |
| MCP `minLength` / `maxLength` count code points | the validator counted UTF-16 code units while the schema that publishes those numbers counts code points, so an astral-character argument was passed and then refused by the action's own parse, or refused outright on a bound the agent had obeyed |
| `x i18n add <locale>`, `x dev --port N` | a locale file that turned the gate red printing a fix that repaired nothing; and a dev server dying on port N+1 with a caught `Error` rendered into the cause and `X_CLI_UNEXPECTED` rather than a stable code |

## 10.x → 11.0.0, entry by entry

**Seven breaking entries, from a shutdown, cache and disclosure sweep.** Four are compile errors the
moment you upgrade. Three are not — and one of those changes what a CDN is allowed to store for a
signed-in visitor, so read entries 3, 4 and 5 even if nothing here fails to compile. **No
`app.config.ts` key moves in this major**, so there is no config edit to start with. No codemod.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | `isrKey(url, locale)` takes the negotiated locale, and it is part of the store key | you call `isrKey` — the document a multi-locale `isr` route serves changes either way |
| 2 | `IsrStore` gains a required `markStale(path)` | you implement `IsrStore` yourself |
| 3 | `HttpConfig.drainTimeoutMs` is `number \| null`, default `null` | you read the resolved field — and the drain budget moves 15s → 25s for an app that declared neither |
| 4 | an unclassified 5xx problem document carries no exception text | a client reads `title` / `detail` / `cause` off a 500 |
| 5 | a request carrying an identity gets `private, max-age=0`; every shared response varies on `cookie` and `x-timezone` | never — a CDN leak, closed. Personalised pages stop being shared-cacheable, which is the fix |
| 6 | `initialsOf(name, locale)` takes a required locale | you call `initialsOf` directly; `<Avatar>` is unchanged |
| 7 | `@ultimat3/pwa` deletes `RetryPolicy`, `DEFAULT_RETRY`, `retryDelayMs`, `shouldRetry` and `BackgroundSyncOptions.retry` | you imported one **from `@ultimat3/pwa`**. `@ultimat3/jobs` exports two of those names and is untouched |

### Entries 1, 2, 6 and 7 — a compile error the moment you upgrade

**1. Pass the negotiated locale to `isrKey`.** `TS2554`, one argument short.

```diff
- const served = await isr.serve(isrKey(url), () => renderPage(url));
+ const served = await isr.serve(isrKey(url, ctx.locale), () => renderPage(url));
```

`isrKey` is on `@ultimat3/render/server`, where 9.0.0 put it. The locale rides in a reserved query
parameter — `__x_locale`, exported as `ISR_LOCALE_PARAM` — and not as a prefix, because `routePathOf`
splits a key at its `?`: an `es:/blog` key matches no route, so `descriptorFor` answers `undefined`
and a declared `revalidate: { ttl }` silently becomes tag-only.

One entry per path served visitor 2 the document negotiated for visitor 1 — `<html lang>`, every
`t()` — for the whole TTL, and `s-maxage` told the CDN to do the same. `toResult` emits
`vary: accept-language` now for the CDN half; the rest of the shared key comes from `@ultimat3/http`'s
`cache-headers` stage, which sees the actor this function cannot.

The **time zone is deliberately not a dimension**: a locale set is declared and bounded, a zone list
is not. A date on an `isr` page belongs in a zone the page itself names, or the page belongs in `ssr`.

**2. Implement `markStale` in place.** Only a custom `IsrStore` pays this — `memoryIsrStore()` has it.

```diff
  const store: IsrStore = {
    get: (path) => map.get(path),
    set: (entry) => { map.delete(entry.path); map.set(entry.path, entry); },
+   markStale: (path) => {
+     const entry = map.get(path);
+     if (entry === undefined) return false;
+     map.set(path, { ...entry, stale: true });   // in place: the position IS the eviction order
+     return true;
+   },
    delete: (path) => { map.delete(path); },
    paths: () => [...map.keys()].sort(),
  };
```

**Never `set({ ...entry, stale: true })`** — that read-modify-write is the defect the member exists to
end. `set` means "this page was just generated" and a store is entitled to order eviction by exactly
that, so marking through it made the **stalest** page the newest: a tag bust protected the pages that
most needed regenerating.

Second half, and it costs nothing: `regenerate` samples a cache fence **before** the render and does
not store an entry the fence invalidated. A bust landing mid-render was previously erased by
`store.set({ stale: false })`, and for a tag-only route `isFresh` is true forever — so the process
served pre-write HTML for the rest of its life.

**6. Pass the locale to `initialsOf`.** `TS2554`.

```diff
- initialsOf(member.displayName)
+ initialsOf(member.displayName, useUi().locale)
```

`<Avatar>` reads `useUi().locale` itself, so a component tree pays nothing. A bare
`toLocaleUpperCase()` reads the **runtime's** default locale — a server's `LANG`, a browser's UI
language, never the request's — so one Turkish name uppercased to `İ` on the server and `I` in the
browser, out of identical props. `@ultimat3/ui` has no ambient locale to fall back on, by rule.

**7. Delete the import; there is nothing to replace it with.** `TS2305`.

```diff
- import { backgroundSyncSource, DEFAULT_RETRY, type RetryPolicy } from '@ultimat3/pwa';
+ import { backgroundSyncSource } from '@ultimat3/pwa';

- backgroundSyncSource({ flushEndpoint, retry: { ...DEFAULT_RETRY, maxAttempts: 5 } });
+ backgroundSyncSource({ flushEndpoint });
```

`BackgroundSyncOptions` is `{ flushEndpoint?: string }` and nothing else — in this release. 21.0.0
removes it as well, together with the flush route; see entry 8 of `20.x → 21.0.0`. This package schedules no
retry and never did: the one-shot `sync` handler rejects and the **platform** decides when to wake it
again. Of the policy only `maxAttempts` reached the emitted worker, as a `SYNC_MAX_ATTEMPTS` constant
nothing read, and `X_PWA_SYNC_INCOMPLETE`'s `fix:` told the reader to raise
`pwa.backgroundSync.retry.maxAttempts` — a key `PwaConfig` has never carried, because
`backgroundSync` is a boolean. [Error codes](Error-Codes) already says so.

**`@ultimat3/jobs` is a different package carrying two of those names.** `RetryPolicy` and
`DEFAULT_RETRY` are still exported from it, still read by the worker, unchanged. Only pwa's copies are
gone, and a `RetryPolicy` on a `job()` is not one of them.

### Entries 3, 4 and 5 — nothing fails to compile, and a caller can see the difference

**3. `drainTimeoutMs` is `number | null`, and `null` means "this app did not say".**

| What the app declared | Drain deadline before | Now |
|---|---|---|
| nothing | 15,000ms | **25,000ms** — core's own `DEFAULT_DEADLINE_MS` |
| `configureLifecycle({ deadlineMs: 600_000 })` | **15,000ms** — reverted by the next line of boot | 600,000ms |
| `defineHttpConfig({ drainTimeoutMs: 5_000 })` | 5,000ms | 5,000ms |

`createServer` calls `configureLifecycle({ deadlineMs })` only when the app declared one
([`packages/http/src/server.ts:101`](https://github.com/developerz-ai/ultimate/blob/main/packages/http/src/server.ts#L101)).
Unconditional, with `defineHttpConfig` defaulting the number, that line reverted the exact edit
`X_SHUTDOWN_TIMEOUT`'s own `fix:` prints — silently, in every process that serves web.

**Edit only if you relied on the 15s default** — write it down:

```diff
- defineHttpConfig({ rateLimit: { scope: 'process' } })
+ defineHttpConfig({ rateLimit: { scope: 'process' }, drainTimeoutMs: 15_000 })
```

The INPUT field is still `number | undefined`, so a declaration compiles unchanged. The RESOLVED
field is `number | null`, so `const ms: number = config.drainTimeoutMs` is `TS2322` — that is the
compile half, and it reaches only a caller that reads the merged config back.

**4. An unclassified 5xx says nothing about the exception that caused it.**

| Member | On a 5xx nobody classified | On a coded refusal |
|---|---|---|
| `type`, `status`, `code`, `fix`, `docs`, `requestId` | unchanged | unchanged |
| `title` | `unhandled server error` | the code's own title |
| `detail`, `cause` | one fixed sentence pointing at this process's logs, under the request id | the authored cause |

"Unclassified" is `X_INTERNAL`, or a code with no row in `@ultimat3/http`'s table **and** no
`registerErrorStatus` row — deliberately not `status >= 500`, which would have blanked `X_DRAINING`'s
one instruction. `dev: true` is unchanged, and the text is not lost: the `error-map` stage logs it as
a redactable field and reports every 5xx to the error monitor, both keyed by `requestId`.

A `pg` message quoting the rejected row, a driver message quoting the DSN, went to any non-HTML client
in production. `error-page.ts` had locked the browser out of exactly this, so the two audiences
disagreed about one condition.

**Edit only if a client parsed those members.** Match on `code`, correlate on `requestId`. A 5xx of
your own that should keep its authored cause needs a status of its own — that is what makes it
classified:

```ts
registerErrorStatus({ X_PAYMENTS_UNREACHABLE: 502 });   // from @ultimat3/http, once at boot
```

**5. A request carrying an identity is `private, max-age=0`, whatever the handler declared.**

```diff
- cache-control: public, max-age=0, s-maxage=30, stale-while-revalidate=300
+ cache-control: private, max-age=0
```

The `cache-headers` stage **reviews** a `cache-control` the handler wrote instead of standing down: a
declaration offering the response to a shared cache (`public`, or an `s-maxage`) plus a non-anonymous
actor is replaced. `immutable` is the one exception — it asserts the body is a function of the URL
alone, which a content-addressed island chunk or image is, and demoting those re-downloads every
chunk on every navigation for every signed-in user.

An **anonymous** shared response is unchanged except that it now carries
`vary: accept-language, cookie, x-timezone`. Both halves are needed: `private` for the identified
request, `vary: cookie` for the shared one.

What was happening: `ssrHeaders` offers any route without a `policy` to a CDN for 30 seconds, and
`meta.auth` is `'public' | 'required'` — so the commonest page in any app, public but greeting you by
name when you are signed in, is a `'public'` route whose own header said `s-maxage`. That is the shape
`x g route --surface app` scaffolds.

**No edit, and expect the shared-cache hit rate on personalised pages to go to zero** — that is the
fix, not a regression. A route that really is a function of the URL alone says so:
`cache-control: public, max-age=31536000, immutable`.

### Fixed in the same release, and none of it costs an edit

Read these if you built a workaround for one.

| Fix | What stops happening |
|---|---|
| the framework's CSP admits its own hydration runtime in production | **no island booted after deploy, anywhere the policy is enforced.** `script-src` was `'self' 'wasm-unsafe-eval'` with no hash while the runtime is an inline module — report-only under `x dev`, enforced in a container. `startWeb` now hashes the seven `HYDRATE_RUNTIME_BODIES` into `script-src`, as it already did for styles |
| a browser gets an error page, not `problem+json` | a 404 or a 500 rendering the internal `cause` and the author-facing `fix:` into a visitor's window. Copy is the catalog's `errors.*` keys; override per status with `apps/web/site/errors/<status>.html`, and `x dev` keeps the overlay |
| `worker`, `scheduler` and `sync` drain in two phases, and `holdUntilShutdown` reaches the exit | one `accept` hook spending the whole budget before "stop listening" and "stop upgrading" had been invoked at all — 4 hooks started, none finished — and an overrun wedging the process until the kubelet's SIGKILL, where the job lease lapsed and another worker re-ran it. **Behaviour change**: a job outrunning `configureLifecycle({ deadlineMs })` is abandoned (`jobs.worker.drain-abandoned`) and the queue redelivers it, where the teardown used to hang forever with the driver open. Raise the budget past your slowest job |
| a worker's fleet slot is released before the driver closes, and a renewal interval is `unref`ed | a `concurrency: 1` job unclaimable by the replacement pod for a full visibility window after every deploy, and a refed interval holding a drained process open until SIGKILL |
| the scheduler re-asserts leadership before **every** task, not once per round | the tail of a round dispatching under a lease another node already took. The occurrence key does not absorb it: `SQL_ENQUEUE`'s conflict target is partial over the live states, so a duplicate landing after that job finished inserts a new row and the handler runs twice |
| a replayed backfill batch writes no ledger row | 4,800 `x_backfills` UPDATEs before a resumed 5M-row sweep read a single new row, on every attempt, inside the visibility lease |
| a server render gets a live client instead of a 500 | a page whose body reads a live query failing on the server; it renders its loading branch and the browser takes over on hydrate. `mutate()` / `drain()` there are `X_LIVE_SERVER_RENDER` |
| `createLogger({ level: 'verbose' })` is refused at construction | an unknown level failing **open** — every level emitted |
| one documented first run, and it is `bin/setup` | `cd myapp && x dev` failing on `X_BUILD_FAILED` because `x new` installs nothing — which eight doc pages, and `x new`'s own closing line, told the reader to do. `wiki/Installation.md` also listed six `x new` flags that do not exist |

## 9.x → 10.0.0, entry by entry

**Nineteen breaking entries, from a twelve-audit correctness sweep.** Every one deletes or corrects
a declaration that promised something the code did not do. **One `app.config.ts` edit.** Six compile
errors. Five that no compiler will find — read those even if nothing else here applies. Four refuse
a declaration that was *already* broken, and three are corrected underneath you at no cost. No
codemod.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | `ERROR_DOCS_BASE` and `errorDocsUrl(code)` are deleted | you construct an `UltimateError` with an explicit `docs:` |
| 2 | a problem document's `type` is `urn:ultimate:error:<CODE>` | a client matches on that string |
| 3 | `@ultimat3/time` refuses a malformed locale with `X_LOCALE_INVALID` | you catch `RangeError` around a formatter |
| 4 | `realtime.tier` and `RealtimeTier` are deleted | your `app.config.ts` sets `realtime.tier` — **the one config edit in this major** |
| 5 | the WAL decoder returns parsed values, not Postgres' own text | you name `PgOutputMessage`, `entityRow` or `PhysicalRow` |
| 6 | a delta resume no longer seats a pre-policy cursor | never — a cross-tenant leak, closed |
| 7 | `verifyDigest()` is deleted from `@ultimat3/realtime` | you called it, which nothing could have |
| 8 | `defineAuth({ providers })` defaults to `[]` | you serve an OAuth route and name no provider |
| 9 | `@ultimat3/auth` writes `x_accounts.access_token` / `refresh_token` as `null` | your own SQL reads either column |
| 10 | a multi-audience id token needs a matching `azp`; a future `nbf` is refused | your OAuth provider issues multi-audience id tokens, or a host clock is ahead |
| 11 | `MemoryAdapter.createUser` enforces `x_users`' two UNIQUE constraints | a test registers one address twice |
| 12 | two admin resources may not claim one `path:` | your `defineAdmin` already had four screens unreachable |
| 13 | `registerLayout(name, layout)` refuses a name already taken | two modules register one layout name |
| 14 | `assertReadOnly` returns a `ReadOnlyVerdict` | you call it from `@ultimat3/admin/dev` |
| 15 | `generate()` no longer collects a LOCAL refusal | you catch `X_AI_PROVIDER_UNAVAILABLE` to mean "the model call failed" |
| 16 | `@ultimat3/render`'s graph-based island budget API is removed | you imported `routeJsBytes`, `graphFor`, `checkBudget`, `checkBudgets` or `assertBudget` |
| 17 | `@ultimat3/pwa`'s `routeRules` orders by specificity, wildcards last | you ship a generated `sw.js` |
| 18 | `subscriptionState` takes a `Clock` | you passed epoch milliseconds |
| 19 | `StaticReport` gained a required `unmeasured` | you construct one by hand |

### Start here — the one config edit

```diff
  realtime: {
    enabled: true,
-   tier: 'live-queries',
    transport: 'nats',
    urlEnv: 'NATS_URL',
  },
```

`TS2353`, and nothing else. `RealtimeConfig` is `{ enabled, transport, urlEnv }` —
[`packages/core/src/config.ts:132`](https://github.com/developerz-ai/ultimate/blob/main/packages/core/src/config.ts#L132).

`tier` accepted `'channels' | 'live-queries' | 'local-first'`, defaulted, was documented with
per-value semantics, and was set by both tracked apps and every scaffolded app — and **nothing read
it**. No comparison, no branch, no dereference. `tier: 'local-first'` bought exactly what
`'channels'` bought, and the durable local store it advertised does not exist. Which tier an app is
on is decided by what it **declares**: a `channel()` topic, a `live: true` query, a local store.

**Leaving the line in also works, and that is the hazard.** `section()` copies an unknown key
through, so a stale `tier:` still boots and still does nothing; an app that builds its config into a
variable before passing it to `defineConfig` loses excess-property checking and sees no error at
all. Same shape as `jobs.driver` in 5.0.0 and `realtime.heartbeatMs` in 4.0.0 — the thirteenth
instance of that class. `bun run scripts/config-readers.ts` is what keeps the fourteenth out.

### Entries 1, 7, 14, 16, 18 and 19 — a compile error the moment you upgrade

**1. Omit `docs:`; do not substitute the new constant.**

```diff
- import { errorDocsUrl, UltimateError } from '@ultimat3/core';
+ import { UltimateError } from '@ultimat3/core';

  export class BillingDeclinedError extends UltimateError {
    constructor(cause: string) {
-     super({ code: 'X_BILLING_DECLINED', cause, fix: 'retry with another card', docs: errorDocsUrl('X_BILLING_DECLINED') });
+     super({ code: 'X_BILLING_DECLINED', cause, fix: 'retry with another card' });
    }
  }
```

The constructor already resolves `docs` from the registry, so passing it by hand is a second
declaration of one fact. `ERROR_DOCS_URL` is exported from `@ultimat3/core` for a caller rendering
the link *outside* an error — not as a drop-in for the deleted function.

Why: `https://ultimate.dev/errors/<code>` answered **HTTP 404**, host included, on every error this
framework has ever thrown, including the first line a new agent reads. One URL rather than one per
code, because codes live on [Error codes](Error-Codes) in **table rows** and a row has no anchor —
a `#X_DB_DRIFT` fragment would be a second dead declaration, not a fix for the first.

**7. Delete the `verifyDigest()` call.** That is the whole migration, and nobody had one to delete:
a delta-resumed cursor carries `DIGEST_UNVERIFIED`, so the check answered `false` for every cursor
drift can occur in, and `identity-map.ts` merges columns across queries by design — any app with two
reads over one entity would have reported permanent drift. Drift is the server's `desynced` mark.

**14. `assertReadOnly` returns a verdict, and the verdict carries the string to run.**

```diff
- const refusal = assertReadOnly(sql);
- if (refusal !== null) return { refused: refusal };
- const rows = await client.query(sql);
+ const verdict = assertReadOnly(sql);
+ if (verdict.kind === 'refused') return { refused: verdict.refused };
+ const rows = await client.query(verdict.sql);
```

`ReadOnlyVerdict` is `{ kind: 'runnable'; sql } | { kind: 'refused'; refused }`. **Execute
`verdict.sql`, never the string you passed in**: every check ran on a stripped form and the verdict
is the reconciled one. The `/_x` panel discarded it and ran the textarea's own bytes, so two callers
of one guard disagreed about which string runs.

**16. Delete the import.** Removed from `@ultimat3/render`: `routeJsBytes`, `graphFor`,
`checkBudget`, `checkBudgets`, `assertBudget` and their types. Every one was exported from the
barrel and called by nothing; the budget gate that actually runs is `@ultimat3/cli`'s and it
measures the emitted document. `parseByteBudget`, `defaultIslandBudget` and `islandModuleIds` are
unchanged.

**18. `subscriptionState` takes a `Clock` where it took epoch milliseconds** — `TS2345` on a
`number`. The parameter is optional and defaults to `systemClock`, so most callers delete an
argument:

```diff
- subscriptionState(record, lastStatus, Date.now())
+ subscriptionState(record, lastStatus)
+ subscriptionState(record, lastStatus, frozenClock(NOW))   // a test, from @ultimat3/core
```

**19. `StaticReport` gained a required `unmeasured`** — every budgeted route a build could not
weigh, with the reason, which is the list `X_BUDGET_UNMEASURED`'s `fix:` cites by name and which
until now reached no `x` command's output at all.

```diff
  const report: StaticReport = {
    target: 'static', out, buildId, emitted, skipped,
+   unmeasured: [],
  };
```

**Reading one costs nothing**: `parseStaticReport` takes the field as optional and answers `[]` when
it is absent, so a `.x/static-report.json` written by an older build still parses. Only
hand-construction moves.

### Entries 2, 3, 8, 15 and 17 — nothing fails to compile, and a caller can see the difference

**2. A problem document's `type` is a URN, per code.**

```diff
- if (problem.type === 'https://ultimate.dev/errors/X_RATE_LIMITED') …
+ if (problem.type === problemTypeFor('X_RATE_LIMITED')) …
```

`problemTypeFor(code)` is `urn:ultimate:error:${code}`, exported from `@ultimat3/http`. **`code` is
unchanged and is the simpler match** — `problem.code === 'X_RATE_LIMITED'` needs no import. `type`
and `docs` used to carry the same dead link on every 4xx and 5xx; they are two values now because
they answer two questions — `type` is RFC 9457's identifier for the problem *kind*, a URN so it has
no host left to rot, and `docs` is the one wiki page.

**3. A malformed locale is refused with a code instead of dying as a bare `RangeError`.**

| Tag | Before | Now |
|---|---|---|
| `en`, `en-GB`, `de-DE` | formats | formats |
| `zz` — well-formed, unknown | `Intl` falls back | `Intl` falls back, **still not refused** |
| `en_US`, `''`, a raw `Accept-Language` value | bare `RangeError` out of `Intl`, several frames from the header it came from | `X_LOCALE_INVALID`, with a runnable `fix:` |

Every `@ultimat3/time` entry point taking a `locale` passed the caller's raw tag to an `Intl`
constructor. `assertLocale` is the single gate now, and the list is one command:

```sh
grep -rn 'assertLocale(' packages/time/src
```

**Edit only if you catch `RangeError`** around a formatter; screen header input with
`Intl.DateTimeFormat.supportedLocalesOf([tag])`. The code's row is on [Error codes](Error-Codes).

**8. `defineAuth({ providers })` defaults to `[]`, not the live OAuth registry.**

```diff
  export const auth = defineAuth({
    adapter,
+   providers: ['github', 'google'],
  });
```

An app already passing `providers:` needs nothing. An app that passed none now serves **no**
`/auth/oauth/<id>` route — name the ones you mean. The default was every provider any dependency had
registered, so the uniform 404 the option exists for could never fire, and an import decided the
app's login surface. With the credentials fix in the same release, that closed an enumeration
oracle: 500 meant registered, 404 meant not, and the 500 published the app's own `*_CLIENT_ID` and
`*_CLIENT_SECRET` names.

**15. `X_AI_PROVIDER_UNAVAILABLE` now means one thing: the transport failed, on every provider
tried.** A *local* refusal reaches the caller with its own code and its own runnable `fix:`.

| Code | Raised when | Its `fix:` |
|---|---|---|
| `X_AI_KEY_MISSING` | no key configured and none passed | `export ANTHROPIC_API_KEY=<key>`, or pass `{ apiKey }` to the provider |
| `X_AI_REQUEST_INVALID` | a reasoning control the chosen model does not have | set `model:` on the `llm()` request |
| `X_AI_PROVIDER_UNAVAILABLE` | a non-2xx, an in-band `error` event, or a stream cut before `message_stop` | retry, or configure a second provider |

A `catch` treating `X_AI_PROVIDER_UNAVAILABLE` as "the model call failed" stops seeing the two
misconfigurations, which is the point: collecting one discarded its instruction and made
`generate()` and `stream()` answer one misconfiguration two ways.

**17. Regenerate `sw.js` — with the call, because no command writes it.** `x build` emits no service
worker and nothing in the framework calls `generateServiceWorker`; the generated file's own
`regenerate:` header names the call for that reason.

```ts
generateServiceWorker(routes, config, buildId);   // from @ultimat3/pwa
```

The emitted file changes for any app with a dynamic route above a static sibling. `ruleFor` returns
the **first** pattern that matches and the order was alphabetical: `:` (0x3A) and `*` (0x2A) sort
before every letter, so `/posts/:id` shadowed `/posts/new`, and a single `/*` shadowed the whole
table — every `PRECACHE_MANIFEST` entry downloaded at install and then never looked up. Path is
still the tie-break, so identical input still emits an identical file.

### Entries 10, 11, 12 and 13 — a refusal of something that was already broken

**If one of these fires, your app was half-broken before the upgrade** — each produced a declaration
that was silently unreachable, not a rule the framework tightened for its own sake. The refusal
names the finding.

| # | Refuses | Code | What had been happening |
|---|---|---|---|
| 10 | an id token naming several audiences whose `azp` is not this client, and an `nbf` in the future | `X_OAUTH_TOKEN_INVALID` | both only narrow, on the `ID_TOKEN_CLOCK_SKEW_MS` `id-token.ts` already exported to `workload.ts` and did not itself enforce — an `nbf` ten years out verified, and a token an OP minted for another client that also lists yours verified with it (OIDC Core 3.1.3.7) |
| 11 | a second `x_users` row with one `email`, or with one `external_id` | `X_AUTH_WRITE_FAILED` | `MemoryAdapter` is what `x new` scaffolds and what every test runs against, so the duplicate path was exercised only against the permissive half of the seam: two `register()` calls at one address made two rows, and the second was unreachable forever |
| 12 | two `defineAdmin` resources claiming one `path:` | `X_ADMIN_PAGE_PATH_INVALID` | eight routes over four paths, with the second resource's four screens silently unreachable. The `fix:` hands you a `path:` for one of them |
| 13 | `registerLayout(name, …)` on a name already registered | `X_MAIL_DUPLICATE` | `layouts.set` answered whichever module ran last, `base` included, so a dependency could re-shell every framework mail in silence |

### Entries 5, 6 and 9 — corrected underneath you

| # | What changed | What you do |
|---|---|---|
| 5 | the WAL decoder returns the values a repository row holds. `PgOutputDecoder` decoded a `timestamptz` as `'2026-08-09 12:00:00+00'`, a `text[]` as `'{a,b}'` and a `bytea` as `'\x0102'`, while the shared live window holds rows `@ultimat3/entity` parsed — and `compareValues` normalises a `Date` to its epoch, so **an edit to any column of any row jumped that row to the top of every `orderBy('createdAt', 'desc')` feed for every subscriber**, carrying the raw string into the window. `post.tags.map(…)` threw on the first patch | nothing, unless you name `PgOutputMessage`, `entityRow` or `PhysicalRow` from `@ultimat3/realtime/server` — `after`/`before` and `entityRow`'s return widen to `PhysicalRow`. It is a wire **convergence**: only a real walsender diverged, because `setRowObserver` emits already-parsed rows and the parity test handed the same object to both sides |
| 6 | a delta resume no longer seats a pre-policy cursor. `resumeFrom` advanced across the retained patch list, which is pre-policy by design, so a subscriber reconnecting inside the retain window gained the id of every row inserted for every **other** actor while it was away — and then received a `delete` frame carrying another tenant's row id | nothing. The leak `subscriber-gate` exists to close, re-opened one layer up and closed again |
| 9 | `@ultimat3/auth` no longer persists provider access or refresh tokens. `x_accounts.access_token` and `refresh_token` held live third-party credentials in the clear under a `tables.ts` header promising "no column holds a plaintext secret", and nothing ever read either one back | nothing, unless **your own** SQL selected either column — both are written `null` now. The type and the DDL are unchanged; keep a token you actually call out with in your own table, encrypted |

### Fixed in the same release, and none of it costs an edit

Read these if you built a workaround for one.

| Fix | What stops happening |
|---|---|
| `Gateway.stream()` resolved the provider between `reserve()` and the `try/finally` that releases it | a registered model no configured provider serves debited the estimate and never credited it back — on `MemoryBudgetStore`, which is per process and never expires, **five refused streams spent an org's whole ceiling with nothing ever sent**, and every later call was `X_AI_BUDGET_EXCEEDED` for the life of the process ([#319](https://github.com/developerz-ai/ultimate/issues/319)) |
| a successful login cleared the per-IP failure bucket | one credential the attacker owns bought unlimited stuffing — 4 guesses, 1 login, repeat: 160 guesses from one address against a 5-attempt limit, never locked ([#317](https://github.com/developerz-ai/ultimate/issues/317)) |
| the OAuth callback published uncoded internal exception text to an unauthenticated caller | connection strings and bind passwords reaching the browser, on two independent paths. The token-endpoint body is no longer reflected either — that request carries `client_secret` ([#318](https://github.com/developerz-ai/ultimate/issues/318)) |
| `readonly-sql` ended a `--` comment at `\n` only | a CR terminated the comment for Postgres and not for the scanner, hiding the payload from all four layer-3 checks — including `select pg_advisory_lock(42)`, whose **session** lock survives `ROLLBACK` and outlives the read on a pooled connection ([#316](https://github.com/developerz-ai/ultimate/issues/316)) |
| `diffRows` threw on a `money()` column | every `adminUpdate` on a money-bearing entity failed with an uncoded `TypeError` **after** `repo.update()` committed, landing zero audit entries ([#321](https://github.com/developerz-ai/ultimate/issues/321)) |
| `x db gen --allow-destructive` emitted a migration Postgres refuses | `drop table` with no preceding FK drop, tables ordered alphabetically rather than by dependency — `SQLSTATE 2BP01` during `ROLE=migrate`, with a `down` that cannot restore |

## 8.x → 9.0.0, entry by entry

**Five breaking entries, from closing the ten findings the 8.0.0 sweep filed rather than absorbed.**
Four are compile errors the moment you upgrade. The fifth changes what your cache ladder *is*, at
runtime, and it is the one to read even if nothing else here applies. No codemod.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | `@ultimat3/render` splits into `.` and `./server` | you import a build-time name, or relied on importing the barrel to install the `.tsx` loader |
| 2 | `cache.tiers` names the ladder's own rungs, and is now read | your `app.config.ts` sets `cache.tiers` — **runtime behaviour changes even if it compiles** |
| 3 | `@ultimat3/storage` renames `IMAGE_FORMATS` / `ImageFormat` | you imported either |
| 4 | `@ultimat3/pwa` drops the forced-reload half of `version-skew` | you called `updateSignal` or `updatePolicy` |
| 5 | `@ultimat3/core` replaces `CacheTier` with `CacheTierName` | you named the type |

### 1. `@ultimat3/render` splits into `.` and `./server`

```diff
- import { defineRoute, renderToHtml } from '@ultimat3/render';
+ import { defineRoute } from '@ultimat3/render';
+ import { renderToHtml } from '@ultimat3/render/server';
```

55 names moved: the render pipeline (`renderToHtml`, `renderSsr`, `renderStatic`, `renderStreamHtml`,
the ISR controller) and the loaders (`installRenderLoader`, `compileStylesheet`, `stylesFor`,
`transformTsx`). `.` keeps the authoring vocabulary — `defineRoute`, `h`, `Fragment`, `island`,
`hydrate*`, the registry, the mode tables.

**Second, easily-missed half: importing `@ultimat3/render` no longer installs the `.tsx`/`.scss`
loader.** `@ultimat3/render/server` does. A test that did `await import('@ultimat3/render')` before
loading a page module must now import `/server`.

Why: `bun build --target=browser` on the barrel failed outright — *"Browser polyfill for module
`node:url` doesn't have a matching export named `fileURLToPath`"*, out of `css-modules.ts`. The
island this framework tells you to write could not be bundled.

### 2. `cache.tiers` names the ladder's rungs, and the ladder is now that declaration

```diff
- cache: { tiers: ['memo', 'lru', 'shared', 'isr'] }
+ cache: { tiers: ['request-memo', 'lru', 'redis'] }
```

`memo` → `request-memo`, `shared` → `redis`, and **delete `isr`** — it is a `RenderMode`, and the
routes that want it declare `render: 'isr'`. It named a cache rung that never existed.

**Read this even if your config already compiles.** The key was previously read by *nothing*:
`startCacheTiers` registered memo + lru unconditionally, redis on `REDIS_URL`, cdn on a purge
credential. An app declaring `tiers: ['request-memo']` measurably got
`['request-memo', 'lru', 'redis', 'cdn']`. Now the ladder is the declaration, which means:

- naming a rung the environment cannot supply **refuses the boot** — `redis` without `REDIS_URL`,
  `cdn` without a purge credential — rather than quietly building a shorter ladder
- an environment offering a rung the config does not name logs `cache.tier.unnamed` and builds nothing

If you relied on the old always-on `lru`, or on `REDIS_URL` adding a tier your config never
mentioned, **name it**.

### 3. `@ultimat3/storage` renames its image vocabulary

```diff
- import { IMAGE_FORMATS, type ImageFormat } from '@ultimat3/storage';
+ import { VARIANT_FORMATS, type VariantFormat } from '@ultimat3/storage';
```

Both packages exported those two names over **different sets**, so a storage caller narrowing on
storage's type had a type saying `gif` cannot occur and a value from core's probe that was one. If
you were probing rather than minting variants, the six-format set is `IMAGE_FORMATS` from
`@ultimat3/core` — which is what you actually had.

`variantKey()` also now refuses a format outside `VARIANT_FORMATS` instead of returning a key ending
`.undefined`.

### 4. `@ultimat3/pwa` drops the forced-reload half of `version-skew`

Removed: `updateSignal`, `updatePolicy`, `DEFAULT_GRACE_MS`, and the types `ForceReason`,
`UpdatePolicy`, `UpdatePolicyInput`, `UpdateSignalInput`. `AppUpdateAvailable` narrows to
`{ type, to }`, losing `from`, `forced` and `deadlineAt`.

Nothing performed the reload they described, and no runtime could have called them: `@ultimat3/http`
(tier 2) and `@ultimat3/realtime` (tier 3) both sit *below* `pwa` (tier 4). **Forcing a reload is not
a capability this framework has.** Notification is, and is complete — read
`useConnection().updateAvailable`, or compare the worker's posted `to` with `detectSkew`, and render
your own affordance.

### 5. `CacheTier` → `CacheTierName` in `@ultimat3/core`

The type behind entry 2. `@ultimat3/cache` still exports a `CacheTier` — it is the tier *interface*,
a different thing, and it is unchanged. The two sharing one name is what made a type error about
`CacheTier` unreadable.

## 7.x → 8.0.0, entry by entry

**Six breaking entries, from one whole-repo bug sweep.** Five are compile errors the moment you
upgrade. The sixth is a **silent** behaviour change, and it is the one to read even if nothing else
here applies to you. No codemod.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | `@ultimat3/realtime` has two entries | you import a **server** name — NATS, pg replication, the sync node, the channel hub |
| 2 | `IdempotencyStore.settle` / `fail` take a reservation id | you call either, **or implement the interface** |
| 3 | `pwa.installPrompt`, `auth.afterSignInPath`, `ai.modelEnv` deleted | your `app.config.ts` sets one |
| 4 | `@ultimat3/manifest` drops `canonical` | you imported it |
| 5 | `@ultimat3/render` drops `matchRoute` / `RouteMatch` | you imported either |
| 6 | `SQL_CANCEL` projects its columns | you asserted on that constant's text |

### 1. `@ultimat3/realtime` splits into `.` and `./server`

```diff
- import { ChannelHub, createSyncNode, LiveQueryRegistry } from '@ultimat3/realtime';
+ import { ChannelHub, createSyncNode, LiveQueryRegistry } from '@ultimat3/realtime/server';
```

Client names — `useLive`, `liveHookFor`, `LiveClient`, the offline queue, rebase, the wire protocol,
cursors — are **unchanged on `.`**. A file importing both halves now writes both imports.

Why: the single barrel carried `useLive` beside `openNatsClient`, so `bun build --target=browser` on
an entry importing *only* the hook failed with *"Browser build cannot require() Node.js builtin:
`stream/web`"*, out of `nats`. **The island this framework tells you to write could not be bundled.**

The two barrels are **disjoint** — `./server` re-exports no client name — so which half a symbol
lives in is checkable rather than conventional. If an import stops resolving, the name moved to
`./server`; nothing was deleted.

### 2. `IdempotencyStore.settle` and `fail` take the reservation id

```diff
- await store.settle(key, value);
+ await store.settle(key, value, reservation.record.id);
```

`reservation` is what `store.reserve(key, hash)` answered. Same shape for `fail`.

**Read this if you implement the interface — it is the one silent entry in this major.** A store with
the old two-parameter method **still compiles**, because a shorter function is assignable to a longer
signature, and it **silently loses the fence**. Both statements now match on **id and state**, so a
straggler from a slow first attempt can no longer overwrite a replacement reservation still in
flight. The `fail` half was the worse one: a straggler's failure marked a *live* replacement
`failed`, and the replacement's own settle was then fenced out.

### 3. Three config fields are deleted

```diff
- pwa: { enabled: true, offline: 'runtime', installPrompt: true },
+ pwa: { enabled: true, offline: 'runtime' },
- auth: { signInPath: '/signin', afterSignInPath: '/dashboard' },
+ auth: { signInPath: '/signin' },
- ai: { mcp: { expose: true, path: '/mcp' }, modelEnv: 'ANTHROPIC_MODEL' },
+ ai: { mcp: { expose: true, path: '/mcp' } },
```

**There is no replacement key, because there was never a behaviour.** Each was declared, defaulted,
merged, and read by nothing. Use `createInstallController` from `@ultimat3/pwa`, send the visitor
from your own sign-in route, and pass `model` on the `llm()` request.

`ai.modelEnv`'s own doc comment argued for its deletion: *"an intention, not a behaviour… nothing
consumes the merged value… So the exact thing this key exists to prevent — a model string baked into
the image — is what actually happens."*

Same precedent as `JobsConfig.driver` in 5.0.0 and `realtime.heartbeatMs` in 4.0.0. All three fail at
**typecheck only** — and an app that builds its config into a variable before passing it loses
excess-property checking and sees no error at all. `scripts/config-readers.ts` now keeps the class out.

### 4. `@ultimat3/manifest` no longer exports `canonical`

Use `canonicalJson` from `@ultimat3/core`. It was the third of five copies of one serialiser;
`manifest`'s fed `buildId` **and the contract-diff equality**, so a `-0`/`NaN`/`Date` fold could make
a breaking API change diff as *"no change"* and ship silently.

### 5. `@ultimat3/render` no longer exports `matchRoute` or `RouteMatch`

Two exported route matchers existed with different precedence. `@ultimat3/http`'s trie is the live
one; render's had zero consumers repo-wide.

### 6. `SQL_CANCEL` projects its columns instead of `returning *`

It fed `toJobRecord`, which does `Number(row.run_at)` — so against a text-decoding `PgExecutor` every
timestamp came back `NaN`. Only an edit if you asserted on the constant's SQL text.

## 6.x → 7.0.0, entry by entry

**Four breaking entries, and only one of them can reach you at runtime.** Three are compile errors
the moment you upgrade; the fourth is a type you may never have named. None ships a codemod.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | `ScrapeTarget.pageErrors` | you implement `ScrapeDriver`/`ScrapeTarget` yourself |
| 2 | `PwaRenderMode` | you import that type name |
| 3 | `PwaOfflineStrategy` | you import that type name |
| 4 | `PrerenderReport.skipped` | you read `x build --target static --json`, or the report in code |

### 1. `ScrapeTarget` gains a required `pageErrors: PageErrorRing`

**Only a third-party driver author pays this**, and nothing in an ordinary app implements
`ScrapeTarget`. If you build one — the shape `packages/scraping/README.md`'s driver-author example
builds — construct the ring and, if your transport can observe uncaught page exceptions, push to it.

```diff
+ import { createRing, type PageErrorRing } from '@ultimat3/scraping';

  const target: ScrapeTarget = {
    // …
+   pageErrors: createRing(200),
  };
```

A driver that **cannot** observe them builds the ring and never pushes — which is exactly what the
offline targets do. That is the whole migration.

**Required rather than optional, deliberately.** An optional ring lets a driver stay *silent* about
errors it can see, which is the gap this closed: nothing in `@ultimat3/scraping` subscribed to
`pageerror` at all, so an island that **threw** was invisible. A throw calls no console method, so
`console()` answered `[]` and a page whose script had died read as clean.

New on `ScrapePage`, and additive — no edit needed to consume them: `pageErrors()` and
`pageErrorsDropped()`. The dropped count makes the list a **floor**, not a total.

### 2 and 3. `PwaRenderMode` and `PwaOfflineStrategy` are deleted from `@ultimat3/pwa`

Two type-only renames. No member changed — only the name the type is declared under.

| Was | Is | Members, unchanged |
|---|---|---|
| `PwaRenderMode` | `RenderMode` | `'static' \| 'isr' \| 'ssr' \| 'stream'` |
| `PwaOfflineStrategy` | `OfflineStrategy` | `'precache' \| 'runtime' \| 'network-only'` |

```diff
- import type { PwaRenderMode, PwaOfflineStrategy } from '@ultimat3/pwa';
+ import type { RenderMode, OfflineStrategy } from '@ultimat3/pwa';
```

`@ultimat3/pwa` re-exports both under the canonical name, so the import path does not have to move —
`@ultimat3/core` is where they are declared and is equally correct.

**Why the alias existed and why it could not stay.** Tier 4 may not import tier 4, so `@ultimat3/pwa`
wrote its own copy of a set `@ultimat3/render` already had. That copy is what kept `spa` mapped to
`cache-first` after `spa` was deleted in 6.0.0 — the one strategy that gives an `app/` route a
**shared** cache entry, i.e. one signed-in member's HTML served to the next. The vocabulary is now
declared once at tier 0, and `bun run scripts/render-modes.ts --json` refuses a second declaration
anywhere in `packages/*/src`.

### 4. `PrerenderReport.skipped` carries the reason, not just the path

`readonly string[]` → `readonly SkippedRoute[]`, where a `SkippedRoute` is
`{ route, surface, render, reason, why }`. `PrerenderedPage` also gains `route`, the declared path a
concrete URL came from.

```diff
- for (const path of report.skipped) console.log(`skipped ${path}`);
+ for (const skipped of report.skipped) console.log(`skipped ${skipped.route}: ${skipped.why}`);
```

`x build --target static --json` now returns `emitted` and `skipped`, and the human path prints the
same rows.

**Why it changed.** `.x/static/` held a partial site and said nothing about the difference: `app/`
routes exist only through the server, so a tool pointed at the directory filed *"the island did not
mount"* against a route that was never emitted. A list of paths cannot distinguish "not emitted
because it needs a server" from "not emitted because it is broken", and those are opposite facts.

## 5.x → 6.0.0, entry by entry

**Installable `As of 2026-08-21`** — `npm view @ultimat3/core version` answers `7.0.0`, so 6.0.0 is behind `latest` and every entry below is a step you take on the way to it. Run that command anyway rather than trusting this line; a version written into a page goes stale on the next tag.

Seven breaking entries, and the first is a **runtime** refusal with no compile error in front of it.

### Start here — the one edit

Every single-label timezone name except `UTC` is refused. `isValidTimeZone` answers `false`, `canonicalTimeZone` answers `undefined`, `assertTimeZone` throws `X_TIMEZONE_INVALID` — and every `@ultimat3/time` formatter is downstream of that one call. **43 names change answer**, tabulated once under [the `6.0.0` section of `CHANGELOG.md`](https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md#600); that table is the source and is deliberately not copied here.

```diff
- formatDate(at, { locale, zone: 'CET' })
+ formatDate(at, { locale, zone: 'Europe/Paris' })
```

### Which class the name is in decides whether the swap is mechanical

| Class | Names | Replacement |
|---|---|---|
| geographic link — 24 of the 43 | `Japan`, `GB`, `Hongkong`, `NZ`, … | the `Area/Location` spelling: `Asia/Tokyo`, `Europe/London`, `Asia/Hong_Kong`, `Pacific/Auckland`. Textual — identical wall clock, identical offset |
| UTC alias | `UCT`, `Universal`, `Zulu` | `UTC` |
| the `GMT` family | `GMT`, `GMT0`, `GMT+0`, `GMT-0`, `Greenwich` | `Etc/GMT`, which still renders the label `GMT`. **Not `UTC`**, which renders `UTC` — same instant, different text on any surface that prints the zone name |
| abbreviation | `CET`, `EET`, `MET`, `WET`, `EST`, `MST`, `HST`, `EST5EDT`, `CST6CDT`, `MST7MDT`, `PST8PDT` | **none, and that is the defect.** An abbreviation names no jurisdiction and carries no DST rule, so only the author knows which city's clock was meant: `Europe/Paris` for `CET`, `America/New_York` for `EST5EDT`, `America/Phoenix` for `MST` |

`Etc/GMT+2` is unaffected — only a **leading** sign is a bare offset, and that `+` sits inside a real zone name. `US/Eastern` and `Asia/Calcutta` are unaffected too: a deprecated two-label alias is still `Area/Location`.

### Where the names hide, and why no build error finds them

`TimeZone` is `string` in `@ultimat3/time`, so `'CET'` compiles. Nothing fails until the call runs.

| Site | Spelling | At 6.0.0 |
|---|---|---|
| a formatter, or zone arithmetic | `zone:` on `formatDate`, `formatDateTime`, `formatRange`, `zonePartsAt`, … | throws `X_TIMEZONE_INVALID` on the first call |
| a scheduled task | `tz:` on `task()` | refused where the task is declared — `task()` validates through `isValidTimeZone`, so this one is caught at boot |
| `app.config.ts` | `defaultTimeZone` | refused at boot — `defineConfig` validates through core's own statement of the structural rule, so a stale key is `X_CONFIG_INVALID` naming the field, with the swap in its `fix:` |
| a client's `x-timezone` header | any of the 43 | no error — `resolveTimeZone` falls through to the configured default, so a hand-written client sending `CET` silently renders in your default zone. Browsers are unaffected: `Intl.DateTimeFormat().resolvedOptions().timeZone` is always `Area/Location` |

Find every candidate:

```sh
grep -rnE "(zone|tz|defaultTimeZone): *'[^/']+'" --include='*.ts' --include='*.tsx' .
```

Run it from the app root. Every hit is a single-label zone; `'UTC'` is the only one already correct.

### Why it changed

`Intl` answers "can I format this", never "is this an IANA zone", and at ICU 78 the two stopped agreeing: Bun 1.4 resolves `CET`, `EST`, `GMT` and `MST` where ICU 75 threw. A **runtime upgrade alone** therefore reopened the "no date without an explicit IANA zone" rule — silently, and in the direction that fails dangerous, because an abbreviation carries no DST rule. The judgement is now structural instead of delegated: an identifier is `Area/Location`, and `UTC` is the one legal exception. That refuses the single-label `backward` links along with the abbreviations, and is meant to — no structural rule keeps `CET` out while letting `Japan` in, both being one label, and the alternative is a denylist that grows with every tzdata release. [#251](https://github.com/developerz-ai/ultimate/issues/251), and [Timezones and dates](Timezones-And-Dates) for the rule it restores.

### Fixed, and neither costs an edit

| Fix | What changes for you |
|---|---|
| island JSX compiles through `babel-preset-solid` | client-side Solid reactivity inside an island works at all. An island containing JSX compiled to `React.createElement` and threw `ReferenceError: React is not defined` on first interaction, with the gate green. Two build-time dependencies join `@ultimat3/cli`; zero bytes reach your client bundle ([#243](https://github.com/developerz-ai/ultimate/issues/243)) |
| `@ultimat3/core` loads in a browser bundle | **core's** three module-scope `AsyncLocalStorage` constructions — the request context, the active span, the impersonation reason — moved onto one lazy seam, so `@ultimat3/ui` no longer throws `TypeError: undefined is not a constructor` at module evaluation ([#244](https://github.com/developerz-ai/ultimate/issues/244)). Six more constructions **outside** core were untouched at 6.0.0 and carry the same defect — `@ultimat3/db`, `@ultimat3/entity`, `@ultimat3/ai`; they are `[Unreleased]`, along with the guard that makes the rule a build error ([#255](https://github.com/developerz-ai/ultimate/issues/255)) |

Rebuild to pick either up.

## 4.1.0 → 5.0.0, entry by entry

Two breaking entries over six surfaces, one of which needs an edit. There is no codemod, and there
does not need to be: **the whole migration is deleting one line, and only if you wrote it.**

### Start here — the one edit

```diff
  jobs: {
-   driver: 'postgres',
    queues: ['app-default'],
    concurrency: 8,
  },
```

`jobs.driver` accepted `'postgres' | 'redis' | 'nats'` and had **no reader anywhere**. Boot always
built `createPgDriver`, so setting it to `redis` did not throw, did not warn and did not boot Redis
— it changed nothing and you silently got Postgres. If you were relying on it doing something, it
was not: you were on Postgres the whole time.

Which driver runs is `setJobDriver(driver)`, and only that:

```ts
setJobDriver(createPgDriver({ executor }))   // production
setJobDriver(createMemoryDriver())           // a test
```

`JobsDriver` (the type) goes with it. `JobsConfig.driver` was its only use.

**Leaving the line in also works.** A spread carries a key no type names, so a stale
`app.config.ts` still boots and the field still does nothing — `packages/core/src/config.test.ts`
pins exactly that. TypeScript will flag it; the runtime will not.

### The other four need no edit unless you wrote a test driver

They are `@ultimat3/testing`'s `subscribe` fixture, which was **declared and had no driver** — so
nothing could have been implementing these types. They changed because they described an API that
could not work: `LiveTarget` was `{ name, queryHash }`, and a node keys a subscription by
`(name, input)`; a hash is the input already thrown away.

| Was | Is |
|---|---|
| `Subscribe = (target) => Promise<LiveFeed>` | `(target, input, actor?) => Promise<LiveFeed>` |
| `LiveTarget = { name, queryHash }` | `{ name }` — the query itself |
| `LiveFeed` had no `reconnect()` | it has one |
| `DRIVER_FIXTURE_NAMES` held `subscribe` | `FRAMEWORK_FIXTURE_NAMES` does; the framework builds it |

A test that destructured `subscribe` and called it now reads:

```diff
-const feed = await subscribe(liveFeed.as(actorFor(ada), { orgId: acme.id }));
+const feed = await subscribe(liveFeed, { orgId: acme.id }, actorFor(ada));
```

The actor is the third argument rather than baked into the target because that is where the
framework puts it: the shared window is built with **no subject**, and every decision about an
actor is per subscriber.

### Behaviour that changed without breaking a type

**Error fields are escaped where they are built.** `UltimateError` and `SchemaError` run
`singleLine` over `code`, `title`, `cause`, `fix` and `docs` in their constructors, so `.message`,
`.cause`, `format()`, `toJSON()` and any renderer you write are one line by construction. Measured
over every shipped `cause:`/`fix:` literal: none contains a newline, so no framework message
changed. If you build error text from a value a CALLER controls, you no longer have to remember —
and if you were already escaping, `singleLine` is idempotent, so nothing doubles.

**One `fix:` line changed text.** `X_REPLICATION_FAILED` on SQLSTATE `42704` said
`x db replication init`, which is not a command — `x db` takes `gen`, `migrate`, `reset`, `seed`,
`studio`, `branch`, `backfill`. It now names the `CREATE PUBLICATION` an operator can paste.

### One thing to know before you subscribe to a projected live query

Not a change in this release — a defect it made visible. If a `query({ live: true })` declares an
`orderBy` on a column its rows do **not** carry (a projection that omits it), every change to a row
reads as a move, and the re-delivered row is the raw entity row rather than the projection. Columns
you left out of the projection reach the subscriber. [#230](https://github.com/developerz-ai/ultimate/issues/230),
and [Known gaps](Known-Gaps) carries it. Until it is fixed, order a live query by a column its rows
carry.

## 3.0.0 → 4.0.0, entry by entry

Twenty-five `BREAKING —` entries. Most are one of two shapes: a **declaration nothing read**, deleted rather than implemented, and a **surface that answered the wrong thing**, corrected. Full rationale per row in [`CHANGELOG.md`](https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md)'s `4.0.0` section.

**Start here — these three change behaviour whether or not you edit anything:**

| Surface | The edit |
|---|---|
| `on delete` now reaches the generated SQL. Any app that ever declared `references(…, { onDelete })` generates **different DDL** | run `x db gen` and read the diff before migrating. Every `add constraint` this framework had ever emitted dropped the rule, so the database has been refusing deletes under a declared `cascade`. Drift also gains `changed-foreign-key`, whose `fix:` hands over a `drop constraint` / `add constraint` pair — `add constraint` alone is `42710` on a name already taken |
| `llm()`'s `cache.semantic.scope` receives `{ input, ctx }` and **defaults to the calling actor**, not `'global'` | `scope: (input) => input.orgId` → `scope: ({ ctx }) => ctx.actor.orgId ?? 'none'`, or delete `scope` and take the default. A semantic lookup is a cosine nearest-neighbour with no tenant predicate, so the old shared store answered one tenant with another tenant's completion — reproduced at similarity 1.0. A deliberately shared cache must now say so |
| `reapBranches()` skips branches whose base is not `current_database()` | none, and re-read it if you run two Ultimate apps on one Postgres: `listBranches()` walks `pg_database` for the whole server, so one nightly sweep was dropping the *other* app's branches. A pre-4.0 marker records no base and is now skipped rather than dropped; the next `createBranch` writes it down, so it self-heals with no migration |

**Deleted because nothing read them** — in every case the edit is "delete the option":

| Surface | The edit |
|---|---|
| `CaptureOptions.timeoutMs` and `CaptureRequest.timeout` (`@ultimat3/scraping`) | delete them. The port required a timeout, `page-over-target.ts` threaded it, and **no driver honoured it** |
| `ScrapeTarget.click`'s `index` parameter | delete it. It was unreachable from the public vocabulary — `ScrapeFrame.click` takes `(selector, options?)` and has no index — and the two drivers disagreed on it |
| `PrecacheAsset.critical` (`@ultimat3/pwa`) | delete it. `buildPrecacheManifest` never copied it, and the documented promise ("critical assets are precached even if large") was vacuous — there is no size filter at all |
| `PERIODIC_SYNC_TAG`, `BackgroundSyncOptions.periodicMinIntervalMs` (`@ultimat3/pwa`) | delete them. Periodic Background Sync was never implemented in any sense: no listener, no registration, no capability flag |
| `realtime.heartbeatMs` (`RealtimeConfig`) | delete the key — `RealtimeConfig` is now `{ enabled, tier, transport, urlEnv }`. The socket beat is `new LiveClient({ heartbeatMs })` (browser code, which cannot read server config) and the presence beat is derived. **There is no runtime refusal**: `section()` copies unknown keys through, so a stale key is silently inert |
| `@ultimat3/seo` no longer exports `extensionOf` | delete the import; `parseImageQuery` reads the format off the query |
| `@ultimat3/realtime` no longer exports `qidOf` or `canonicalJson` | change the import: `queryHash` from `@ultimat3/query`, `canonicalJson`/`fingerprint` from `@ultimat3/core`. **No live subscription re-keys** — the two spellings differed only on values JSON cannot carry |

**Corrected, because they answered the wrong thing:**

| Surface | The edit |
|---|---|
| `adminResource` no longer pluralises an entity name | set `path:` explicitly if you relied on the doubled URL. Every entity in both tracked apps is already named plural, so `entity('orgs')` was served at `/admin/orgses`. Which plural a name takes is an app's convention, not a mechanism the framework can own (axiom 8) |
| A local disk's signed URLs carry the **registered disk name**, not the driver kind | none, if you use `defineStorage` — it calls `registerAs(diskName)` at boot. A disk registered as `uploads` used to 404 every signature it had just written |
| `ordinal(value)` takes no locale | delete the second argument. It picked the plural category with your locale and appended the **English** suffix regardless, so `ordinal(1, 'de')` was `'1th'` |
| `registerFrameworkCatalog()` and `registerMailCatalog()` take no `locale` | delete the argument. `defineCatalogs` called them once per locale, seating the English-only catalog under **every** locale an app declared — an app shipping only `es` served English chrome with `isMiss` reading `false`, which is a fallback locale chain the i18n package forbids by name |
| `t.date` refuses a date-time with no offset and no `Z` | send `2026-08-19T10:00:00Z`. `2026-08-19T10:00` resolved against the **host process's** zone, so one wire value meant a different instant on each pod — reachable from a request through `coerceQuery`, and published as `format: 'date-time'`, which RFC 3339 requires an offset for |
| `in` with a non-array operand matches **no** rows on both drivers | pass an array. It matched one row in Postgres (the scalar was wrapped) and none in memory; `in` with a NULL in the list disagreed in the other direction, and the SQL now emits `(col in (…) or col is null)` |
| `isValidCron` / `parseCron` refuse an unsatisfiable day/month pair (`'0 0 30 2 *'`) | fix the expression; the refusal names the pair. It used to parse clean and then burn ~184ms of blocking CPU per tick in the scheduler's leader loop before throwing |
| `createRateLimiter({ now })` → `createRateLimiter({ clock })` | `{ config, now: () => t }` → `{ config, clock: { now: () => new Date(t) } }`. Callers that passed neither are unaffected |
| `requiresApp` is enforced by the dispatcher | none, unless a script matched on the old message. Outside an app, `x secrets set` and its siblings now answer `X_NOT_IN_APP` |
| `NackOptions.countsAsAttempt: false` no longer files a job `suspended` | none. "Do not burn an attempt" and "this is a `step.sleep` suspension" were one flag, so the worker's limiter and `job.concurrency` sheds pushed rows out of `ready` — and `queue_depth` / `queue_oldest_ready_seconds` under-reported because of it |
| A read whose input carries a `Date`, `Map` or `Set` gets a new cache key and cursor scope, **once** | none. `Object.keys(date)` is `[]`, so every date rendered `{}` and one key answered for every date window a read ever served. Affected cursors answer `X_CURSOR_INVALID` once with "request the first page again"; ordinary inputs are byte-identical |

**Type-level, for hand-built literals and exhaustive switches:**

| Surface | The edit |
|---|---|
| `ColumnDescription` / `ReferenceDescription` gain `onDelete: OnDelete \| null` | add the field to hand-built description literals (a test fixture, a custom generator). `null` is Postgres' `no action` and is the old behaviour |
| `DriftKind` gains `changed-foreign-key` | a `switch` over `DriftKind` with no `default` no longer compiles |
| `BranchInfo` gains `base: string \| null` | re-type if you built the shape by hand |
| Five generators write **typed** test filenames | re-run the generator, or rename by hand. `x verify` selects a suite by filename, so a generated `contractTest(…)` inside a plain `*.test.ts` ran under `unit` while `x test contract` answered `X_TEST_NO_FILES` — a step that passed by having nothing to run. `x g action`/`x g mutator` now also write `<name>.contract.test.ts`, `x g query --live` writes `<name>.live.test.ts`, and `x g job`/`x g task`/`x g backfill` write `<name>.job.test.ts` |

**One migration to run:** the `x_jobs` idempotency index gains the tenant. It was `(name, idempotency_key)` while the row already carried `tenant_id`. `x db migrate` applies it.

## 2.0.0 → 3.0.0, entry by entry

Ten `BREAKING —` entries, all from one bug sweep. Each was a documented surface that did nothing, or did the wrong thing; the fix is the edit named beside it. Full rationale per row in [`CHANGELOG.md`](https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md)'s `3.0.0` section.

| Surface | The edit |
|---|---|
| `defineAuth({ mfa: { required: true } })` — refused at boot (`X_CONFIG_INVALID`), and `AuthMfaPolicy.required` narrowed to the literal `false` | delete `mfa.required`; enforce the requirement in your own enrolment flow. Nothing ever read the flag, so a user who never enrolled got a fully-privileged session under it |
| `enrolTotp(input)` → `enrolTotp(auth, input)`; `input.issuer` is now optional | pass the `auth` you built with `defineAuth`. The configured issuer never reached the `otpauth://` URI before |
| `@ultimat3/http` no longer exports `appErrorStatus()` | read your own registration module. `registerErrorStatus()` and `statusFor()` are unchanged |
| `SyncSocket.lastSeenAt` → `lastSeenMonotonicMs`, on `Clock.monotonic()` | rename the read. If you were formatting it as a date you were already wrong — the rename makes `new Date(...)` a compile error |
| `SQL_OUTBOX_RELEASE` and `SQL_OUTBOX_MARK_PUBLISHED` take one more parameter each (1 → 2, 2 → 3): the claimant | pass the claimant. `OutboxStore.release`/`markPublished` take it as an optional trailing argument, so an unfenced store still compiles |
| `SocketRegistry.sweepIdle()` → `idle()`, which returns the over-budget sockets and removes nothing | call `idle()` and evict through the node, or set the budget with `createSyncNode({ idleTimeoutMs })` |
| `DESCRIPTION_MIN_LENGTH` deleted from `@ultimat3/seo` | delete the import. There is no replacement and no minimum description length is checked — the constant was documented as enforced and was read by no validator |
| A metric redeclared with different `bounds` or a different `observe` is refused (`X_METRIC_NAME_INVALID`) | make the second declaration state the same `bounds`/`observe`, or fetch the handle without options — `gauge(name)` is unchanged |
| `Seed.run()` resolves with `SeedRun` instead of `void` | re-type the result if you typed it `void`. Awaiting it for the side effect alone is unaffected |
| `SeedContext.insert` skips a stored row instead of overwriting it | expect `skipped`, not an overwrite. `upsert` is the verb for a row the table keys |

`cachedFormatter` and `canonicalLocale` moved from `@ultimat3/time` to `@ultimat3/core` and are re-exported from `time`, so **no import breaks** — it is listed here because the move is real, not because it costs an edit.

## 1.x → 2.0.0, entry by entry

**Thirty-three `BREAKING —` entries — the largest major this project has shipped, and the first one semver covered.** Written up here `As of 2026-08`; the page carried a row pointing at this section for six releases and never carried the section. Full rationale per entry in [`CHANGELOG.md`](https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md)'s `2.0.0` section — the numbers below are that section's own order. No codemod.

Two things are not compile errors and are the ones to read first: the **seven behaviour changes** under *Start here*, and the **one migration** every app with a `money()` column owes.

| # | Surface | Costs you an edit if |
|---|---|---|
| 1 | `x db branch` takes a verb | you ever ran the bare-name form, which created a database |
| 2 | `x new` writes no migration | you scaffold a new app, or your app carries a hand-written `0000_initial.sql` |
| 3 | an MCP tool is named by its export name, verbatim | you read a tool name off `openapi.json`, `describe().mcp.tool` or `.tool().name` |
| 4 | `selectMailDriver` refuses with no mail credential | you send mail from `staging` or `production` |
| 5 | a lapsed fleet slot cannot be renewed by its holder | a job run outlives its slot lease |
| 6 | `@ultimat3/query` ships no read-cache seam of its own | you called `setReadCache`, `invalidateQueryTags`, or imported `ReadCache` |
| 7 | `@ultimat3/auth` drops `requireRole` / `requireScope` | you gate a route with either |
| 8 | `@ultimat3/db` drops `readOnly()` and its four companions | you imported any of them |
| 9 | `@ultimat3/seo` drops the performance-budget surface | you imported `checkBudgets`, `parseBytes`, a `Budget*` type, or set `RouteRecord.budget` |
| 10 | `@ultimat3/seo` drops `renderLd` | you called it |
| 11 | seven zone and locale helpers are gone | you imported `attachTimeZone`, `timeZoneOf`, `attachLocale`, `localeOf`, `negotiateLocale`, `isValidTimeZone` or `resolveTimeZone` |
| 12 | `@ultimat3/seo` drops `renderHeadTags` | you called it |
| 13 | a derived `BudgetLedger` bills its parent | you already sit at an `llm()` budget ceiling — no signature changed |
| 14 | `idempotencyKeyFor` takes the actor, required and third | you call it, **or** you hold idempotency records written before the deploy |
| 15 | `Idempotency-Key` is enforced at 255 characters | a client sends a longer key |
| 16 | `@ultimat3/action`'s `fingerprint` is SHA-256/16 | you enqueue an action job across the deploy boundary |
| 17 | `markReady()` throws `X_LIFECYCLE_DRAINED` after a drain | a test or a process drains and then starts a role |
| 18 | a drain is bounded at 25s, and a hook that outruns it is abandoned | your drain legitimately takes longer |
| 19 | `cacheKeyFor` takes a fourth, required `authority` | you call it directly |
| 20 | the query fingerprint is SHA-256/16 hex | you hold cursors minted before the deploy |
| 21 | `semantic.remember` refuses a TTL the tiers refuse | you passed a non-finite or negative lease |
| 22 | `OutboxRelay.stop()` returns `Promise<void>` | you await teardown, or implement the interface |
| 23 | `TierFailure.tier` is `TierLabel` | you `switch` over it with no `default` |
| 24 | `hello` carries no cursors | you build a `hello` frame by hand, or read `FRAME_LIMITS.resume` |
| 25 | three more `@ultimat3/realtime` surfaces move | you call `qidOf`, read a mutation's `status` after a drain, or implement `SyncNode` |
| 26 | four projection changes — what a value becomes when it leaves the process | you have a `money()` column (**a migration**), read `schema.nullable`, pass an unclonable `.default`, or take a nested object as `query({ input })` |
| 27 | `EPOCH` is gone; call `epoch()` | you imported it, or declare a 6-field cron |
| 28 | `job()` and `backfill()` require a `tenant` | you declare any job or backfill |
| 29 | one `resolveEnvironment`, and it is `@ultimat3/core`'s | you imported seo's, or wrote `'preview'` |
| 30 | the NATS wire client is `nats@2.29.3`, behind the same transport seam | you imported a hand-rolled NATS name, or faked a byte stream in a test |
| 31 | `@ultimat3/cli` exports `checkSourceDrift`, not `checkDrift` | you imported the CLI's |
| 32 | `invariants` is a function, and `invariant()` takes a built expression | you declare an entity with invariants |
| 33 | the framework's version is a call, not a constant | you imported `FRAMEWORK_VERSION`, `DEFAULT_SERVER_INFO` or `CLI_VERSION` |

### Start here — entries 4, 5, 13, 15, 17, 18 and 21 change behaviour with nothing failing to compile

| # | What changes | What you do |
|---|---|---|
| 4 | with neither `SMTP_URL` nor `RESEND_API_KEY`, `staging` and `production` install a driver that rejects every send with `X_MAIL_CREDENTIAL_MISSING`. `development` and `test` are unchanged, and an app that sends no mail still boots — the refusal is on the send, not at boot | set one of the two env keys in every environment that sends. The SMTP `Message-ID`, and so `SendResult.id`, is now content-derived and stable across attempts of one send |
| 5 | `SQL_LEASE_RENEW` fences on `expires_at > now()` as well as `holder`, matching the memory store. A run whose slot lapsed is cancelled with `X_JOB_SLOT_LOST` instead of running on uncapped past `job.concurrency` | nothing, unless a handler holds a slot longer than its lease — raise the lease, or shorten the run. This is what the documented contract already said and what `x dev` already did |
| 13 | a derived ledger bills its parent, so a call that used to slip past a `request` ceiling can throw `X_AI_BUDGET_EXCEEDED`, and `gateway.spent()` returns a larger — correct — number | raise the ceiling, or accept the refusal. Listed as breaking because it is observable to an app already at its limit, even though it makes *"derive can only tighten"* true for the first time |
| 15 | `Idempotency-Key` is enforced at 255 characters. The OpenAPI operation published `maxLength: 255` all along and nothing checked it | shorten the key. A client sending longer keys worked by accident and now gets a 400 |
| 17 | `markReady()` throws `X_LIFECYCLE_DRAINED` on a drained lifecycle instead of declining in silence | call `resetLifecycle()` between a drain and the next start — which is what three test files were already doing by hand. A process that drains and then starts a role now fails at the mistake rather than binding a socket that answers 503 forever |
| 18 | a drain is bounded at **25s** by default and a hook that outruns it is **abandoned, not stopped** — it is still running when the process exits. `drainDeadlineMs()` returns a `number` always, and `remainingBudget()` is a `number` rather than `number \| undefined` | if your drain legitimately takes longer, say so — and move the pair together, or you have only relocated the kill |
| 21 | `semantic.remember` puts its TTL through `assertTtl` like every other write, with `jitterFraction: 0` | pass a finite, non-negative lease. It used to compute `ttlMs` itself and hand a tier a value no other write path can produce |

Entry 18's pair, both sides or neither:

```ts
configureLifecycle({ deadlineMs: 600_000 });   // and terminationGracePeriodSeconds >= 600
```

`jobs` and `realtime` are the two roles that most need a bound and declared none, so before 2.0.0 they drained unbounded — a worker pod holding a long job past `terminationGracePeriodSeconds` is `SIGKILL`ed by the kubelet mid-statement, which is the failure the deadline exists to prevent.

### 26. What a value becomes when it leaves the process — and the one migration

A `money()` property is **three** physical columns, not two: `<p>_minor`, `<p>_currency` and the new `<p>_scale`. **Every existing app needs a migration** — without the column, every read of that table names a column it does not have.

```sql
alter table "<t>" add column "<p>_scale" integer check (<p>_scale is null or (<p>_scale >= 0 and <p>_scale <= 15));
```

Byte-for-byte what `generateMigration`'s `columnClause` emits. `NULL` is the right value for every existing row: it means *the currency's own minor unit*, which is what those rows always meant, where `0` would mean whole units. `examples/dummy/packages/db/migrations/0002_money_scale.sql` is the worked example, hand-written because `x db gen` answers `X_MIGRATION_SNAPSHOT_MISSING` in an app whose `0001` records no snapshot.

The other three projections in the same entry:

| Was | Now |
|---|---|
| `t.nullable(x)` emitted `{ …converted, nullable: true }` | `{ anyOf: [<converted>, { type: 'null' }], …annotations }`. `nullable` is an OpenAPI 3.0 keyword no later draft defines, so every validating consumer rejected `null`. A hand-written consumer reading `schema.nullable` reads `schema.anyOf` instead |
| `.default(value)` accepted any value | a default `structuredClone` refuses — a function, a class instance, a `Proxy` — throws `X_SCHEMA_DEFAULT_UNSHAREABLE` at the **first import of the file that declares it**. Pass a plain value, or a factory the handler calls |
| `query({ input })` accepted any schema | an input that cannot survive a query string is refused at `query()` with `X_QUERY_INPUT_UNENCODABLE`, in the declaring file. A read is `GET /_x/query/<name>`, so its input is characters: flatten the nested object, or make it an `action` |

### Entries 6, 14, 16 and 20 — state that does not survive the deploy boundary

No edit for most apps, and each is a one-time cost worth knowing before it is a support ticket.

| # | What goes cold, or re-runs | Why, and what to do |
|---|---|---|
| 6 | a cached query is cold once | `@ultimat3/query` no longer ships its own read-cache seam. Removed: `setReadCache`, `getReadCache`, `invalidateQueryTags`, `MemoryReadCache`, `DEFAULT_READ_CACHE_MAX_BYTES`, and the types `ReadCache` and `ReadCacheEntry`; `DEFAULT_READ_CACHE_TTL_MS` stays. A Redis deployment's read path changes in **both** directions — it was the Redis tier alone, so every cached read was a network round trip; it is now read-down/promote-up across `request-memo → lru → redis`, and concurrent misses of one key share a single load |
| 14 | an in-flight idempotency record is unreachable | the stored key's shape changed with the signature, so on the shared Postgres store a retry crossing the deploy boundary finds no record and **re-runs the handler**, inside the 24h window. `truncate x_idempotency` after deploying makes that state honest rather than half-reachable. The memory store dies with its process and is unaffected |
| 16 | an action job does not dedupe against its pre-deploy row | `@ultimat3/action`'s `fingerprint` is SHA-256/16, so `job-handle.ts`'s dedupe key `action:<name>:<fingerprint>` changed. Action idempotency itself is unaffected in practice, because the key changed too |
| 20 | a cursor minted before the deploy is rejected once | the query fingerprint is SHA-256/16 hex where it was FNV-1a/32 — 4×10⁹ values, brute-forceable offline in seconds, and a fingerprint here is a **sharing key over client-chosen input**. The canonical form is unchanged, so only the hash moved; `X_CURSOR_INVALID`'s `fix:` is already *request the first page again* |

An app that installed its own read cache registers it where every other cached surface already took one:

```diff
- setReadCache(myCache);
- invalidateQueryTags(tags);
+ registerTier(myTier);        // from @ultimat3/cache
+ invalidateTags(tags);        // literally the same call
```

A process that registers no tier reads **uncached** rather than filling a store no fan-out can see.

### Entries 1 and 2 — the CLI

`x db branch` takes a verb. The argument *was* the branch name and the dispatcher fell through to it, so `x db branch ls` — the `fix:` line the planned `x branch` command hands out — cloned the database into one called `ls`. A stray database is not a typo an agent can see: it is a copy of production-shaped data with a name nobody will recognise a week later.

```diff
- x db branch feat-new-billing
+ x db branch create feat-new-billing
```

| Verb | What it does |
|---|---|
| `x db branch create <name>` | the old bare-name form, said out loud |
| `x db branch ls` | name, location, created-at, size |
| `x db branch drop <name>` | what only `dropBranch('<name>', { force: true })` could do before |

Every verb is itself a legal branch name, so verb-first is the only shape where a name cannot be read as a subcommand. A word outside that set is `X_CLI_UNKNOWN_COMMAND`, and its `fix:` hands your own word back inside the command that still creates it. `drop` takes no confirmation flag deliberately — it may only remove what `ls` shows. `branchSql` is removed with the `psql` shell-out it was the text for; an external clone now runs through `@ultimat3/db`'s `createBranch()`, which is what makes `ls` work at all — the old path wrote the database and no marker comment, so every branch the CLI made was invisible to the only lister the framework has. Branches created by the old path carry no marker and are listed and dropped by neither.

`x new` writes no migration: the `0000_initial.sql` it wrote under `packages/db/migrations/`, and its `.hash`, are gone from the scaffold, and `x db gen` is that directory's single writer (axiom 1). A hand-written first migration could not carry the `.snapshot.json` only the generator produces. **A scaffold that declares an entity is therefore red on `x verify`'s `drift` step until the first generate runs, and that is correct behaviour:**

```sh
x db gen "initial"
x db migrate
```

`bin/setup` runs both for you, generating only when the directory holds no `.sql`.

### 3. An MCP tool is named by its export name, verbatim, on every surface

`snake_case` tool names are gone, and so is `toToolName`. One primitive was reachable under one name and published under another — the **served** name has only ever been the export name, while three *publishers* spelled the same tool `publish_post`. So an agent handed `openapi.json` called `tools/call { name: "publish_post" }` and got ToolNotFound: the catalog it was given was the wrong one.

| Was | Now |
|---|---|
| `publishPost.tool().name` → `'publish_post'` | `'publishPost'` |
| `openapi.json` → `"x-ultimate": { "mcpTool": "publish_post" }` | `"mcpTool": "publishPost"` |
| `publishPost.describe().mcp.tool` → `'publish_post'` | `'publishPost'` |
| `import { toToolName } from '@ultimat3/action'` / `'@ultimat3/query'` | removed from both — there is no derivation left to call |

Nothing that *worked* moves: a `tools/call`, a `scopes:` entry and a `visibleTo` list were already spelled verbatim, and a snake_case `scopes:` entry was already `X_MCP_SCOPE_UNKNOWN` at boot. What moves is everything read off the published contract — run `x manifest` to regenerate `openapi.json`, then re-point any agent prompt, saved tool allowlist, generated client or test that took its tool name from `x-ultimate.mcpTool`, `describe().mcp.tool` or `.tool().name`. `x.manifest.json` is unaffected: its `mcp` fact never carried a tool name.

### Entries 27, 29, 31 and 33 — renamed, one import each

```diff
- import { EPOCH } from '@ultimat3/time';
+ import { epoch } from '@ultimat3/time';        // 27 — call it: epoch()

- import { resolveEnvironment } from '@ultimat3/seo';
+ import { resolveEnvironment } from '@ultimat3/core';   // 29

- import { checkDrift } from '@ultimat3/cli';
+ import { checkSourceDrift } from '@ultimat3/cli';      // 31 — same signature, same findings

- import { FRAMEWORK_VERSION } from '@ultimat3/core';
+ import { frameworkVersion } from '@ultimat3/core';     // 33 — call it: frameworkVersion()
```

| # | Why the spelling had to move |
|---|---|
| 27 | `EPOCH` was one shared mutable `Date` exported from a tier-1 package, so any consumer calling `EPOCH.setUTCFullYear(...)` corrupted it for every other consumer in the process, permanently and silently. A `Date` cannot be frozen — `Object.freeze` does not close `setTime` — so it could not be fixed in place. `instant()` also returned the caller's own object and now does not, and `describeCron` **refuses** a 6-field expression with `X_CRON_NOT_DESCRIBABLE` where it used to return a wrong sentence |
| 29 | the name existed in `@ultimat3/core` and `@ultimat3/seo` with different parameters and different return unions — the axiom-1 violation the 1.1.0 notes named and deferred. Core's takes an options object, `resolveEnvironment({ env })`, and **throws** `X_ENVIRONMENT_INVALID` on a typo'd `ULTIMATE_ENV`; `tryResolveEnvironment()` is the caller that must answer rather than fail |
| 31 | two functions named `checkDrift` answered two different questions. `@ultimat3/db`'s keeps its name and its meaning — the live database against the ledger. The CLI's is the entity source hashed against what `x db gen` recorded, no database. Nothing an app writes calls either |
| 33 | read at module scope, the version resolved before `main` in every process that imported core, so `x build --target binary` produced an executable that threw at import. `@ultimat3/mcp`'s `DEFAULT_SERVER_INFO` becomes `defaultServerInfo()` and `@ultimat3/cli`'s `CLI_VERSION` becomes `cliVersion()` for the same reason — a constant holding the result is the module-scope read again, one import away |

Entry 29 also renames one environment across seo's surface. `isIndexable()` and `RobotsConfig.environment` take core's `Environment`, so `'staging'` is accepted and `'preview'` is a compile error; **no `robots.txt` body changes**, because neither spelling was ever indexable and only the `# environment:` comment line moves.

```diff
- buildRobots({ environment: 'preview' })
+ buildRobots({ environment: 'staging' })
- import type { SeoEnvironment } from '@ultimat3/seo';
+ import type { Environment } from '@ultimat3/core';
```

### 30. The NATS wire client is `nats@2.29.3`, and the transport seam did not move

`@ultimat3/realtime` hand-rolled the protocol — framing, parser, PING/PONG, TLS upgrade, inbox muxing and reconnect, 1,019 LOC plus a 431-line fake nats-server to test it. All of it is deleted, on [`docs/idea/18-build-vs-wrap.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/18-build-vs-wrap.md)'s criterion: own what must join the transaction, context and error machinery; wrap a wire protocol with a dominant maintained client, because an agent knows that client's semantics from training and can never know a reimplementation. `nats` is the first external runtime dependency any `@ultimat3/*` package has taken, pinned exact, importable from exactly one file.

`Transport`, `NatsTransport`, `NatsTransportOptions` and `selectTransport` are the same seam and cost no edit. The test seam moved up one level, from an injected byte stream to an injected client:

```diff
- new NatsTransport({ url, bucket, open: (target) => Promise.resolve(stream) });
+ new NatsTransport({ url, bucket, connect: fakeNatsConnect(broker) });
```

| Direction | Names |
|---|---|
| removed | `NatsConnection`, `NatsConnectionOptions`, `NatsConnectOptions`, `NatsProtocolParser`, `NatsOperation`, `NatsServerInfo`, `NatsStream`, `natsStreamOver`, `bunNatsStream`, `FakeNatsServer`, `fakeNatsStream` |
| added | `NatsClient`, `NatsConnect`, `NatsClientOptions`, `NatsRequestOptions`, `NatsRequestManyOptions`, `openNatsClient`, `FakeNatsBroker`, `fakeNatsConnect` |
| unchanged, moved to `nats-client.ts` | `NatsHeaders`, `NatsMessage`, `NatsMessageHandler`, `NatsSubscription`, `NatsTarget`, `parseNatsUrl` |

The JetStream KV layer stays ours: this client's KV abstraction expresses neither per-message TTL nor a batch `multi_last` direct get.

### Entries 7–12 and 24 — deleted because nothing read them

Every one had zero callers in the framework and in both tracked apps. In each case the edit is *delete the import*, and the replacement — where there is one — is named beside it.

| # | Gone | Instead |
|---|---|---|
| 7 | `requireRole` / `requireScope` (`@ultimat3/auth`) | declare the rule as a `Policy` — `can('admin:access')`. They decided a 403 outside `@ultimat3/policy`, so a route gated that way reported `policy: null` in `x routes`, in `framework.manifest.json` and in `openapi.json`, and `x policy list` reported its permission unenforced. `requireActor` / `currentActor` stay — those assert *authentication* |
| 8 | `readOnly()`, `assertReadOnly()`, `inspectStatement()`, `MutationVerdict`, `ReadOnlyOptions`, `readonlyViolation()` (`@ultimat3/db`); `X_READONLY_VIOLATION` is retired | `readOnly(db()).query(f)` → `readOnlyQuery(text, { role: await ensureReadOnlyRole() })`, which reports which defences engaged. The deleted lexer judged statement keywords and nothing else, so `select pg_sleep(60)` and `select pg_read_file('/etc/passwd')` both read as reads |
| 9 | `checkBudgets`, `assertBudgets`, `parseBytes`, `DEFAULT_BUDGET`, `BUDGET_UNITS`, the four `Budget*` types, `budgetExceeded()`, `RouteBudget`, `RouteRecord.budget` (`@ultimat3/seo`); `X_SEO_BUDGET_EXCEEDED` is retired | nothing to call — the gate that runs is `@ultimat3/cli`'s, raising `@ultimat3/render`'s `X_BUDGET_EXCEEDED`. seo is tier 1 and cannot see a build's bytes, so it was never the package that could answer. The retired code's row moves under *Reserved codes* so an old log line still resolves |
| 10 | `renderLd` (`@ultimat3/seo`) | `ld.*` and `meta.ld` — `renderMeta` already emits one `<script type="application/ld+json">` per node, and an app calling both emitted its graph twice |
| 11 | `attachTimeZone`, `timeZoneOf` (`@ultimat3/time`), `attachLocale`, `localeOf` (`@ultimat3/i18n`), `negotiateLocale`, `isValidTimeZone`, `resolveTimeZone` (`@ultimat3/http`) | write the zone with `createContext({ tz })` or `withChildContext({ tz })`, read it with `currentTimeZone()`, and take the other three from the packages that own them. `HttpConfig.locale` and `HttpConfig.tz` hold header and cookie **names** only |
| 12 | `renderHeadTags` (`@ultimat3/seo`) | `renderHead(headFromMeta(meta, seoRenderers()))`. It escaped `</` and nothing else and had no caller, while `renderHead` — the path every `x dev` and every build takes — escaped nothing at all: two serializers, the unused one weaker and the used one vulnerable. It could not borrow render's escapers, because `xml.ts` escapes **into** entities, which is right for XML and exactly wrong inside a raw-text element |
| 24 | `HelloFrame.resume` and `FRAME_LIMITS.resume` | drop the key. A cursor rides its own `subscribe` frame, which is where resume was always decided — the node replied `resume: []` and read the field from nobody, so every reconnect shipped each cursor twice, up to 512 ids per subscription, during the exact restart storm the herd bound exists to flatten |

`PROTOCOL_VERSION` was deliberately **not** bumped for entry 24: `decode` builds a whitelist, so a new node drops an old client's `resume` and an old node reads a new client's omission as the empty list it always received. Both skews are readable, and bumping would refuse every in-flight client on a rolling deploy to buy nothing — the version guards incompatibility, not novelty.

Entry 11 also brings a stricter zone rule with it: `CET`, `EST5EDT`, `+01:00` and `''` are refused, and a resolved zone comes back canonically spelled, so one zone is one formatter-cache key. The supported locale set and fallback are `defineCatalogs({ locales, default })`; the fallback zone is `configureTime({ defaultZone })`. `TimeZoneSources` gains `cookie`, and the default order is `user, cookie, query, header` — explicit before inferred.

### Entries 19 and 28 — a required argument, because an optional one is one a call site can forget

```diff
- cacheKeyFor(name, input, tags)
+ cacheKeyFor(name, input, tags, readAuthority(ctx.actor, 'actor'))
```

`readAuthority(actor, scope)` is the only thing that produces the value, and `'actor'` keeps 1.2.0 behaviour for a per-caller read. The forgotten authority is a cross-tenant read, which is why it is positional and required rather than an option with a default. Entry **14** is the same argument on `idempotencyKeyFor(name, input, actor)`, where the forgotten one is a cross-actor replay.

Entry 28 puts one new line on every `job()` and every `backfill()`:

```diff
  export const notifySubscribers = job({
    input: t.object({ postId: t.uuid, orgId: t.uuid }),
    idempotencyKey: ({ postId }) => `notify:${postId}`,
+   tenant: ({ orgId }) => orgId,
    retry: { attempts: 5, backoff: 'exponential' },
    async run({ input, ctx }) { /* … */ },
  });
```

A definition with no `tenant` is `X_JOB_TENANT_REQUIRED` at declaration. `tenant: 'none'` is the other legal answer and means the **opposite thing on each side of the factory**: on a `job()` it declares the body touches no tenant-scoped table, because every scoped read then fails closed with `X_TENANCY_ACTOR_ORG_REQUIRED`; on a `backfill()` — which forwards `tenant` verbatim — it is how a sweep declares it spans every tenant, and `backfillPass` opens the bounded `crossTenant` scope for it, never the author.

In the same slice, on the read primitive, a bare boolean policy bypass gains a reason:

```diff
- sourceFor(target, input, { ctx, enforce: false })
+ sourceFor(target, input, { ctx, unenforced: 'explain returns no rows' })
```

The reason is required, a blank one is refused before the source is built, and one `query.policy.unenforced` audit line is written at `debug`.

### Entries 22, 23, 25 and 32 — types, and anything implementing an interface structurally

| # | Was | Now |
|---|---|---|
| 22 | `OutboxRelay.stop()` returned `void` | `Promise<void>`. It cleared the timer and returned *underneath* the pass in flight, so a role shutdown that awaited it resumed while a publish and its `markPublished` were still running — a torn write against a closing pool. Callers ignoring the return value keep compiling and keep the old race |
| 23 | `TierFailure.tier` was `TierName` | `TierLabel = TierName \| 'query-read'`, because `@ultimat3/query`'s read tier degrades through the same `bestEffort` wrapper and had nowhere to report as. A `switch` over it needs a `'query-read'` arm |
| 25 | `qidOf(name, input)` was `<name>:<fnv1a 32-bit>` | `<name>:<first 16 hex of SHA-256>`. A `qid` is a **sharing** key — a hit hands back the seated window, carrying the first subscriber's input and rows — and input is client-chosen, so 32 bits is a collision found offline in seconds and one client served out of another's window. A rolling deploy costs one bounded snapshot per subscription |
| 25 | `queue.drain(send)` marked each mutation `acked` when `send` resolved | a drained mutation stays `inflight` until the server settles it with `ack`/`fail` or `requeueInflight()` returns it. `DrainReport.remaining` is now what is still **sendable**; a UI rendering *unsynced* should read `pending()`, which is unchanged and still counts both |
| 25 | `SyncNode` had one teardown, `stop()` | it also declares `stopAccepting()`, called by the SIGTERM `accept` phase — additive for a `createSyncNode` caller, **breaking** for anything implementing the interface structurally. `SyncNode.websocket` no longer carries `publishToSelf` |
| 32 | `invariants: [ invariant(name, (c) => …) ]` | `invariants: (c) => [ invariant(name, …) ]` — see the diff below |

`SyncSocket.subscribeTopic` / `unsubscribeTopic` no longer call Bun's `ws.subscribe` / `ws.unsubscribe` either: every channel message is one filtered `send` per socket through `SocketRegistry.deliver`, because a native publish cannot be refused per socket, cannot report the frame it dropped and cannot mark a subscriber desynced.

Entry 32 is mechanical — move the `[` to after `(c) => `, drop each `(c) =>` inside `invariant()`, drop every `!`:

```diff
- invariants: [
-   invariant('post_title_not_blank', (c) => c.title!.trimmed().minLength(1)),
-   invariant('post_price_non_negative', (c) => c.price!.minor.atLeast(0)),
- ],
+ invariants: (c) => [
+   invariant('post_title_not_blank', c.title.trimmed().minLength(1)),
+   invariant('post_price_non_negative', c.price.minor.atLeast(0)),
+ ],
```

The defect it fixes is why every generated entity needed a `!`: `InvariantColumns` was an index-signature type, so under `noUncheckedIndexedAccess` every `c.title` was `ColumnExpr | undefined`. It is now a mapped type over the declared columns, so `c.title` is a `ColumnExpr` and `c.titel` is `TS2551: Property 'titel' does not exist … Did you mean 'title'?`. `unique()` and `satisfies()` take `keyof C & string`, so a typo in a column *list* is caught too. `indexes[].where` is unchanged — it was already a callback, and its `c` is now typed too.

## What semver covers

| Surface | From |
|---|---|
| `X_*` error codes | already stable forever — a shipped code never changes meaning and is never reused |
| The eight primitive shapes | `entity`, `policy`, `action`, `mutator`, `query`, `job`, `route`, `task` and their declared fields — 1.0.0 |
| The `x` CLI surface | commands, flags, exit codes, and `--json` output shape — 1.0.0 |
| The import tier table | which package may import which — 1.0.0 |
| `app.config.ts` field names | renaming or removing a field is a major — 1.0.0 |

| Bump | Means | Examples |
|---|---|---|
| **major** | a covered surface changed incompatibly | a removed config field, a renamed CLI flag, a changed primitive field, a narrowed tier |
| **minor** | additive, old code still compiles and still passes `x verify` | a new optional field, a new command, a new driver behind an existing interface |
| **patch** | no surface change | a bug fix, a perf change, a corrected `fix:` line |

1.0.0 means a stable API under semver. It is not a claim about your infrastructure.

## Release policy

| Rule | Detail |
|---|---|
| Pinned exact versions | no `^`, no `~`, in the framework or in a generated app. A range is a silent upgrade |
| Lockstep releases | one release bumps all 30 packages — 29 `@ultimat3/*` plus the unscoped `create-ultimate` — to the same version. One version, one commit, one tag. A mixed set is unsupported |
| Published with provenance | npm via OIDC trusted publishing. Every tarball from 3.0.0 onward carries an attestation — verified through 5.0.1; **2.0.0's do not**, that release went out by hand. Per version: `npm view @ultimat3/core@<version> dist.attestations` |
| Breaking changes land with the edit named | **no release has shipped a codemod** and `x upgrade` is not implemented, so every `BREAKING —` entry names the manual edit itself. A section of this page walks it |
| Dependency upgrades are framework work | Solid is pinned to **`1.9.14`, the stable line** — Solid 2 is still prerelease (`2.0.0-beta.N`, DOM renderer split into `@solidjs/web`) and every app inherits whatever core this repo pins. Bumping it is a framework release, never an app-level `bun update`. There is no ArkType or Drizzle pin to carry: `@ultimat3/schema` ships dependency-free builtin validators (ArkType is an optional provider you adapt yourself) and `@ultimat3/entity` ships its own `postgresDriver()` |
| Bun floor | `>=1.4.0`, target 2.0. Below the floor → `X_BUN_VERSION`. It was `>=1.3.0` until 2026-08-27, while `x test` emitted `bun test --isolate` — a flag Bun added in 1.3.13 — so the declared floor named runtimes the CLI could not run on |
| Not shipped `As of 2026-08`, behind the interfaces that ship today | realtime tier 3 (`persist: true`, local-first), the plugin API, multi-region replication, and the Redis/NATS **job** drivers — the last throw `X_NOT_IMPLEMENTED` with a runnable `fix:` rather than pretending to work |

Do not upgrade a transitive dependency of a `@ultimat3/*` package by hand. Open an issue instead — the pin is deliberate.

## `x upgrade` — **planned, not shipped**

`As of 2026-08` this command exits `X_NOT_IMPLEMENTED` ([`packages/cli/src/cmd-planned.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/cli/src/cmd-planned.ts)). Its own `fix:` line names what to run instead, and that is the upgrade path today:

```
bun update --latest && x verify     # the shipped path
```

Everything the manual path skips, you do yourself: bump every `@ultimat3/*` pin to **one** exact version, then `x manifest` and `x verify`. There are no codemods to run, because no release has shipped one yet.

The design below is what the command will do, kept here because the **classes of breakage it automates are real today** and the next section is how each one is detected with or without it.

| # | Step | Detail |
|---|---|---|
| 1 | Resolve the target release | all `@ultimat3/*` at one version; refuses a partial set |
| 2 | Bump `package.json` pins | every workspace, exact versions |
| 3 | Run codemods | per-release, idempotent, AST-based. Each prints the files it touched |
| 4 | Regenerate `x.manifest.json` | routes, entities, actions, jobs, policies, tags, budgets |
| 5 | Regenerate `openapi.json` | HTTP surface from action/query declarations |
| 6 | Run `x verify` | the gate. Not green = the upgrade is not done |

`--dry-run`, once it exists, performs 1, 3 (in-memory), and reports the diff without writing. Output carries every changed file, every codemod name, and every check that would fail.

## Breaking-change classes and how each is detected

Nothing here relies on you reading a changelog carefully. Each class is a build error.

| Class | Detected by | Code | Fix |
|---|---|---|---|
| Action/query contract change | `x verify`'s `contract-diff` step, against the committed `x.manifest.json` | `X_MANIFEST_BREAKING` | `x verify --json` to read the finding, then bump the major version or restore the input/output shape |
| Breaking published surface | manifest contract diff, breaking subset | `X_MANIFEST_BREAKING` | bump the app's major version; old clients keep the old shape |
| Schema vs migrations | schema introspection vs migration history | `X_DB_DRIFT` | `x db gen "<message>"` then `x db migrate` |
| Stale generated facts | manifest freshness check | `X_MANIFEST_STALE` | `x manifest` |
| Import-tier change | `scripts/boundaries.ts` re-run over the new tier table | `X_BOUNDARY_VIOLATION` | move the import down a tier or invert the dependency |
| Budget ratchet | a release lowering a default budget | `X_BUDGET_EXCEEDED` | fix the regression, or set an explicit `budget` on the route |
| Config field rename/removal | config schema parse, and the compiler before it — an unknown key is an excess property on `Input<AppConfig>`, so it fails `typecheck` rather than reaching a runtime parse | `X_CONFIG_INVALID` | the cause names the field. No codemod has shipped yet, so this is a manual edit |
| Env schema change | typed env parse at boot | `X_ENV_MISSING` | add the key; fails in ~40ms, not as a later 500 |
| Renamed job step | duplicate/unknown step names in one `run` | `X_STEP_DUPLICATE` | renaming a step invalidates its stored result — treat as a new step |

Budgets ratchet **down** across releases. That is intentional: a framework release that makes bundles smaller should not leave your app's slack unclaimed.

## Version skew during a deploy

A client running build `A` requesting an asset from build `B` is the failure mode that actually breaks PWAs — not caching strategy.

| Mechanism | Behavior |
|---|---|
| Immutable build ID | content hash of the build, stamped into the HTML, every asset path, `x.manifest.json` and `sw.js`'s cache names — the worker half was emitted by no build until [#390](https://github.com/developerz-ai/ultimate/issues/390), `As of 2026-08`. Never a timestamp, never `latest` |
| Client sends its build ID | `X-Ultimate-Build` on RPC, query, and WS handshake — so the server answers "you are stale" instead of guessing |
| N-deploy asset retention | the last **3** builds' assets stay served — `retentionPlan(deploys, keep = 3)` in [`packages/pwa/src/version-skew.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/pwa/src/version-skew.ts). A count of deploys, with **no time component**: there is no 7-day half, and **no `pwa.retention` field** — `PwaConfig` was `{ enabled, offline, installPrompt, backgroundSync, push }` at 7.0.0 (`installPrompt` is deleted in 8.0.0). Pass `keep` at the call site to hold more |
| `AppUpdateAvailable` signal | a Solid signal flips when the server reports a newer build. Your app renders its own "Update available — reload". No forced navigation, no lost form state |
| Forced reload | **not a capability this framework has, `As of 2026-08`.** 9.0.0 deleted `updateSignal`, `updatePolicy`, `DEFAULT_GRACE_MS` and their types — they computed a grace, a `forced:` flag and a `deadlineAt`, and nothing performed the reload, nor could: `@ultimat3/http` (tier 2) and `@ultimat3/realtime` (tier 3) both sit below `pwa` (tier 4). Notification is complete — read `useConnection().updateAvailable`, or compare the worker's posted `to` with `detectSkew`, and render your own affordance. `x deploy --critical` was **removed in 4.0.0** for the same reason: echoed into the deploy plan, read by nothing |
| Skew is observable | the `/_x` live panel reports the build-ID distribution of connected clients. `x status --json` is **planned**, not shipped |
| The realtime **wire** is versioned separately | `PROTOCOL_VERSION` is a small integer in `@ultimat3/realtime`, `2` `As of 2026-08-24`. It is not the build id and it does not move per release: it moves only when a frame one side writes is a frame the other cannot read. A mismatch is `X_PROTOCOL_VERSION` on the frame — **clients and `sync` nodes are redeployed together across a bump**, because a cursor rides both the client's `subscribe` and the node's `snapshot`, so the skew breaks resume from either end ([Realtime](Realtime#wire-protocol-version)) |

Server behavior on a stale build ID:

| Request | Response |
|---|---|
| Asset within retention | serve it |
| Asset outside retention | `410 Gone` + `X-Ultimate-Build-Current`; the SW serves the fallback and flips `AppUpdateAvailable` |
| Action / query | executed if the contract is compatible; otherwise `X_BUILD_SKEW` with a `fix:` line |
| WS handshake | accepted, then an `update-available` frame carrying the server's `buildId` → signal flips. The socket is **not** killed |

Full detail: [PWA and offline](PWA-And-Offline).

## Migrating jobs between drivers — **still nowhere to migrate to**

**There is no `jobs.driver` field.** 5.0.0 deleted it, because it selected nothing: boot always built `createPgDriver`, so `jobs: { driver: 'redis' }` gave you Postgres in silence. Which driver runs is `setJobDriver(driver)` at boot, and only that.

`x jobs drain --to` takes **`redis` \| `nats`**, and neither lands a job: both are interface-complete stubs that throw `X_NOT_IMPLEMENTED` on the first enqueue, having moved nothing. So **there is no driver migration to perform** `As of 2026-09`. Postgres is the source, never a `--to` value.

**`x jobs drain` is planned since 2026-10** — correction to the paragraph above and the table below: it now exits `X_NOT_IMPLEMENTED` before the queue boots, pointing at `x jobs ls --json`. Until then a drain onto either stub leased the pending batch for five minutes, failed every enqueue and nacked it back. The procedure below stands for the day a durable driver ships; steps 2 and 3 answer planned until then.

**`memory` is refused by name** (`X_CLI_BAD_FLAG`), `As of 2026-09`. It was a target until then, and it was the one that appeared to work: a `Map` inside the command's own process, so the drain acked every durable row off the source, reported `ok: true`, and lost the copy when the command exited. A target that dies with the command is not a migration.

Nothing rehearses the procedure below today. It is written against the interface that already ships and applies unchanged the moment a driver does:

| Order | Step |
|---|---|
| 1 | deploy with the old driver still installed |
| 2 | `x jobs drain --to <driver> --dry-run --json` — read the plan; a skipped candidate is a job whose `runAt` has not arrived, not an error |
| 3 | `x jobs drain --to <driver>` — leases the batch off the old queue, copies steps, enqueues, then acks |
| 4 | change the `setJobDriver(…)` call at boot, `x verify`, deploy |
| 5 | confirm with `x jobs ls --json` that the old queue is empty before removing its infra |

Job code never changes across a driver: `steps` is a driver member, so step persistence is identical on all of them. The outbox table stays the transactional record. At-least-once delivery is preserved; atomicity is not negotiable ([Jobs and workflows](Jobs-And-Workflows)).

## Migrating realtime tiers

| From → to | Change | Notes |
|---|---|---|
| tier 1 → tier 2 | `live: true` on the query | needs a `replicator` role and `orderBy` + `limit` on the `sql` |
| tier 2 → tier 3 | `persist: true` on the **entity** | shipped in 21.0.0, opt-in per entity. No new mutators, no new authz, no new server code ([Realtime](Realtime#tier-3-shipped-in-2100)) |
| `memory` → `nats` transport | `realtime.transport: 'nats'`, and **`realtime.urlEnv`** — the env *key name*, not a URL (default `NATS_URL`). There is no `realtime.url` field | roll `sync` and `replicator`; clients reconnect with server-directed backoff. **`realtime.transport` decides the bus** (`selectTransport(env, { transport, urlEnv })`), `As of 2026-09-23` (in the tree, not yet tagged): `'nats'` with its variable unset refuses the boot, and so does `'memory'` with `NATS_URL` set (`X_CONFIG_INVALID`). On 21.x the presence of `NATS_URL` decided it and the config field was never read ([Configuration](Configuration)) |

## Where the facts live

| Source | Contents |
|---|---|
| [`CHANGELOG.md`](https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md) | Keep a Changelog format, `Added` / `Changed` / `Removed`. A `BREAKING —` entry names its manual edit **inline**; there is no per-entry `Migration` block convention and never a codemod name — `grep -c '\*\*Migration' CHANGELOG.md` answers `9` `As of 2026-08-23`, against 111 breaking entries |
| [`docs/idea/14-roadmap.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/14-roadmap.md) | the twelve milestones, 0–10 shipped. Milestone 11's two-platform deploy proof is the one item still open |
| [`docs/idea/15-risks.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/15-risks.md) | what could still change shape — the sync engine is roughly 70% of total effort |
| [`docs/architecture/19-cutting-a-major.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/architecture/19-cutting-a-major.md) | how this page is maintained: one section per major, written when the first breaking change lands. Maintainer-facing — read it if you are opening a PR against the framework, not if you are upgrading an app |
| `x.manifest.json` | generated, per build. Diff two manifests to see exactly what a release changed in your app |

Read the changelog **backwards from your current pin to the target**, and read the `BREAKING —` entries only — the rest is regenerated for you.

## When an upgrade fails

```
git revert <the upgrade commit>      # or redeploy the previous image tag
x verify --json > verify.json
```

| Situation | Do |
|---|---|
| Prod is already rolling | redeploy the previous image tag. Assets from the previous build are inside the retention window, so sessions survive |
| An entry's named edit did not compile | keep the diff. It is the most useful part of the bug report, and it is the entry that is wrong |
| `x verify` fails on one check | read that step's findings from `x verify --json`, then reproduce it with the command its `fix` names |
| Cause is unclear | `x errors explain <CODE> --json` |

File an issue with `verify.json` attached, your previous and target versions, and the entry you were following. The JSON is the report — do not paraphrase the terminal.

Symptom-first fixes: [Troubleshooting](Troubleshooting). Code index: [Error codes](Error-Codes).
