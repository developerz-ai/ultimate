# 09 — Docs: drift + missing pages

> Part of [`overview.md`](overview.md). Depends on: 06/07/08 (their pages document what lands). Tier: docs.

A pattern not in the wiki doesn't exist for the agents consuming it. Two kinds of work: fix what
drifted, write what's missing. Wiki pages: every internal link must resolve (currently all 39 do —
keep it that way). Docs style per `CLAUDE.md`: lead with the rule, fragments, tables, dated claims.

## The heaviest drift: `docs/architecture/15-adding-a-feature.md`

Six commands that don't exist as written, plus examples teaching what the spec forbids. Rewrite
against the real CLI and `docs/idea/02-primitives.md`:

| Line | Says | Reality |
|---|---|---|
| `:22,245` | `x manifest write` | no subcommands — `x manifest [--check] [--json]` (`packages/cli/src/cmd-manifest.ts:44-53`) |
| `:87` | `x db status` | subcommands are `gen\|migrate\|reset\|studio\|branch` (`packages/cli/src/cmd-db.ts:103`) |
| `:158` | `x live explain` | no `x live` command |
| `:256` | `x policies list` | `x policy` (singular) |
| `:20,212` | `x i18n add <keys>` | `add` takes a locale (`packages/cli/src/cmd-i18n.ts:144-145`) |
| `:246` | `.checks[]` in verify JSON | key is `steps` (`packages/cli/src/cmd-verify.ts:255`) |
| `:103` | policy reads `row` with no null guard | 02-primitives calls that "a bypass"; the app gets it right (`examples/dummy/apps/web/app/posts/policy.ts:79`) |
| `:104` | row identity through `input` | "Never reach for a row through `input`" |
| `:108` | policies declare repos, memoized lookups | no such mechanism — sync predicate + action `row:` loader |
| `:152` | `orderBy` with no unique tail | contradicts 02-primitives and its own `:158` |
| `:170` | `concurrency: { key, limit }` object | typed `number` (`packages/jobs/src/job.ts:50`) |
| `:190` | route `prerender` touching db directly | `X_BOUNDARY_ROUTE_TO_DB` exists for this (`wiki/Error-Codes.md:275`) |
| `:196` | `meta: ({ post })` | signature is `({ data, url, t })` |
| `:14,17` | actions in `apps/web/api/`, route at `app/posts/page.tsx` | app puts actions in `app/<feature>/actions.ts`; no such route file |
| `:198,252,258,261` | reserved/renamed codes presented as live | `wiki/Error-Codes.md:474-487` |

## Other drift

- `docs/ops/03-observability.md:127,141` — instructs about `x serve`; `wiki/CLI-Reference.md:338` correctly says it doesn't exist. Align on `runRole`/container boot.
- `docs/architecture/12-generated-app.md:144-146` — claims `route.ts` on `api/`; the reference app registers modules through `defineApi` and has zero `route.ts` files. State both, or make the claim true.
- `wiki/CLI-Reference.md` — `x g` flags `--admin` and `--locales` exist but are undocumented.
- `packages/auth/CLAUDE.md` — lists `@ultimat3/time` as a dependency; source imports it nowhere.
- `packages/jobs/src/scheduler.ts:28-30` — `catchUp: 'skip'` comment contradicts `:381-385` (02 decides which is right; docs follow).
- `examples/dummy/README.md:29,31,38,40` — four claims contradicted by the app's own code (fixed in [`05-dummy-app.md`](05-dummy-app.md); listed here so a docs-only executor doesn't miss them).
- `examples/dummy/apps/desktop/README.md:8` — `x app add desktop` is not a command.

## New pages (the three patterns)

- `wiki/Resource-Management.md` — the `using`/`await using` rule, which framework types are `Disposable` (from 06), the transaction/lock examples.
- `wiki/Batching-And-Preloading.md` — default-on JIT preload semantics, `preload()`, `insertAll`/`upsertAll`/`updateWhere`, `inBatches`, the tenancy guarantees, the jobs `PgExecutor` carve-out (from 07).
- `wiki/N-Plus-One-Detection.md` — how detection works, the two codes, `expectedQueryLoop`, the strict test fixture, why prod pays nothing (from 08).
- `wiki/Error-Codes.md` — rows for every code the other slices add (`X_PRELOAD_UNKNOWN_RELATION`, `X_N_PLUS_ONE_QUERY`, `X_N_PLUS_ONE_WRITE`, any new codes from 01/02); the `errors` verify step enforces presence (`X_ERROR_CODE_UNDOCUMENTED`).
- Cross-link from `docs/idea/02-primitives.md` (facility-under-a-primitive precedent) and `docs/architecture/` (a short internals page for the observer seam).

## Done when

- Every table row above fixed at its cited line; the three new wiki pages exist and are linked from the wiki index; `wiki/Error-Codes.md` covers all new codes; `bun run verify` green (the `errors` step gates the code rows; the link check is manual — verify all `](Page)` references still resolve).
