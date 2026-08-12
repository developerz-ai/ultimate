# Framework audit + RAII, batching, N+1 detection

## Goal

Close what a four-way deep audit found (bugs, missing tests, doc drift, reference-app defects),
then ship three data-layer patterns — RAII resources, default-on JIT batching for reads *and*
writes, Bullet-style N+1 detection — so an AI building on Ultimate gets them out of the box.
Full implementation is the mandate: no slice resolves a gap by shrinking the documented surface.

## Context

- Bun-only monorepo, `@ultimat3/*` tiers 0–5 (`scripts/lib/tiers.ts:9-16`), imports only go down.
- None of the three patterns is a ninth primitive. RAII = language feature on existing types; batching = facility beneath `entity`'s `Repo`/`ReadBuilder` (the `readThrough` shape, `packages/query/src/cache.ts:76-96`); N+1 detection = a `Finding`/`X_*` code on existing dev channels. Precedent: `llm()` (`packages/ai/src/llm.ts:108-121`).
- Design bar: powerful defaults, zero ceremony, dev diagnostics that production never pays for, one canonical path. Complexity inside `packages/` is fine; ceremony leaking into app code is the smell.
- Key machinery: SQL funnels `packages/db/src/client.ts:132-141` + `packages/db/src/pglite.ts:125-131`; per-request memo pattern `packages/query/src/cache.ts:59-68`; relations declared-but-unread at `packages/entity/src/types.ts:62`; `ESNext.Disposable` already in `tsconfig.base.json:6` with zero `using` statements written.

## Tiers touched

| Package | Tier | Why |
|---|---|---|
| `core`, `schema` | 0 | version-at-import fix, `timingSafeEqual` home, schema code registration |
| `db`, `cache`, `seo`, `i18n`, `money`, `storage` | 1 | tx/lock/cache-stack bugs, Lua keys, env unification, observer seam, disposables |
| `entity`, `policy`, `http`, `auth` | 2 | relations + batching, test coverage, router/pipeline/rate-limit fixes |
| `action`, `query`, `jobs`, `realtime` | 3 | query HTTP projection, reconnect, single-flight, worker/scheduler lifecycle |
| `render`, `mcp`, `manifest`, `mail` | 4 | route-data, MCP exposure predicate |
| `cli`, `admin`, `testing`, `ui` | 5 | detector install + surfaces, panel fixes, strict fixture, verify skip visibility |
| `examples/dummy`, `docs/`, `wiki/` | app/docs | reference-app fixes, ratchet shrink, drift + new pages |

## Plan files (execute in order)

1. [`01-bugs-lower.md`](01-bugs-lower.md) — tier 0–2 bug fixes (tx leak, advisory lock, cache stack, URIErrors, conventions).
2. [`02-bugs-upper.md`](02-bugs-upper.md) — tier 3–5 (query HTTP projection, realtime reconnect, MCP exposure, NULL semantics, jobs lifecycle).
3. [`03-known-gaps.md`](03-known-gaps.md) — the four CHANGELOG-named 1.1.0 gaps, all verified still present.
4. [`04-tests.md`](04-tests.md) — uncovered clusters (policy, entity SQL/plan, auth secrets) + verify skip visibility.
5. [`06-raii.md`](06-raii.md) — `using`/`await using`, disposable connections/turns/locks/subscriptions.
6. [`07-batching.md`](07-batching.md) — relations from `references()`, default-on JIT preload, `preload()`, `insertAll`/`upsertAll`, `inBatches`.
7. [`08-nplusone.md`](08-nplusone.md) — statement observer + spans, per-request ledger, `X_N_PLUS_ONE_*` findings, strict test fixture.
8. [`10-build-vs-wrap.md`](10-build-vs-wrap.md) — the build-vs-wrap criterion as a `docs/idea/` page; verdicts: jobs BUILD (harden ours), NATS WRAP (nats.js behind the transport seam), SMTP BUILD.
9. [`11-migrations-backfill.md`](11-migrations-backfill.md) — one migration engine everywhere (drizzle-kit shell-outs removed), destructive-SQL rail, `backfill()` factory over `job` (batched, resumable, once-per-env, throttled).
10. [`05-dummy-app.md`](05-dummy-app.md) — reference-app fixes + ratchet shrink (after 02/07 land; numbered by audit area, executed here).
11. [`09-docs.md`](09-docs.md) — drift fixes + `Resource-Management`, `Batching-And-Preloading`, `N-Plus-One-Detection`, `Migrations-And-Backfills` wiki pages.

## Done when

- All S1/S2 and Critical/High findings fixed with failing-first tests; the four known gaps closed with their `wiki/Known-Gaps.md` rows deleted.
- A naive read loop in the reference app collapses to ≤2 statements by default and warns (dev) with a runnable `preload` fix when JIT is off.
- `EXPECTED_RED` pins shrink accordingly; `bun run scripts/reference-app-gate.ts` green.
- New codes registered + documented + `bun run manifest`; `bun run verify` green — all 17 steps.

## Risks / open questions

- **Query-over-HTTP: decided 2026-08-12 — implement it.** `packages/query/src/client.ts:52` fetches a route nobody mounts; the docs describe the intended behavior, so the code catches up to the docs, never the reverse. No de-documenting fallback anywhere in this plan: every documented-but-missing surface gets built.
- **`AsyncDisposableStack` runtime support in Bun** — verify before adopting in `packages/testing/src/fixtures.ts:144-178`; the manual loop stays otherwise.
- **JIT preload semantics** — coalesced queries must preserve tenancy scope and soft-delete filters exactly; a cross-tenant coalesce is a security bug, not a perf bug. Parity across both entity drivers is mandatory (`packages/entity/CLAUDE.md`).
- **False-positive suppression** — `expectedQueryLoop` is the single mechanism; resist per-code config lists (axiom 1). `packages/admin/src/search.ts:54-56` is the canonical deliberate loop.
- **`Money.minor` unification (01)** is a breaking change to a documented type — needs a major or an additive migration path; decide before touching.
- **Jobs queue traffic invisible to the observer** — `packages/jobs/src/driver-pg.ts:37-39` bypasses `DbClient`; documented carve-out, candidate follow-up.
- **Two migration engines confirmed 2026-08-12** — `x db` shells to drizzle-kit (`packages/cli/src/cmd-db.ts:113,134,154`) while `ROLE=migrate` uses the own ledger engine (`packages/cli/src/serve.ts:143-151`); 11 unifies on the own engine. `x db studio` needs a non-drizzle answer — planned-command fallback is acceptable, a retained second engine is not.
- The ask assumed problems exist; the audit confirmed extensively — nothing in the ask was falsified. The reference app's primitive usage is genuinely idiomatic; its defects are call-site bugs and the phantom join API, not misuse of the model.
