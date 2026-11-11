# Full-stack efficiency sweeps: every measured defect, idle cost and hand-rolled mechanism, closed

## Goal
Make Ultimate measurably faster, cheaper at idle and harder to misuse, from evidence: fix every confirmed defect, remove the framework's own idle cost in a deployed app, ship the mechanisms eleven apps hand-rolled, and make the gate catch what it let through — then move every app onto the result. The bar is unchanged: would a serious team, inspecting this with or without an AI, find a reason to pick something else?

## Context
- Bun only, Postgres with no ORM (`entity()` + hand-written SQL), SolidJS 1.9.x + own router, `@ultimat3/*` tiers 0–5 (`scripts/lib/tiers.ts`). As of 2026-11-11: 31.4.2, 31 workspaces, 11,928 tracked files.
- **v31 is the stable line.** Everything here ships as 31.x patches and minors. A break waits on `next` (`X_BREAKING_ON_MAIN`); the next major is no earlier than 2027-02-08 (`X_RELEASE_MAJOR_WINDOW`). Each slice ships its non-breaking half and parks the break in [`90`](90-owner-decisions.md) OD10.
- Sources, all 2026-11-11, all read-only: 14 audit passes over every package (bugs, performance, memory, tests; four passes on tiers 3–4, three on tiers 0–2, two on tier 5); a techniques catalogue of ~190 items checked against the tree (~150 present); a developer-experience pass that scaffolded and built an app; production evidence from two deployed apps (`pg_stat_statements` and table stats of one, pod logs, the error tracker, 16 GETs to the demo); eleven application repositories. Probes were throwaway; each slice's failing-first test is the durable copy.
- No ninth primitive. New capability here is a factory over a primitive (`cronJob`, `uploadFlow`: one `PRIMITIVE_FACTORIES` row each in `packages/core/src/registrar.ts`), a method on an existing handle, or a guard.
- Adopters are named A–J in every committed file (J is an app inside an infrastructure-tooling repository, checked out twice); the mapping lives off-tree with the owner. Never write an adopter's name here.
- Reference patterns: conformance — `packages/testing/src/job-driver-conformance.ts`; factory — `packages/jobs/src/partitions.ts:112`, `packages/ai/src/llm.ts`; work-count pin — `packages/schema/src/standard.large.test.ts`; ratchet — `scripts/lib/test-real-sleep-pins.ts`; guard header → docs — `scripts/guards-doc.ts`; bench claim — `scripts/bench-claims.ts`.

## What the evidence says, in one table
| Class | Headline | Slice |
|---|---|---|
| Fixes that lie | a printed boundary fix leaves 45 type errors; a printed `--force` overwrites a slice's policies; MCP `tests.run` fails tests the shell passes; `x manifest` silently rebaselines `contract-diff` | [`19`](19-agent-tooling-dx.md) |
| Confirmed defects | built-asset routes share the per-address rate limit (429 on chunks); an MCP error tells the agent to run `x db reset`; a paginated provider loses rows past its window (in the reference app); cache and live-window keys built from raw input; 7 duplicate indexes in the deployed demo | [`01`](01-hotfix-patch.md) |
| Idle cost in production | ~2,700 framework statements an hour on an idle app; ~72% of WAL; claim planning 8.8× execution; one job = 1 insert + 4 non-HOT updates across 8 indexes | [`09`](09-jobs.md), [`06`](06-http.md), [`03`](03-db.md) |
| Unreadable errors | every error-tracker issue has zero stack frames; one code splits into five issues | [`02`](02-schema-core.md) |
| Hand-rolled in ≥ 2 apps | set-based writes, newest-per-group, lease/heartbeat/stale-sweep, task + job pairs, upload pairs, form answers, bounded fan-out, audit batching | [`05`](05-entity.md), [`08`](08-action-query.md), [`09`](09-jobs.md), [`02`](02-schema-core.md) |
| Shipped but undiscovered | `keyset()`, `pollEvery()`, row security (0 of 11 apps), 21 guards an upgrade never installs | [`14`](14-cli-commands-upgrade.md), [`19`](19-agent-tooling-dx.md) |
| A gate that goes green on nothing | 487 of 487 scale verdicts `unproven`; 14,892 statements in one call; no route `load` exercised; public signatures unguarded | [`13`](13-cli-exercise-verify.md), [`16`](16-gate-ci-docker.md) |
| Plan drift | two items the previous plan marked complete never shipped: `insertAll({ returning: false })`, `maxPageBytes` | [`05`](05-entity.md) E3, E4 |

