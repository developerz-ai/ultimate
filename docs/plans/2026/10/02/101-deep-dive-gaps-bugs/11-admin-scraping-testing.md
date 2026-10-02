# 11 — admin, scraping, testing

> Part of [`overview.md`](overview.md). Depends on: 04, 07, 10. Tier: 5. Path-disjoint from 12, 13.

## Files to change
| Where | Change | Row |
|---|---|---|
| `packages/admin/src/repo-entity.ts:91-113,154-161` | keyset seek on the pair: `sort > v OR (sort = v AND id > cursorId)` | `s1-t5 #1` |
| `packages/admin/src/pagination.ts:101-105`, `repo-entity.ts:96`, `fields.ts:219` | null-ness carried in the cursor, seek with `is-null` branches — or `sortable()` refuses a nullable column | `s1-t5 #2` |
| `packages/admin/src/form-decode.ts:71`, `widgets.tsx:74-75,241`, `crud.ts:277-296` | a datetime equal to the rendered `before` is left out of the patch | `s1-t5 #3` (REPRODUCED in `s3-be`) |
| `packages/admin/src/screen-system.tsx:18`, `screen-resource.tsx:248` | `orgId` passed to `entries()` when the actor has one | `s2-atss #8` (REPRODUCED) |
| `packages/admin/src/action-gate.ts:281-298`, `batch-matching.ts:71` | handler and audit append inside `audit.atomic`, as `auditedWrite` (`crud-outcome.ts:91`) | `s2-con #8`, `s2-atss #9` |
| `packages/admin/src/batch.ts:287-303`, `batch-job.ts:120` | `batchId` derived from request id + action + selection | `s2-con #11` |
| `packages/admin/src/jobs/job-repo.ts:62` | the admin page caps at `MAX_JOB_PAGE - 1` for this repo | `s2-atss #10` |
| `packages/admin/src/crud.ts:259-305` | `adminUpdate` refuses when `before` changed since the form was rendered | `s2-con` low |
| `packages/admin/src/screen-resource.tsx:293`, `relations.ts:143`, `search.ts:179`, `list-filters.ts:95-102`, `jobs/fleet-repo.ts:28-34` | an explicit no-scope list value; the `in` read chunked; a throwing repo listed under `skipped`; strict decimal + calendar checks; null-safe bound | `s2-atss` lows |
| `packages/admin/src/dev/panel-timeline.ts:72`, `panel-cache.ts:27-29` | catch `DevSourceUnavailableError` only — pattern `panel-live.ts:37-43` | `s2-atss` low |
| `packages/admin/src/dev/panel-db.ts:156-178` | `runSql` through `readOnlyQuery` (`packages/db/src/readonly-query.ts:125-141`); the statement by POST (route half: slice 12) | `s1-sec M3` |
| `packages/scraping/src/driver-cdp.ts:278` | `args` = `[...(options.options?.args ?? []), '--proxy-server=…']` after the spread | `s2-atss #1` |
| `packages/scraping/src/secrets.ts:116-129` | percent-encoded, form-encoded and HTML-escaped variants per value | `s2-atss #5` |
| `packages/scraping/src/url-secrets.ts:72` | conceal the whole URL and credential-shaped values only | `s2-atss #6` |
| `packages/scraping/src/http.ts:324-329` | header keys lower-cased when composing (`:194-197`) | `s2-atss #7` |
| `packages/scraping/src/robots-fetch.ts:87-90` | `redirect: 'manual'` + the per-hop `screen` of `http.ts:254` | `s2-sec M3` (CONFIRMED) |
| `packages/scraping/src/cdp-arm.ts:124` | interception armed on (or refused for) every new target | `s2-sec M4` (PLAUSIBLE — needs a fake that emits a target) |
| `packages/scraping/src/auth.ts` (`burnSession`, `markRefused`), `scrape-run.ts:215,254-258` | compare `savedAt` before burn / refuse; `persistSession` failure does not fail a logged-in attempt | `s2-con` lows |
| `packages/scraping/src/expect.ts:78-88`, `http-recorded.ts:65-67`, `cdp-target.ts:384,400` | `maxDrop` in `[0, 1)`; `!(age <= limit)`; a missing cookie port method refuses | `s2-atss` lows |
| `packages/testing/src/island-dom.ts:353-379` | `<!…>` tokenised as an empty `FakeText`; the five entities decoded | `s2-atss #2` |
| `packages/testing/src/fixture-island.ts:159`, `:182`, `preload.ts:50` | scratch directory removed from the file-boundary hook + `afterAll`; module path unique per mount | `s2-atss #3`, `s3-t45` New 2 |
| `packages/testing/src/cdp-launch.ts:170-176` | `rmSync` after `child.exited`, and after SIGKILL | `s2-atss #4` |
| `packages/testing/src/template-db.ts:132-149`, `:93` | drop + clone inside the lock, on one reserved connection | `s2-atss #14` (PLAUSIBLE, `live`) |
| `packages/testing/src/sealed-network.ts:39`, `determinism.ts:194-205,214-215`, `fixture-jobs.ts:246-252`, `harness.ts:174` | reset `lastIndex`; `announceMove` in `frozenClock`; `canonicalJson`; restore in `finally`; an `UltimateError` | `s1-t5` lows, `s2-atss` lows |

