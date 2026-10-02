# Sweep 2 — admin, testing, scraping, scripts (files sweep 1 left unread)
> Re-checked in [`sweep-3-verify-tier-4-5.md`](sweep-3-verify-tier-4-5.md) — where it corrects a citation or narrows a row, that file wins.

> Findings for [`../overview.md`](../overview.md). Read-only hunt at `2ea5eb17` (23.0.0), As of 2026-10.
> Scope: the "not read" table of [`sweep-1-tier-5-scripts.md`](sweep-1-tier-5-scripts.md), minus `cli`.
> 1 high, 13 medium, 12 low. CONFIRMED = a probe ran. PLAUSIBLE = from reading.
> Coverage is partial — see the last section.

## High

| # | Where | Defect | Failing input → wrong output | Verdict | Fix direction | Test |
|---|---|---|---|---|---|---|
| 1 | `packages/scraping/src/driver-cdp.ts:278` | `localBrowser` drops `--proxy-server` whenever the caller passes `options.args` | `localBrowser({ proxy, options: { args: ['--no-sandbox', '--disable-dev-shm-usage'] } })` (the container flags) → the launcher gets the caller's args only; the browser dials direct while the session reports `proxy`; the HTTP leg and robots read use the exit — one session, two client IPs, the worker's real IP exposed | CONFIRMED | build `args` as `[...(options.options?.args ?? []), '--proxy-server=…']` after the spread | `packages/scraping/src/egress.test.ts` |

## Medium