## Tiers touched
| Package | Tier | Why it must change |
|---|---|---|
| `schema`, `core` | 0 | nested-validation cost; logger and metric-key cost per request; error-reporter frames and fingerprint; `mapBounded`; `FRAMEWORK_ENV`; memory-limit gauge |
| `db`, `cache`, `seo`, `money` | 1 | storage parameters, index DDL, slow-statement line, pool-gate abort, migration lock lint; memo bound, byte count; one clock seam |
| `entity`, `policy`, `http`, `auth` | 2 | set-based writes, per-group reads, index covering rule; `scope`; request floor, compression, unlogged rate limit, slow-request line; one-statement authenticate |
| `action`, `query`, `jobs`, `realtime` | 3 | provider window, native answers, `uploadFlow`, audit batching; idle cost, `onSettled` re-drive, lease handle, `cronJob`; lsn-chain gaps, hook cleanup |
| `render`, `ai`, `mcp`, `notify`, `pwa`, `ui` | 4 | island mount boundary; stream billing, filtered vector recall; MCP caps and cancellation; bounded fan-out; cache bound; keyed toasts |
| `cli`, `testing`, `admin` | 5 | asset bucket, exercise, verify plan, upgrade, doctor, commands, island vendor chunk, precompression; property/soak/a11y; bounded dashboards |

Land lowest tier first. New edges, all downward: `action → storage` (`uploadFlow`), `render → action` (the native-answer read). An import that would go up or sideways is a design error, not a `boundaries` exception.

## Sweeps (one PR each, ≤ 4 agents, ≤ 100 files, merged before the next)
Lock rule: a slice's *Files to change* is its agent's exclusive set. Intersect the sets before dispatch; two slices sharing a file go to one agent. Workers never git and never spawn; the coordinator runs `bun run verify` once per sweep and owns `CHANGELOG.md` + `wiki/Upgrading.md`, `wiki/Error-Codes.md` + `packages/http/src/error-map.ts` (`bun run new-error-code`), `framework.manifest.json`, `bun.lock`, `status.yml`. The caps are the house default; [`90`](90-owner-decisions.md) OD0 asks whether to widen the mechanical sweeps.