## Steps
1. Keyset: the existing tie test has two tied rows — the failing test needs ten equal sort values at page size 3, walking to exhaustion, on the memory driver and on Postgres (`contract`).
2. Audit atomicity changes what the log says for an action whose append fails: the handler's write rolls back with it. For a `matching` batch that means one transaction per chunk — check `batch-job.ts` chunk size against the `web` statement timeout.
3. Audit tenancy: the test is the `s3-be` probe — an org-A actor with `audit:read` sees no org-B actor id.
4. Datetime: prefer "omit an unchanged field" over full-precision rendering — `datetime-local` cannot carry milliseconds.
5. Scraping proxy drop exposes the worker's address on every container deploy that passes `--no-sandbox`: pull this one forward.
6. Redaction rows 5 and 6 pull opposite ways — one fixture table (secret, surrounding text, expected) drives both.
7. Leaked temp directories: the tests run under `bun test`, not `bun run` — `process.on('exit')` does not fire in a test file.

## Tests
- `packages/admin/src/repo-entity.test.ts`, `form-decode.test.ts`, `crud.test.ts`, `mounted-screens.test.ts`, `action-gate.test.ts`, `audit-pg.contract.test.ts`, `batch.test.ts`, `jobs/repos.test.ts`.
- `packages/scraping/src/egress.test.ts`, `secrets.test.ts`, `cdp-redaction.test.ts`, `http.test.ts`, `robots-fetch.test.ts`.
- `packages/testing/src/island-dom.test.ts`, `fixture-island-cleanup.test.ts`, `cdp-launch.test.ts`, `sealed-network.test.ts`.
- `bun test packages/admin packages/scraping packages/testing`

## Owned elsewhere
- Admin create / update authz never seeing written values (residual, `s3-prior` 05) — 2026-09-28 plan, slice 05.
- `packages/admin/src/mcp.ts:441` (`scopes: new Set()`) — 2026-09-22 plan 102, slice 10.
- Scraping's tier and `recover: 'agent'` (`s1-arch #5`), three CDP drivers (`s2-arch H3`) — slices 15, 14.
- Unaudited: `admin` form / widgets / registry / authz past line 80; `scraping` page and target layer; `testing` e2e stack (`s2-atss`, last table).

## Done when
- Ten rows with one sort value are all reachable; null-sorted rows are reachable or the column is refused as sortable.
- The audit screen is tenant-scoped; an action and its audit entry commit together.
- `localBrowser` keeps the proxy flag with caller args. An encoded secret is redacted; ordinary words are not.
- A `bun test` run leaves no `ultimate-island-*` or `x-e2e-chrome-*` directory behind.
