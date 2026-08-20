# Upgrading

**`As of 2026-08`. Semver applies from here.** A breaking change to a documented API needs a major. Every `@ultimat3/*` version is pinned exactly and moves in lockstep — never mix versions.

**Four majors have shipped; a fifth is in flight.** [`CHANGELOG.md`](https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md) is the source; none ships a codemod, so every entry is a manual edit the entry itself names. **One section per major**, newest first — read the ones between your pin and your target, oldest first.

| From → to | Breaking entries | Read |
|---|---|---|
| 5.x → 6.0.0 | **1 so far — unreleased.** The count moves until the tag | the `6.0.0` section, then `[Unreleased]` |
| 4.x → 5.0.0 | **2**, over six surfaces, each a declaration that promised what the code did not do | the `5.0.0` section, in order |
| 3.0.0 → 4.0.0 | **25**, from a sweep that closed every known gap | the `4.0.0` section, in order |
| 2.0.0 → 3.0.0 | **10**, all from a five-agent bug sweep | the `3.0.0` section, in order |
| 1.x → 2.0.0 | **33** | the `2.0.0` section, in order |
| 1.x → 5.0.0 | **70** | all four shipped sections, oldest first |

An entry is a line `CHANGELOG.md` marks `BREAKING —`. The count is derived, never curated:

```sh
grep -cE '^(- \*\*|### )BREAKING —' CHANGELOG.md
# 71 As of 2026-08 — 70 shipped, 1 under [Unreleased]
```

Each entry changes a surface the table below covers.

> **Move to whatever `latest` is** — only the [footer](_Footer) stamps the number, because a version written into a page goes stale on the next tag. All 30 workspaces resolve at one version — 29 `@ultimat3/*` plus the unscoped `create-ultimate`, `@ultimat3/scraping` and `@ultimat3/flags` included — and every tarball since 3.0.0 was published by the release workflow with a provenance attestation. Resolve before you pin, never take it from this page:

| Check | Command | Answer that means "go" |
|---|---|---|
| what `latest` is | `npm view @ultimat3/core version` | the version you are pinning |
| that a package resolves at it | `npm view @ultimat3/scraping@<version> version` | that version, not `E404` |
| that the tarball is attested | `npm view @ultimat3/core dist.attestations` | a `provenance` object |
| every name that must move together | `bun run scripts/release-workflow.ts --json` | the 30 derived names — check each |

## 5.x → 6.0.0, entry by entry — **unreleased**

**Nothing here is installable until `npm view @ultimat3/core version` answers `6.0.0`.** Run that first; `As of 2026-08` it does not. This section is written as each change lands rather than at the tag, so entries are **appended** — re-read it when `latest` moves.

One breaking entry so far, and it is a **runtime** refusal with no compile error in front of it.

### Start here — the one edit

Every single-label timezone name except `UTC` is refused. `isValidTimeZone` answers `false`, `canonicalTimeZone` answers `undefined`, `assertTimeZone` throws `X_TIMEZONE_INVALID` — and every `@ultimat3/time` formatter is downstream of that one call. **43 names change answer**, tabulated once under [`[Unreleased]` in `CHANGELOG.md`](https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md#unreleased); that table is the source and is deliberately not copied here.

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
| `@ultimat3/core` loads in a browser bundle | three module-scope `AsyncLocalStorage` constructions moved onto one lazy seam, so `@ultimat3/ui` no longer throws `TypeError: undefined is not a constructor` at module evaluation ([#244](https://github.com/developerz-ai/ultimate/issues/244)) |

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
| N-deploy asset retention | the last **3** builds' assets stay served — `retentionPlan(deploys, keep = 3)` in [`packages/pwa/src/version-skew.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/pwa/src/version-skew.ts). A count of deploys, with **no time component**: there is no 7-day half, and **no `pwa.retention` field** — `PwaConfig` is `{ enabled, offline, installPrompt, backgroundSync, push }`. Pass `keep` at the call site to hold more |
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