| Sweep | Slices | Agents → exclusive paths | Est. files | Tier band |
|---|---|---|---|---|
| 0 | [`01`](01-hotfix-patch.md) | W1 `cli/src` asset routes, `mcp-host.ts`, `cmd-drill.ts`; W2 `http/src/rate-limit-config.ts`, `query/`, `examples/dummy` `org-posts`; W3 `realtime/src/live-*`; W4 `money/`, `admin/src/form-decode.ts`, `jobs/src/limits.ts`, the demo migration | 40 | 1 → 5 |
| 19a | [`19`](19-agent-tooling-dx.md) FX1–FX11 | W1 boundary findings, `x fix boundary`; W2 policy generator, scaffold templates; W3 `mcp-host.ts` test/verify parity, `x dev` log tee, load-finding dedupe, seeds in `unit`; W4 `contract-diff` baseline, dev reload, i18n sync, error catalogue, fix scan | 55 | 5 |
| 1 | [`02`](02-schema-core.md), [`04`](04-cache-seo.md) | W1 `schema/`; W2 `core` error reporter + fingerprint; W3 `core` logger, metrics, `visible-interval`, `retry`, image; W4 `core/src/map-bounded.ts`, `cache/`, `seo/` | 45 | 0–1 |
| 2 | [`03`](03-db.md), [`06`](06-http.md) | W1 `db` storage parameters, index DDL, introspection (+ `cli/src/framework-schema-apply.ts`); W2 `db` slow line, pool gate, migration lint; W3 `http` pipeline, stages, error-facts, `scripts/bench/http-pipeline*`; W4 `http` compress, ETag (+ two `cli` files), rate-limit store, slow-request line | 60 | 1–2 |
| 5a | [`05`](05-entity.md) E1–E4, E13 | W1 chain write terminals, `updateMany`; W2 `returning: false`, COPY probe; W3 `maxPageBytes`, read cancel; W4 conformance fixtures, docs | 50 | 2 |
| 5b | [`05`](05-entity.md) E5–E12 (E14 if OD6), [`07`](07-auth-policy.md) | W1 `latestBy`, `preload perParent`; W2 aggregates, trigram; W3 `registry`/`describe`/`tenant-index` + `db` index render; W4 `auth/`, `policy/`, `lockKeys`, row observer | 70 | 2 |
| 8 | [`08`](08-action-query.md) | W1 `query/`; W2 native answers (`action/src/http.ts`, `render` flash read); W3 `upload-flow`, audit batching; W4 docs | 50 | 3 |
| 9a | [`09`](09-jobs.md) J1–J10 | W1 DDL, heartbeat, index diet; W2 claim path, outbox, steps-with-claim; W3 counters, registry, scheduler | 50 | 3 |
| 9b | [`09`](09-jobs.md) J11–J19, [`10`](10-realtime.md) | W1 settle re-drive; W2 lease handle, debounce, expiry, Redis `EVALSHA`, step ceiling, `maxPending`; W3 `cronJob`, docs; W4 `realtime/` | 75 | 3 |
| 11 | [`11`](11-render-islands.md), [`12`](12-notify-ai-mcp-pwa.md) | W1 island vendor chunk, budgets; W2 precompression, `Link` header, inline style, `render/src/island-mount.ts`; W3 `ai/`, `mcp/`; W4 `notify/`, `pwa/` | 70 | 4–5 |
| 13a | [`13`](13-cli-exercise-verify.md) X1, X2, X4, X7, X10; [`14`](14-cli-commands-upgrade.md) U1–U4 | W1 `testing` scale sweep, statement ceiling; W2 `cli` exercise findings, floor, dotenv; W3 upgrade, guards baseline; W4 doctor probes, `core/src/framework-env.ts`, `scripts/framework-env.ts` | 60 | 0, 5 |
| 13b | [`13`](13-cli-exercise-verify.md) X3, X5, X6, X8, X9, X11, X12; [`14`](14-cli-commands-upgrade.md) U5–U12 | W1 exercise routes, seed cache, shard; W2 verify plan, scaffold workflow, coverage remap; W3 four commands, `x explain`; W4 factory generators, boot warnings, readiness, role load | 90 | 5 |
| 15 | [`15`](15-admin-ui-testing.md), [`20`](20-ops-defaults.md) | W1 `admin/` (+ `jobs/src/introspection.ts`); W2 `ui/`; W3 `testing` property, soak, a11y + eight properties; W4 `docker/helm`, chart generators, `scripts/log-levels.ts` | 65 | 4–5 |
| 16 | [`16`](16-gate-ci-docker.md) | W1 corpus + host checks; W2 `verify.test.ts`, slow tests, splits; W3 `.github/`; W4 Dockerfiles, `scripts/public-api.ts` | 60 | scripts, CI |
| 17a | [`17`](17-test-determinism.md) non-`cli` | W1 `jobs` tests; W2 `realtime` tests; W3 `render`, `http`, `core` tests; W4 `db` + the small packages | 95 | tests |
| 17b | [`17`](17-test-determinism.md) `cli` | four workers by file-name band (`cmd-*`, `dev-*`, `runtime-*`, the rest) | 100 | tests |
| 18 | [`18`](18-tracked-apps.md) | W1 `examples/dummy`; W2 `dummy/social-media-clone`; W3 `dummy/docs-site` + `cli/src/schema-dump-drift.ts` | 60 | apps |
| 19b | [`19`](19-agent-tooling-dx.md) Y1–Y11 | W1 `.claude/` hooks, agents, `feature.md`, `.mcp.json`; W2 MCP dev tools; W3 verify output, narrow re-runs, `x docs` ranking, docs fixes; W4 scaffold agent files, two guards | 50 | tooling, docs |
| R | [`30`](30-infra.md), [`40`](40-adopter-a.md)–[`49`](49-adopter-j.md) | one agent per repository, ≤ 4 at a time; each its own PR in its own repository | n/a | other repositories |

