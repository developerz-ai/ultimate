# Sweep 1 — architecture coherence
> Re-checked in [`sweep-3-verify-tier-4-5.md`](sweep-3-verify-tier-4-5.md) — where it corrects a citation or narrows a row, that file wins.

> Findings for [`../overview.md`](../overview.md). Read-only sweep at `2ea5eb17` (23.0.0), As of 2026-10.
> Guards run green: `boundaries` (5939 files), `guards-doc --check`, `package-map-graph`, `roadmap`,
> `llms-txt --check`, `config-readers`.
> `plan-08` / `plan-09` = [`../../../09/28/101-audit-bugs-and-gaps/`](../../../../09/28/101-audit-bugs-and-gaps/overview.md)
> slices 08 and 09, both `not_started`; every row re-checked is still live.

## Critical

### 1. Two JS implementations of "how Postgres compares a column"
- `packages/query/src/shape.ts:142` (`compareValues`, `same`, `matchesFilter`) decides by `typeof`.
- `packages/entity/src/memory-match.ts:45` (`compareByKind`, `sameValueOfKind`) decides by declared column kind.
- Rule: axiom 1. Both ran on the same inputs:

| Input | query | entity |
|---|---|---|
| `bigint` text `'10'` vs `'9'` | `-1` (lexical) | `1` |
| `numeric` text `'2.50'` vs `'10'` | `1` | `-1` |
| `uuid` equality, upper vs lower | `false` | `true` |
| `timestamptz` `Date` vs its ISO string | `false` | `true` |

- Reaches users: `bigint()` columns are decimal strings (`packages/entity/src/columns-data.ts:87`); query's comparator runs the live matcher (`packages/query/src/matcher.ts:61,91,192`), the memory source (`source.ts:137-140`), the seek fallback (`source.ts:317`), page slicing (`pagination.ts:131`). A live query ordered on `bigint()` / `decimal()` patches rows into a different position than the database returns.
- Fix: `QueryShape.entity` names the entity and query already imports entity (`sealed-shape.ts:9`) — resolve kinds, call entity's functions. Delete `compareValues`, `compareNumeric`, `mixed`, `same`, `family`, `normalize` in `query/src/shape.ts`.
- Missing guard: one `(kind, left, right)` fixture table through both evaluators and Postgres.

### 2. `app.config.ts` re-imported and re-parsed by 15 loaders
- 16 occurrences of `(await import(configPath)) as Record<string, unknown>` in 15 files of `packages/cli/src/`: `app-auth.ts:25`, `runtime-jobs.ts:39`, `runtime-cache.ts:77`, `runtime-realtime.ts:45`, `runtime-notify-retention.ts:58`, `serve-drain.ts:20,34`, `site-config.ts:46`, `theme-boot.ts:31`, `pwa-artifacts.ts:139`, `page-navigation.ts:72`, `page-speculation.ts:40`, `shot-locale.ts:26`, `app-env.ts:56`, …
- Rule: axioms 1 and 2. Each has its own defaults and trust policy: `runtime-jobs.ts:30` "handed on AS WRITTEN"; `runtime-notify-retention.ts:39` "re-screened here"; `page-speculation.ts:34` refuses.
- Fix: one `loadAppConfig(root)` returning the validated, default-merged `AppConfig`. Delete the 15 walks.
- Missing guard: refuse `import(` of `APP_CONFIG_FILE` outside that module.
- Headers this makes false: `packages/cache/src/purge-env.ts:3`; `packages/jobs/src/driver.ts:319`, `packages/mail/src/driver.ts:219`, `packages/scraping/src/driver.ts:105`.

## High

| # | Where | Finding | Fix | Owner call? |
|---|---|---|---|---|
| 3 | `packages/entity/src/repo.ts:75` vs `packages/query/src/pagination.ts:28` | two public `Page` types; `nextCursor: null` means "last page" in one, "empty page" in the other. Query also carries `endCursor` / `hasNextPage` aliases (`:23-37,46`) no tracked app reads | keep query's `{rows, nextCursor, hasMore}`; delete entity's `Page` and both aliases | yes — wire-breaking, next major (plan-08 row 4) |
| 4 | `packages/action/src/job-handle.ts:14-31`, `packages/jobs/src/register.ts:41` | axiom 2's action → job projection does not exist; `X_ACTION_JOB_UNBRIDGED`; the only bridge is `agentJob()` in `ai` | `job()` accepts the structural handle, or delete `.job()`, `ActionJobHandle` and "job handle" from axiom 2 | yes |
| 5 | `scripts/lib/tiers.ts:88-92`, `packages/scraping/src/recover.ts:40-44` | `scraping` at tier 5 for `recover: 'agent'`, which always throws `X_NOT_IMPLEMENTED`; real floor is 4. `packages/scraping/CLAUDE.md:23-24` claims a deleted `cli → scraping` edge | delete the `'agent'` variant, the `FLOOR_ABOVE` row, the paragraph; move to tier 4 | yes (plan-09 A) |
| 6 | `packages/jobs/src/driver-redis.ts:66`, `driver-nats.ts:63`, `index.ts:122,174`, `packages/cli/src/cmd-jobs.ts:137-138` | two exported all-throwing drivers; `x jobs drain --to redis|nats` can only fail. `driver.ts:2` says "six methods and no more"; the interface (`:273-312`) has more | delete both, their exports, the two `--to` values; fix the header | yes (plan-09 A) |
| 7 | `packages/core/src/config.ts:185-186,271-272`, `scripts/lib/config-reader-pins.ts:25-29` | `defaultTimeZone` / `defaultCurrency` read by nothing; pinned as "read by APP code"; neither tracked app reads them. A `'UTC'` default contradicts "no ambient default" | delete both keys, scaffold lines (`packages/cli/src/templates/scaffold-repo.ts:200-201`), app lines, pin rows | yes (plan-09 A) |