| # | Where | Defect | Failing input → wrong output | Verdict | Test |
|---|---|---|---|---|---|
| 2 | `packages/testing/src/island-dom.ts:353-379` | `parseHtml` mis-reads Solid's `<!>` marker and never decodes entities | `parseHtml('<div>a<!>b</div>')` → 2 children, text `"a!>b"` (a browser gives 3 nodes); `mounted.text()` reads entities raw; Solid's `nextSibling` walk lands on the wrong node. Fix: tokenise `<!…>` as an empty `FakeText`; decode the five entities | CONFIRMED | `packages/testing/src/island-dom.test.ts` |
| 3 | `packages/testing/src/fixture-island.ts:159` | the scratch directory is never removed under `bun test` — a `process.on('exit')` handler registered in a test file does not fire | 4,551 leftover `ultimate-island-*` temp directories on the audit machine. Fix: the file-boundary hook + `afterAll` in `preload.ts` (pattern: `onFileBoundary(disposeLiveIslands)`, `preload.ts:50`) | CONFIRMED | `packages/testing/src/fixture-island-cleanup.test.ts`, run under `bun test` |
| 4 | `packages/testing/src/cdp-launch.ts:170-176` | `close()` deletes the browser profile right after SIGTERM; the browser re-creates it while shutting down | 2,537 leftover `x-e2e-chrome-*` directories. Fix: `rmSync` after `child.exited`, and after the SIGKILL branch | CONFIRMED | `packages/testing/src/cdp-launch.test.ts` |
| 5 | `packages/scraping/src/secrets.ts:116-129` | redaction matches the raw value only — a percent-encoded or HTML-escaped secret survives in `safeNetwork` / `safeHtml` | the failure artifact and network ring persist a query-string password — the case `safeNetwork`'s comment says it exists for. Fix: add `encodeURIComponent`, form-encoded, HTML-escaped variants per value (`url-secrets.ts:68-69` does both for a URL password) | CONFIRMED | `packages/scraping/src/secrets.test.ts` |
| 6 | `packages/scraping/src/url-secrets.ts:72` | every query-parameter value of a CDP or egress URL is concealed, ordinary words included | a URL with `stealth=true&proxy=residential` → every `true` and `residential` in page HTML, console, network becomes `[redacted]` — the unreadable artifact `MIN_REDACTABLE_LENGTH` exists to prevent. Callers `driver-cdp.ts:330`, `:248` | CONFIRMED | `packages/scraping/src/cdp-redaction.test.ts` |
| 7 | `packages/scraping/src/http.ts:324-329` | header precedence is case-sensitive — a caller's override merges instead of winning | `headers: { 'User-Agent': 'Mine', Cookie: … }` on a session with a jar → `user-agent: BrowserUA, Mine`; the declared cookie loses to the jar. Fix: lower-case keys, as `withoutCredentials` (`:194-197`) | CONFIRMED | `packages/scraping/src/http.test.ts` |
| 8 | `packages/admin/src/screen-system.tsx:18` | the audit screen reads every tenant's entries — `AuditQuery.orgId` exists and neither `entries()` caller passes it | an actor with `orgId: 'A'` and `audit:read` sees actor ids, entity names, operations from every org. The jobs dashboard scopes the same actor (`jobs/job-resources.ts:35`) | PLAUSIBLE (reading + grep) | `packages/admin/src/mounted-screens.test.ts` |
| 9 | `packages/admin/src/action-gate.ts:281-298` | the success audit entry is appended inside the handler's `try` (same root as [`sweep-2-concurrency.md`](sweep-2-concurrency.md) row 8) | handler succeeds, `audit.append` throws → the log holds `["failed","allowed"]`; the caller gets the sink's error for an action that happened | CONFIRMED | `packages/admin/src/action-gate.test.ts` |
| 10 | `packages/admin/src/jobs/job-repo.ts:62` | a job list at limit 200 can never page: the admin asks `limit + 1`, the store caps at `MAX_JOB_PAGE` (200), `pageFrom` reads no overflow | 205 jobs, `limit: 200` (the MCP list tool accepts it) → `hasMore: false`; five rows unreachable. `limit: 199` works | CONFIRMED | `packages/admin/src/jobs/repos.test.ts` |
| 11 | `scripts/pin-raises.ts:62-76`, `scripts/budget-raises.ts:94-96` | a `why:` / `measured:` comment left from an earlier raise licenses every later raise; the measured number is never compared to the budget | a pin row 3 → 30 under an existing `// why:`; a budget `30kb` → `900kb` under an existing `// measured: 20000 B` → 0 findings. Fix: the stating comment must differ from the base ref's text; measured ≤ new budget | CONFIRMED | `scripts/pin-raises.test.ts`, `scripts/budget-raises.test.ts` |
| 12 | `scripts/pin-raises.ts:25` | the glob `scripts/lib/*-pins.ts` misses ratchet tables whose headers say they may only shrink: `DOC_COMMAND_PINS` (`scripts/doc-commands.ts:71`), `README_FENCE_BACKLOG` (`scripts/readme-fences-backlog.ts`), `expectedRed` (`scripts/lib/gated-apps.ts`) | raising a row together with the debt passes every guard | CONFIRMED (reading; the guard reports 13 tables) | `scripts/pin-raises.test.ts` |
| 13 | `scripts/image-contract.ts:127-129`, `:204`, `:9` | three blind spots: `COPY --from=<external image>` / `--from=<stage index>` across libc families not followed; a tree with a Dockerfile and zero `.dockerignore` passes; only `docker/Dockerfile` is checked, not the demo's `Dockerfile.monorepo` that `deploy-social-demo.yml:137` builds | each probe → `[]`. All four tracked Dockerfiles pass today | CONFIRMED | `scripts/image-contract.test.ts` |
| 14 | `packages/testing/src/template-db.ts:147-151` | the clone runs outside the advisory lock; lock and unlock go through a pooled client — possibly different connections | intermittent `X_TEST_DATABASE_UNAVAILABLE` when another worker migrates the template | PLAUSIBLE, low — no Postgres run | `packages/testing/src/template-db.test.ts` |

## Low