About 1,145 files in this repository, 18 PRs, plus the infrastructure PRs and one PR (or more, ≤ 100 files each) per adopter.

**Before each sweep dispatches its workers**, one `bug-hunter` reads the files of that sweep's packages listed under *Unread* below and reports to the coordinator; a confirmed finding joins the sweep's slice with a failing-first test. **After each sweep's diff exists**: `/code-review` on the PR, a `concurrency-auditor` pass for sweeps 9a, 9b, 11 and 2 (pool gate, compress cache), a `security-auditor` pass for sweeps 0, 2, 5b (auth: OAuth, passkeys, authorization server), 8 and 11 (MCP). Review agents count toward the four.

## Plan files (execute in sweep order)
1. [`01-hotfix-patch.md`](01-hotfix-patch.md) — twelve confirmed defects; ships alone as a patch.
2. [`02-schema-core.md`](02-schema-core.md) — validation and logging cost per request; error-tracker frames and grouping; `mapBounded`.
3. [`04-cache-seo.md`](04-cache-seo.md) — memo bound, allocation-free byte count, `memoPerRequest`, one clock seam.
4. [`03-db.md`](03-db.md) — storage parameters, index DDL, slow-statement line, pool-gate abort, migration lock lint, the prepared-pool question.
5. [`06-http.md`](06-http.md) — the request floor, brotli and a compressed-body cache, validator form, an unlogged rate-limit table, slow-request line.
6. [`05-entity.md`](05-entity.md) — set-based writes, `returning: false`, per-group reads, filtered aggregates, trigram, expression indexes, the covering rule.
7. [`07-auth-policy.md`](07-auth-policy.md) — one statement to authenticate; `policy.scope`.
8. [`08-action-query.md`](08-action-query.md) — provider windows, native form answers, `uploadFlow`, audit batching.
9. [`09-jobs.md`](09-jobs.md) — idle and lifecycle cost; `onSettled` re-drive, lease handle, `cronJob`, debounce, expiry.
10. [`10-realtime.md`](10-realtime.md) — lsn-chain gap detection, clean walsender close, hook cleanup, write ordering.
11. [`11-render-islands.md`](11-render-islands.md) — shared Solid chunk, precompressed assets, `Link` preload, island mount boundary.
12. [`12-notify-ai-mcp-pwa.md`](12-notify-ai-mcp-pwa.md) — stream billing, filtered vector recall, MCP caps and cancellation, bounded fan-out.
13. [`13-cli-exercise-verify.md`](13-cli-exercise-verify.md) — exercise that cannot pass on nothing; route loads; statement budgets; one gate plan.
14. [`14-cli-commands-upgrade.md`](14-cli-commands-upgrade.md) — upgrade installs guards; doctor probes; env registry; four commands; generators.
15. [`15-admin-ui-testing.md`](15-admin-ui-testing.md) — bounded admin reads, keyed toasts, property tests, heap canary, rendered a11y.
16. [`20-ops-defaults.md`](20-ops-defaults.md) — burn-rate alerts, a dashboard, a log-level policy with a guard.
17. [`16-gate-ci-docker.md`](16-gate-ci-docker.md) — parallel host checks, one corpus, cache keys, image layers, public-API signature guard.
18. [`17-test-determinism.md`](17-test-determinism.md) — the real-sleep ratchet to zero; a changed-files rerun job.
19. [`18-tracked-apps.md`](18-tracked-apps.md) — the three tracked apps adopt everything above.
20. [`19-agent-tooling-dx.md`](19-agent-tooling-dx.md) — 19a (right after sweep 0): fixes that worsen the tree, an MCP test path that disagrees with the shell, a rebaselining `contract-diff`. 19b (last): `.claude/` hooks, MCP dev tools, discoverability.
21. [`30-infra.md`](30-infra.md) — evidence paths, alerts, dashboards; from the infrastructure repository.
22. [`40-adopter-a.md`](40-adopter-a.md) … [`49-adopter-j.md`](49-adopter-j.md) — one per application, each from its own repository.
23. [`90-owner-decisions.md`](90-owner-decisions.md) — ten decisions with defaults; four outward steps.