## Medium

| # | Where | Finding | Fix |
|---|---|---|---|
| 8 | `packages/http/src/html-render.ts:11`, `packages/mail/src/html.ts:14`, `packages/cli/src/cmd-shot-matrix.ts:97`, `packages/admin/src/dev/server.ts:88`, `packages/render/src/html.ts:29`, seo's `escapeAttribute` | six HTML escapers, four character sets, two "one owner" claims | keep seo's pair (tier 1, already imported by render); delete the rest. Guard: refuse a local `&amp;` replace chain outside the owner |
| 9 | `llms.txt:56`, `docs/architecture/02-boundaries.md:28`, `wiki/Project-Layout.md:136`, `packages/scraping/CLAUDE.md:23`, `wiki/Contributing.md:80` | sideways-edge list hand-written in seven places, four wrong | project `SIDEWAYS_ALLOW` from `scripts/lib/tiers.ts` (plan-08 row 6, two more sites) |
| 10 | `packages/core/src/errors.ts:219,236` plus eleven package copies (`auth/src/errors.ts:383`, `auth/src/oauth-errors.ts:165`, `db/src/errors.ts:422`, `storage/src/errors.ts:370`, `seo/src/errors.ts:185`, `pwa/src/errors.ts:135`, `realtime/src/errors.ts:409`, `jobs/src/errors.ts:457`, `cli/src/errors.ts:386`, `scraping/src/error-throws.ts:436`, `admin/src/errors.ts:261`) | eleven local `X_NOT_IMPLEMENTED` constructors; `oauth-errors.ts:163` uses the code for "adapter returned no row" | delete the ten plain wrappers; the OAuth case gets its own code |
| 11 | `packages/auth/src/adapter.ts:73-81,115-123` | adapter capability methods optional "so a 1.2 adapter still compiles", at major 23; `directory.ts`, `revocation.ts` refuse at runtime | required in the next major; delete the refusals |
| 12 | `packages/action/src/idempotency-postgres.ts:31`, `packages/auth/src/rate-limit-postgres.ts:20`, `packages/http/src/rate-limit-postgres.ts:21`, `packages/jobs/src/driver-pg.ts:83` | `PgExecutor` declared four times | one export from `db` (or `core`, if http stays db-free) |
| 13 | `packages/ai/src/gateway.ts:373`, `llm-cache.ts:122`, `embeddings.ts:107` | `cacheKeyFor` is insertion-order `JSON.stringify`, tools by name only; entries keyed on 32-bit `fnv1a`; embeddings duplicates `packages/flags/src/bucket.ts:17` | core's `fingerprint` (plan-08 row 5; the gateway key is new) |
| 14 | `packages/jobs/src/errors-requeue.ts:2`, `packages/auth/src/oauth-errors.ts:3`, `packages/cli/src/build-errors.ts:2`, `verify-errors.ts:2` | the size ceiling is the split criterion: 489 of 1,856 source files over 200 lines, 28 at 480–500, six at 499–500 | each constructor next to its one thrower; per-package refactor |

## Low

- `packages/storage/src/driver.ts:45-58` — `serverSideEncryption` exists only so three drivers can throw. Low confidence.
- `X_DB_STUDIO_FAILED` (`packages/cli/src/error-codes.ts:124,322`) has no thrower; waived by prose match in `error-unthrown.ts:23`. Seven codes use that waiver.
- 8 of 11 `PRIMITIVE_FACTORIES` absent from `examples/dummy`: `transition`, `agent`, `agentJob`, `hive`, `exportRows`, `purge`, `webhook`, `notifier` (plan-09 C).
- `packages/cache/src/purge-cloudflare.ts:24`, `purge-fastly.ts` hard-code vendor hosts; `docs/idea/00-thesis.md:101` says "a purge webhook, nothing more". Low confidence.
- Still open from plan-08: three xxHash32 copies (`render/src/render-static.ts:36`, `cli/src/site-assets.ts:73`, `cli/src/revalidated-response.ts:28`); two `readCookie` (`auth/src/session.ts:284`, `http/src/locale.ts:52`); stale `createOpfsLocalStore` comment (`cli/src/templates/scaffold-repo.ts:180`).

