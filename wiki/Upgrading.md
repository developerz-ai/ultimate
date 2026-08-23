# Upgrading

**`As of 2026-08`. Semver applies from here.** A breaking change to a documented API needs a major. Every `@ultimat3/*` version is pinned exactly and moves in lockstep — never mix versions.

**Seven majors have shipped, and this page walks all seven** — 2.0.0's 33 entries joined it `As of 2026-08`, and `scripts/changelog-check.ts` now refuses a summary row whose section the page does not carry, which is how they were missing for six releases. [`CHANGELOG.md`](https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md) is the source; none ships a codemod, so every entry is a manual edit the entry itself names. **One section per major**, newest first — read the ones between your pin and your target, oldest first.

| From → to | Breaking entries | Read |
|---|---|---|
| 7.x → 8.0.0 | **6** | the `8.0.0` section, in order |
| 6.x → 7.0.0 | **4** | the `7.0.0` section, in order |
| 5.x → 6.0.0 | **7** | the `6.0.0` section, in order |
| 4.x → 5.0.0 | **2**, over six surfaces, each a declaration that promised what the code did not do | the `5.0.0` section, in order |
| 3.0.0 → 4.0.0 | **25**, from a sweep that closed every known gap | the `4.0.0` section, in order |
| 2.0.0 → 3.0.0 | **10**, all from a five-agent bug sweep | the `3.0.0` section, in order |
| 1.x → 2.0.0 | **33** | the `2.0.0` section, in order |
| 1.x → 8.0.0 | **87** | all seven sections, oldest first |

An entry is a line `CHANGELOG.md` marks `BREAKING —`. The count is derived, never curated:

```sh
grep -cE '^(- \*\*|### )BREAKING —' CHANGELOG.md
# 88 As of 2026-08 — 87 inside the section of the major that shipped it, and 1 under
# [Unreleased], staged for the next major. A released section's count is what the table above reads.
```

Each entry changes a surface the table below covers.

> **Move to whatever `latest` is** — only the [footer](_Footer) stamps the number, because a version written into a page goes stale on the next tag. All 30 workspaces resolve at one version — 29 `@ultimat3/*` plus the unscoped `create-ultimate`, `@ultimat3/scraping` and `@ultimat3/flags` included — and every tarball since 3.0.0 was published by the release workflow with a provenance attestation. Resolve before you pin, never take it from this page:

| Check | Command | Answer that means "go" |
|---|---|---|
| what `latest` is | `npm view @ultimat3/core version` | the version you are pinning |
| that a package resolves at it | `npm view @ultimat3/scraping@<version> version` | that version, not `E404` |
| that the tarball is attested | `npm view @ultimat3/core dist.attestations` | a `provenance` object |
| every name that must move together | `bun run scripts/release-workflow.ts --json` | the 30 derived names — check each |

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

`x new` writes no migration: `packages/db/migrations/0000_initial.sql` and its `.hash` are gone from the scaffold, and `x db gen` is that directory's single writer (axiom 1). A hand-written first migration could not carry the `.snapshot.json` only the generator produces. **A scaffold that declares an entity is therefore red on `x verify`'s `drift` step until the first generate runs, and that is correct behaviour:**

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
| Bun floor | `>=1.3`, target 2.0. Below the floor → `X_BUN_VERSION` |
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
| Immutable build ID | content hash of the build, stamped into `sw.js`, the HTML, every asset path, and `x.manifest.json`. Never a timestamp, never `latest` |
| Client sends its build ID | `X-Ultimate-Build` on RPC, query, and WS handshake — so the server answers "you are stale" instead of guessing |
| N-deploy asset retention | the last **3** builds' assets stay served — `retentionPlan(deploys, keep = 3)` in [`packages/pwa/src/version-skew.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/pwa/src/version-skew.ts). A count of deploys, with **no time component**: there is no 7-day half, and **no `pwa.retention` field** — `PwaConfig` was `{ enabled, offline, installPrompt, backgroundSync, push }` at 7.0.0 (`installPrompt` is deleted in 8.0.0). Pass `keep` at the call site to hold more |
| `AppUpdateAvailable` signal | a Solid signal flips when the server reports a newer build. Your app renders its own "Update available — reload". No forced navigation, no lost form state |
| Forced reload | `updatePolicy({ graceMs = 6h, forceOn = ['security'] })` + `updateSignal()` from `@ultimat3/pwa`: past the grace, the signal carries `forced: true` and `deadlineAt: now`. The app renders the countdown and the drain — the framework runs neither. `x deploy --critical` is **removed in 4.0.0** — it was echoed into the deploy plan and read by nothing, so no migration is needed beyond dropping the flag |
| Skew is observable | the `/_x` live panel reports the build-ID distribution of connected clients. `x status --json` is **planned**, not shipped |

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

`x jobs drain --to` takes **`memory` \| `redis` \| `nats`**, and `memory` is the only target that lands a job: `redis` and `nats` are interface-complete stubs that throw `X_NOT_IMPLEMENTED`. So **there is no driver migration to perform** `As of 2026-08` — `x jobs drain --to redis` constructs the target and fails on its first enqueue. Postgres is the source, never a `--to` value.

`x jobs drain --to memory` works today, and it is the same command, so the procedure below is written against the interface that already ships and applies unchanged the moment a driver does:

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
| tier 2 → tier 3 | `persist: true` on the query | not shipped `As of 2026-08`. No new mutators, no new authz, no new server code |
| `memory` → `nats` transport | `realtime.transport`, and **`realtime.urlEnv`** — the env *key name*, not a URL. There is no `realtime.url` field | roll `sync` and `replicator`; clients reconnect with server-directed backoff. What actually decides the transport at boot is **`NATS_URL` being set**: `selectTransport(env)` never reads `config.realtime.transport`, so the config field documents intent and the env var makes the switch ([Configuration](Configuration)) |

## Where the facts live

| Source | Contents |
|---|---|
| [`CHANGELOG.md`](https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md) | Keep a Changelog format, `Added` / `Changed` / `Removed`. A `BREAKING —` entry names its manual edit **inline**; there is no per-entry `Migration` block convention and never a codemod name — `grep -c '\*\*Migration' CHANGELOG.md` answers `1` `As of 2026-08`, against 71 breaking entries |
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