## Done when
- Every finding row in every slice is closed by a test that was red first, or closed in writing with the measurement that made it unnecessary.
- Production, one day after the last framework release, through the infrastructure read paths: an idle app issues under 150 framework statements an hour (from ~2,700); the framework's share of WAL at idle is under 25% (from ~72%); a replicator rollout causes zero window invalidations; error-tracker issues carry frames, one issue per code.
- In-process hello and 404 at least 20% under the first recorded figures (`scripts/bench/results/http-pipeline.json`).
- The three tracked apps: every route `load` exercised, no `expectedQueryLoop` for a shape this plan made expressible, zero redundant indexes, every `expectedRed` table empty.
- `scripts/lib/test-real-sleep-pins.ts` at zero for `jobs`, `realtime`, `render`, `http`, `core`, `db`.
- `wiki/Known-Gaps.md`: the rows for `onSettled`, the companion job, native form answers, the unsniffed `grantUpload` target closed.
- Adopters A–E, G–J on the release that carries the plan, each gate green, each named wrapper deleted.
- The scaffold session of [`19`](19-agent-tooling-dx.md) re-run: 19 planted mistakes, none with a fix that worsens the tree, none blamed on the wrong file.
- `bun run verify` green — all 21 steps — and `bun run scripts/reference-app-gate.ts` green, on the final commit of every sweep.

## Risks / open questions