## Doc drift

| Where | Says | Reality |
|---|---|---|
| `docs/idea/14-roadmap.md:22` (M6) | e2e suite "pinned red" in `gated-apps.ts` | both `expectedRed` tables are `{}` |
| `scripts/lib/gated-apps.ts:36-43` | "to 2 again" | `{}` |
| `docs/idea/14-roadmap.md:18` (M2) | `x g resource` emits a plain `fetch` | no `fetch(` in the template; `X_BROWSER_TRANSPORT_BYPASS` guards it |
| `docs/idea/14-roadmap.md:25` (M9) | "branch environments" shipped | `x branch` is planned (`packages/cli/src/cmd-planned.ts:35`); only `x db branch` ships |
| `docs/idea/14-roadmap.md:44` | "row-by-row table is in `CLAUDE.md`" | no such table |
| `docs/idea/14-roadmap.md:149`, `16-app-targets.md:109` | "tier-5 `ui`" | tier 4 |
| `docs/idea/14-roadmap.md:33` | "28 packages" | historical, unmarked |

The `roadmap` step checks markers and file existence only — none of these fail.

## Known-red inventory

`expectedRed` is `{}` for both tracked apps (`scripts/lib/gated-apps.ts:34,47`). The debt is in the ratchets:

| Ratchet | Pinned | Needs |
|---|---|---|
| `scripts/error-map-backlog.ts` | 241 codes with no HTTP status decision | a status row or an off-socket decision each |
| `scripts/readme-fences-backlog.ts` | README examples that do not typecheck, 24 packages (`ai` 16, `entity` 14, `core` 12) | compiling examples |
| `scripts/lib/test-bare-error-pins.ts` | bare `throw new Error` in tests, 20 packages (`core` 30, `realtime` 25) | `expect.unreachable` |
| `scripts/lib/fix-shell-arg-pins.ts` | unscreened `${}` in `fix:` lines (`cli` 73, `scripts` 28) | `renderFixShellArg` |
| `scripts/lib/node-import-pins.ts` | `node:` imports with no `why:` (`cli` 91) | a comment or a Bun API |
| `proto-index-pins`, `secret-compare-pins`, `finite-bounds-pins`, `test-fix-pins` | per-package counts | per site |
| `scripts/lib/coverage-pins.ts` | `scripts` at lines 80, funcs 88 | tests |
| planned CLI | 9 commands plus `x db studio` exit `X_NOT_IMPLEMENTED` | build or delete |
| reserved codes | `X_CACHE_UNTAGGED_QUERY`, `X_SW_HAND_EDITED`, `X_SW_UNCACHEABLE` documented, no thrower | build the checks |

## Not a problem (do not re-open)

- Floor is checked — `checkFloors` + `FLOOR_ABOVE` in `boundaries`; every package at its floor or has a row.
- No sideways edge beyond the five.
- No production runtime in `cli` reaches `testing`, templates or `@babel/core` — `serve-graph.test.ts`, `publish-closure.test.ts`.
- `stableStringify` vs `canonicalJson` — document form vs injective hash form.
- Auth and http rate limiters — different algorithms, different tables.
- Storage `maxBytes` on s3 — re-checked at confirmation (`packages/storage/src/upload.ts:216`).
- Sentry reporter in core — a wire format, app-supplied DSN.
- Shipped guards copied into each app — deliberate; pinned by `scaffold-guards-style.test.ts:147-158`.
- `config-readers` unwired — asserted by `scripts/config-readers.test.ts:252` in `unit`.
- Driver parity — 22 `*parity*` suites.
- Planned commands as a second path — argued in `cmd-planned.ts:1-4,67-72`.
- `configureActionPathStyle` vs `setActionPathStyle`; `registerMountedRoutes` vs `setMountedRoutes`.
- No `export *` in shipped source.

## Not examined — handed to sweep 2

- `ui`, `admin` internals, `mcp`, `manifest`, `pwa`, `i18n`, `money`, `time`, `flags`, `notify`, `mail`.
- `render` SSR / hydration; realtime server and client store; `db` migrate / drift; `auth` OAuth.
- Most of `cli`'s `cmd-*` files and the generators.
- `wiki/`, `docs/architecture/`, package READMEs; axiom 6 bundle graphs beyond the import scan.