| Where | Defect | Verdict |
|---|---|---|
| `packages/admin/src/screen-resource.tsx:293` | the related card reads with `scope: null`; `listHref` cannot spell "no scope" — the "all" link opens under the target's default scope, fewer rows than the card | CONFIRMED |
| `packages/admin/src/relations.ts:143` | `MAX_LABEL_IDS = 200` truncates silently — 300 referenced ids → 200 labels, the rest raw ids. Fix: chunk the `in` read | CONFIRMED |
| `packages/admin/src/dev/panel-timeline.ts:72`, `panel-cache.ts:27-29` | bare `.catch` on a source — a real failure shown as "no detector" / "no invalidations yet"; package `CLAUDE.md` says only `DevSourceUnavailableError` is caught. Pattern: `panel-live.ts:37-43` | CONFIRMED (reading) |
| `packages/admin/src/search.ts:179` | one resource whose repo throws takes down the whole search instead of listing under `skipped` | CONFIRMED |
| `packages/admin/src/list-filters.ts:95-102` | number / date filters accept non-values: a blank → 0, `0x10` → 16, an impossible calendar date reaches the driver | CONFIRMED |
| `packages/admin/src/jobs/fleet-repo.ts:28-34` | a keyset bound from a row whose sort value is `null` compares as `NaN` | PLAUSIBLE, low |
| `packages/scraping/src/robots-fetch.ts:87-90` | the robots read uses the platform's default redirect following and is never screened by `allowHosts` — the hole `http.ts:240-247` closed for the HTTP leg | PLAUSIBLE |
| `packages/scraping/src/expect.ts:333-336` | `maxDrop` has no range check — a value ≥ 1 (percent habit) makes the alarm never fire | PLAUSIBLE |
| `packages/scraping/src/http-recorded.ts:59` | `age > maxAgeMs` fails open on an unparseable `recordedAt`; `auth.ts:191` uses `!(age <= limit)` for this reason | PLAUSIBLE |
| `packages/scraping/src/cdp-target.ts:400`, `:384` | a launcher without `browser.setCookie` / `browser.cookies` silently restores or persists nothing; every other missing port method refuses | PLAUSIBLE |
| `packages/testing/src/fixture-jobs.ts:246-252` | `driver.close()` runs first — a throw skips restoring the ambient event bus and job driver for every later file. Fix: `finally` | PLAUSIBLE |
| `packages/testing/src/harness.ts:174` | `throw new ReferenceError('app is not booted yet')` — a bare error in shipped source | reading |

## Gaps

- `changelog-check.ts` never checks section order; `retentionBoundary` trusts the last section. Not shown to produce a wrong verdict.
- `doc-commands.ts` globs omit `examples/` and `dummy/` markdown, which `gate-steps.ts` reads.
- `guardYield` keys history on the scrape name only — a multi-tenant scrape shares one baseline. Design.

## Not a bug (do not re-open)

- Batch "all matching" uses the list's own `listWhere`; permission checked per batch and per row; cursor / sort do not leak in.
- MCP cannot smuggle a row id past the row scope — `id`, `ids`, `confirmation` are stripped.
- `auditedWrite` on `X_REPO_CLIENT_PINNED` — raised before the first statement.
- Lookup on a resource labelled by its id.
- Fixture-name parsing with comments in the destructuring pattern.
- `doc-citations.ts` fence desync — 0 of 213 pages end inside a fence.
- `guards-doc` exclusions; `version-stamps` (no `@ultimat3/*` peer dependencies); lockfile extra edges; `ERROR_STATUS_BACKLOG` growth by `--off-socket`.
- `cookie-scope.ts`, `http-redirect.ts`; `acquireCdp` release latch; `event-prompt` stale answers; watchdog shutdown; `island-selector.ts`.
- Bench units — `restart-bench-report.ts`, `restart-bench-seq.ts` consistent in ms.

## Still not read — a third pass would start here

| Area | Files |
|---|---|
| `admin` | `describe`, `list-columns`, `action-form`, `resource-fields`, `resource-layout`, `entity-columns`, `fields`, `widgets`, `form`, `layout`, `nav`, `pages`, `page-guard`, `routes`, `screens`, `mounts`, `actor`, `authz` (past line 80), `policy-bridge`, `permissions`, `registry`, `crud-input`, `validate` |
| `testing` | `island-observers`, `island-states*`, `e2e-*` (evaluate, selection, page, locator, driver), `live-node`, `registry-*`, `preload`, `factories*`, `render-view`, `matchers*`, `auth-request` |
| `scraping` | `page-over-target`, `html-target`, `html-query`, `cdp-a11y`, `cdp-snapshot`, `driver`, `driver-recorded`, `offline-session`, `recording`, `recover`, `events`, `failures`, `key-chord`, `actionability`, `scrape`, `target`, `page`, `secret-scan` |
| `scripts/` | `error-render`, `trust-publishers`, `scaffold-gate`, `scaffold-admin`, `doc-fixes`, `doc-config-keys`, `release-facts`, `gate-codes`, `readme-fences`, `node-imports`, `proto-index`, `finite-bounds`, `fix-shell-arg`, `i18n-catalog`, `llms-txt`, `package-map-graph`, `schema-dumps`, `secret-compare`, `config-readers`, `reference-app-unpin`, ~20 further guards, the rest of `bench/` |