**Claims in the ask or in earlier reports that the code disproves:**
- "Counter caches" are not missing: `packages/entity/src/counter.ts` (`countedIn`), trigger in `packages/db/src/generate-counter.ts`. What is missing is their visibility to the row observer, which is why the reference app does not use them ([`05`](05-entity.md) E10).
- N+1 prevention exists three ways (`packages/entity/src/coalesce.ts`, `jit-preload.ts`, `preload.ts`) with a detector (`n-plus-one.ts`). The remaining N+1s are shapes the chain cannot express, and page reads the exercise step never runs.
- "~64 kB of fixed cost per live island" (an adopter's document): it is the shared `page-runtime` output, fetched once (`packages/cli/src/island-runtime.ts:1-4`). The per-island duplicate is Solid only.
- "No heartbeat for long jobs": lease renewal is automatic (`packages/jobs/src/heartbeat.ts`). Missing: a handle for the body, and a re-driven `onSettled`.
- "No agent-eval helper" (an adopter report): present, `packages/ai/src/eval-agent.ts`. Cross-model fallback is decided out (`packages/ai/CLAUDE.md`).
- The previous plan's `07-entity.md` rows E6 and E7 are marked complete; neither exists in the tree (`packages/entity/src/pg-write-sql.ts:132`; no `maxPageBytes` anywhere).
- Bench regression as a gate step is decided out (`.github/workflows/bench.yml:6`); this plan pins work counts in tests and publishes wall-time as bench claims.
- A real-sleep guard already exists (`scripts/test-real-sleep.ts`); slice 17 lowers its ratchet and adds no guard.

**Unread after the audits** (each sweep's pre-dispatch `bug-hunter` reads its share):
| Sweep | Unread |
|---|---|
| 2 | `http`: `request.ts` body parsing, `bearer-mount.ts`, the websocket upgrade; `db`: pool sweep/retire, drift, generation internals, pglite; `storage`: multipart, signed URLs, upload scanning |
| 5a, 5b | `entity`: tenancy, aggregates, history, partition, search mirror, sealed; `auth`: OAuth/OIDC, passkeys, the authorization server |
| 8 | `action`: `client.ts`, `transition*.ts`, `define-api.ts`, `openapi*.ts`, `meter*.ts`; `query`: `query.ts`, `client.ts`, `http.ts` |
| 9a, 9b | `jobs`: `backfill-*`, `steps-wait.ts`, `steps-unwind.ts`, `webhook.ts`, `webhook-receiver*`, `consumer*`, `ledger*`, `rollup.ts`, `driver-memory*`; `realtime`: `channel-*` (20 files), `sync-worker.ts`, `page-*`, `record-*`, `offline-queue*`, `nats-*`, `live-reauth.ts`, `live-resume.ts` |
| 11 | `render`: `hydrate.ts`, `island*.ts`, `head.ts`, `render-stream.ts`, `render-ssr.ts`, `route*.ts`, `navigation-modal*`; `ai`: providers' bodies, `agent*.ts`, `rag.ts`, `hive*.ts`; `mcp`: `meta-*`, `validate-args.ts`, `oauth-*`; `pwa`: push; `scraping`: the CDP driver; `mail`: drivers other than SMTP; `notify`: ledger, inbox, digest; `manifest`: all |
| 13b | `cli`: `prerender.ts`, `cmd-deploy.ts`, generators and templates beyond those named, the island pipeline past its build options |
| 15 | `ui`: ~85 components read only by a listener/timer scan; `admin`: CRUD, batch, related screens; `testing`: drill internals |
| 1 | `core`: config/secrets, `client-flight.ts`, span cost; `time`: cron, business; `i18n`: context, extract |

**Evidence limits:**
- The demo database's statistics were unreadable ([`30`](30-infra.md) I1); every production statement figure is one adopter's, near idle, over 26.4 h. Idle cost is well evidenced; behaviour under load is not. No load test was run.
- Pod logs reached back under an hour (8–11 rollouts a day). Error and warning *rates* are unknown until [`30`](30-infra.md) I3.
- Findings marked *plausible* were reasoned from code, not reproduced: each slice's first step measures before it fixes, and a row that does not reproduce is closed in writing.
- Measured figures come from one shared 12-core box. Treat them as relative.

**Design risks:**
- [`09`](09-jobs.md) J4 (wake-driven idle) trades polls for four correctness properties; its four property tests are written first and must each fail against a naive long sleep.
- [`06`](06-http.md) H5 (`unlogged` rate-limit table): after a database crash buckets refill. Stated in Upgrading; `x_auth_lockouts` is excluded by name.
- [`02`](02-schema-core.md) C2 changes error grouping: existing issues regroup once.
- [`13`](13-cli-exercise-verify.md) turns new findings red in every app; each lands with a ratchet `x upgrade` writes, never a silent green and never a surprise red.
- [`03`](03-db.md) D3 (a prepared pool) is a second pool: built only if the claim's plan cannot be simplified, and never exposed to apps.
- Open work in plan `docs/plans/2026/11/02/101-absorb-reinvented-patterns` overlaps: its `41-add-entity-lifecycle` (85%) with [`05`](05-entity.md) E10, its `31-test-false-green` (95%) with [`13`](13-cli-exercise-verify.md) X3. Finish those slices there first, or fold them here and mark them superseded there — the coordinator decides at sweep 5b and records it in both `status.yml` files.
