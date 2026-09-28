# Audit sweep: bugs, gaps, drift

## Goal
Fix the defects a 7-axis read-only audit found (As of 2026-09, tree at 22.8.2): 2 data-loss bugs in
`db`/`jobs`, 2 security holes in `http`, 1 release-order hole, and a set of documented-but-missing
surfaces. Close each with a failing-first test and ship behind `bun run verify` green.

## Context
- Bun-only, Postgres with no ORM (PGlite in dev/tests), SolidJS + own router, `@ultimat3/*` tiers 0–5.
- No new primitive. Every fix lives inside an existing one: `job` (retry/lease/scheduler), `action`
  (admin CRUD is actions), `route` (navigation, CSRF, cache headers), `task` (scheduler).
- Prior sweep, all slices done: [`../../23/101-framework-deep-sweep/overview.md`](../../23/101-framework-deep-sweep/overview.md).
  Nothing here repeats one of its rows; its deferred rows are its own `status.yml` `notes`.
- Reference patterns:
  - owner-fenced settle — `packages/jobs/src/driver-pg-sql.ts:142` (`SQL_HEARTBEAT` checks `claimed_by`), `packages/jobs/src/outbox-relay.ts:84`
  - late-bound drain deadline — `packages/jobs/src/scheduler.ts:412` (`budget.bind`)
  - empty secret = unset — `packages/storage/src/driver-local.ts:62` (`usesDevStorageSecret`)
  - origin check with no anonymous exemption — `packages/realtime/src/sync-origin.ts:26`
  - serialised turns on one connection — `pglite-turns.ts` (db)
- New error codes only via `bun run new-error-code <CODE> --package <pkg> --title '…' --fix '…'`
  (writes registry + `wiki/Error-Codes.md` row together).

## Tiers touched
| Package | Tier | Why it must change |
|---|---|---|
| `core` | 0 | empty `ULTIMATE_CURSOR_SECRET` accepted as a key |
| `money` | 1 | `trimZeroFraction` strips non-whole zeros |
| `storage` | 1 | prefix-key `ENOTDIR` raw error; non-atomic `put`; HMAC omits disk base |
| `db` | 1 | `withTransaction` resolves on a server-side rollback |
| `http` | 2 | anonymous CSRF exemption; `javascript:` passthrough; `max-age` leak; timer overflow |
| `entity` | 2 | array containment null ≠ Postgres |
| `jobs` | 3 | `deadLetter:false` loops forever; unfenced ack/nack; scheduler double-fire; relay deadline |
| `render` | 4 | router follows non-http(s) `load` |
| `mcp` | 4 | regex flags dropped; missing jobs/tasks tools |
| `mail` | 4 | `Reply-To` not address-encoded |
| `admin` | 5 | create/update authz never sees written values |
| `cli` | 5 | signal forwarding, `x new --dir`, dev-lock race, e2e silent skip |
| `scripts/`, `.github/` | — | publish order, release gate, verify args, corpus globs, demo `:latest` |

Land lowest tier first. No slice needs a new import edge.

## Plan files (execute in order)
1. [`01-core-money-storage.md`](01-core-money-storage.md) — cursor secret, money format, storage driver correctness.
2. [`02-db-transaction.md`](02-db-transaction.md) — COMMIT on an aborted tx; concurrent nested savepoints.
3. [`03-http-entity.md`](03-http-entity.md) — CSRF, redirect scheme, shared-cache leak, deadline overflow, array-null parity.
4. [`04-jobs.md`](04-jobs.md) — terminal drop, owner-fenced settle, atomic scheduler fire, relay deadline.
5. [`05-tier4-5-services.md`](05-tier4-5-services.md) — render nav guard, MCP regex flags, mail Reply-To, admin write authz.
6. [`06-cli.md`](06-cli.md) — CLI handoff signals, `x new --dir`, dev lock, e2e all-skipped, verify args.
7. [`07-release-ci.md`](07-release-ci.md) — topo publish order, release waits on all CI jobs, corpus globs, demo `:latest`.
8. [`08-architecture-dedup.md`](08-architecture-dedup.md) — one hash, one escaper, one cookie reader, one `Page`, typed step names, generated edge prose.
9. [`09-gaps-and-docs.md`](09-gaps-and-docs.md) — promised-but-missing surfaces (owner decisions), stale docs.

Slices 01–07 are path-disjoint. 01, 02, 03, 06, 07 run in parallel as a team in this checkout; 04
after 02 (transactional fire); 05 after 03 (mirrors the scheme guard). 08 touches files near several
of them — after 01–07 merge. 09 last.

## Done when
- Each CONFIRMED finding has a test that fails on `main` at `fcfe31dc` and passes after the fix.
- `bun run scripts/reference-app-gate.ts` green, `expectedRed` still empty.
- `bun run verify` green, all 20 steps.

## Risks / open questions
- **Owner decisions, before 09 and part of 08 start** (do not guess):
  - `AppConfig.defaultTimeZone` / `defaultCurrency` (`packages/core/src/config.ts:194-195`): read by nothing. Delete, or wire into `configureTime`?
  - Locales declared twice: `AppConfig.locales` (`core/src/config.ts:192`) vs `defineCatalogs` (`i18n/src/define-catalogs.ts:56`). Which survives?
  - Redis/NATS job drivers (`jobs/src/driver-redis.ts:40`, `driver-nats.ts:37`) all-`X_NOT_IMPLEMENTED`: build, or delete + move `x jobs drain` to `PLANNED_COMMANDS`?
  - Plain action → job: `docs/idea/02-primitives.md:57` promises it, `jobs/src/register.ts:41` refuses (`X_ACTION_JOB_UNBRIDGED`). Build `actionJob()` or correct the doc?
  - `scraping` `recover: 'agent'` (`scraping/src/recover.ts:27`) always throws; justifies a `FLOOR_ABOVE` row. Ship or delete both.
- CSRF fix changes behaviour for every anonymous non-GET: API clients without Origin/Sec-Fetch-Site and without `Authorization` will now get `X_CSRF_BLOCKED`. Needs a CHANGELOG line; decide whether that is a major (semver: yes if a shipped app breaks).
- The `deadLetter:false` fix introduces a terminal `'failed'` state for exhausted jobs; `JOB_STATES` already has it — check `x jobs list` and admin views render it.
- Ask premise: "find problems" — none falsified; audits also recorded ~30 falsified suspicions (listed per slice under *Not a bug*) so the executor does not re-open them.
- Unaudited areas (next sweep, not this plan): realtime server side, render SSR/hydration, db migrate/drift, entity repos/tenancy, http pipeline stages, auth oauth/jwks, ~140 guard scripts, most CLI generators, SQL identifier interpolation in `pg-sql.ts`, mail header injection, admin HTML XSS.
