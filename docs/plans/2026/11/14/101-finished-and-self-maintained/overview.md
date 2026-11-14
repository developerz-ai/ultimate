# Finished and self-maintained: the last build plan before maintenance-only

## Goal
Close every known defect, gap and fragile seam, then run audit rounds until two in a row find nothing serious, and wire the maintenance loop so the next defect arrives as an outside report and is fixed, released and rolled out with no person watching. After this plan the repository takes only maintenance: reports, dependency and runtime upgrades, security fixes.

## Context
- As of 2026-11-14: 31.22.3 on npm, 31 workspaces, `main` green, 0 open PRs, 2 open issues (#1104, #1096). v31 is the stable line: everything here ships as 31.x patches and minors; a break waits on `next` (`X_BREAKING_ON_MAIN`), next major no earlier than 2027-02-08 (`X_RELEASE_MAJOR_WINDOW`).
- Bun only, Postgres with no ORM, SolidJS 1.9.x + own router, tiers 0–5 (`scripts/lib/tiers.ts`). No ninth primitive: new capability is a factory (`PRIMITIVE_FACTORIES`, `packages/core/src/registrar.ts:71`), a method on an existing handle, an adapter port (`registrar.ts:145`) or a guard.
- Sources, all 2026-11-14, all read-only: a residual-work inventory of this tree; ten application repositories read at their default branch (adopters A–J, the same letters as the 2026-11-11 plan; mapping off-tree with the owner); 7–14 days of production evidence from two deployed apps ("the demo", "adopter E") — error tracker, logs, `pg_stat_*`, pods; an end-to-end trace of the AI maintenance loop ("the maintainer platform") and the production database path ("the database gateway").
- Predecessors: [`2026/11/02`](../../02/101-absorb-reinvented-patterns/status.yml) at 99%, [`2026/11/11`](../../11/101-full-stack-efficiency-sweeps/status.yml) at 89%. Their open rows are **carried here** (the slice that owns each is named below); [`12`](12-maintainer-loop.md) step 1 closes both trackers as `superseded` so one plan is live.
- Never name an adopter, a product, a company or a host in a committed file. `scripts/private-names.ts` checks adopter names only; [`01`](01-production-hotfixes.md) widens it.
- Reference patterns: conformance — `packages/testing/src/job-driver-conformance.ts`; factory — `packages/ai/src/llm.ts`; ratchet pin table — `scripts/lib/test-real-sleep-pins.ts`; guard header → docs — `scripts/guards-doc.ts`; health row — `scripts/health.ts`; brief — `.dz/briefs/health.md`.

## What the evidence says
| Class | Headline (As of 2026-11-14) | Slice |
|---|---|---|
| Production defects, framework-owned | every rollout of the demo crash-loops two roles on `X_FRAMEWORK_SCHEMA_UNAPPLIED` until migrate runs; each retried job attempt is an error-tracker event that pages; `X_NO_REQUEST` thrown by the `llms.txt` collector on 31.22.3; the job retention sweep reads the whole `x_jobs` heap (3,534 blocks a call); 182k sequential scans of `x_jobs`; one log line per scheduler tick through a database restart; worker liveness answers from `/metrics` while the loop is wedged | [`01`](01-production-hotfixes.md), [`05`](05-jobs-realtime.md), [`09`](09-deploy-contract.md) |
| A gate that passes on nothing | no adopter runs all 21 steps; 6 of 9 let `live` skip, 7 of 9 let `e2e` skip, one never runs `x verify` at all; three wrote their own real-Postgres runner, one its own browser gate (492 LOC) after an all-skip run hid a broken page | [`07`](07-gate-truth.md) |
| Upgrades done by hand | each 31.x minor cost every app 13–80 hand-edited files: vendored guards re-copied, scaffold-owned files re-ported; six apps still carry workarounds for features that shipped | [`08`](08-upgrade-without-hands.md) |
| Hand-rolled in ≥ 2 apps | LLM routing with model fallback (2 apps, ~6,500 LOC); value-based error scrubbing; error-tracker triage; named job limiters; runtime-pin guards; transitive security pins | [`02`](02-core.md), [`05`](05-jobs-realtime.md), [`06`](06-ai-mail-scraping-ui.md), [`08`](08-upgrade-without-hands.md) |
| Shipped, never proven by an app | `flags`, `notify` in 0 of 10 apps; `pwa` unused by the one offline-first app; realtime multiplayer, multi-node realtime, static content site, `saas` and `agent` shapes unbuilt | [`13`](13-shapes-and-declaration.md) |
| Stubs | 32 `NotImplementedError` sites (11 in `packages/scraping/src/cdp-target.ts`), 8 planned commands in `packages/cli/src/cmd-planned.ts` | [`06`](06-ai-mail-scraping-ui.md), [`07`](07-gate-truth.md) |
| The maintenance loop is open | of the last 200 PRs 153 were the owner's, every release since 31.13.0 too; a main-red fix took 6 h 46 m and lost the race twice; a stale alarm (#1096) has stood for days; no route from a production error to this repository; no adopter is upgraded automatically; `bench.yml` red on both its runs | [`12`](12-maintainer-loop.md), [`31`](31-maintainer-platform.md) |
| Promises with nothing behind them | `SECURITY.md:10` promises `release/<major>.x` + `maint-<major>`; neither exists. No `next` branch, though breaks are parked for it. One Bun, one Postgres, one Solid in CI | [`11`](11-compat-and-longevity.md) |
| Evidence an agent cannot read | metrics store unreachable (502); job-state counts denied to the stats role; the framework's app databases are not gateway targets; events carry no framework version | [`02`](02-core.md), [`30`](30-infra.md) |

## Tiers touched
| Package | Tier | Why it must change |
|---|---|---|
| `core` | 0 | framework version on every event; value redaction; `defineError` problem meta; settle-all `mapBounded`; role-scoped boot warning; outbound proxy; repeated-line limiter |
| `db`, `cache`, `storage` | 1 | `--drop-redundant`; `memoPerRequest` forget; boot re-declaration proof |
| `entity`, `policy`, `auth`, `http` | 2 | nullable keyset keys, bare `.all()` truth, global-read tenant proofs; `scope` OR + chain; member-invite flow |
| `jobs`, `realtime` | 3 | retention by index, scan attribution, retry reporting, loop heartbeat, named limiters, at-most-once settle; multi-node proof |
| `ai`, `mail`, `scraping`, `ui`, `notify`, `pwa` | 4 | model fallback + provider parameters; inbound mail; the scraping port without stubs; a11y roles; first real proofs |
| `cli`, `testing`, `create-ultimate` | 5–6 | gate floor truth, `x dev --host`, upgrade codemods, guards without copies, repro bundles, shapes |

Land lowest tier first. No new edge is planned; one appearing is a design error, not a `boundaries` exception.

## Sweeps (one PR each, merged before the next)
House rule: ≤ 4 agents, ≤ 100 files. [`90`](90-owner-decisions.md) OD0 asks for the widening earlier plans ran under; until answered, the house rule holds. Lock rule: a slice's *Files to change* is its agent's exclusive set; two slices sharing a file go to one agent. Coordinator-only files: `CHANGELOG.md` + `wiki/Upgrading.md`, `wiki/Error-Codes.md` + `packages/http/src/error-map.ts`, `framework.manifest.json`, `bun.lock`, `status.yml`.

| Sweep | Slices | Agents → exclusive paths | Est. files | Tier band |
|---|---|---|---|---|
| 0 | [`01`](01-production-hotfixes.md) | W1 `jobs/src/execute.ts`, `jobs-retention.ts`, scheduler tick log; W2 `cli/src/site-llms*.ts`, `action` answer read; W3 `.github/workflows/{registry-audit,bench}.yml`, `scripts/registry-audit*`; W4 #1104 scrub, `scripts/private-names.ts` | 35 | 3–5, CI |
| 1 | [`02`](02-core.md), [`03`](03-db-entity-policy.md) | W1 `core` reporter (version, redaction, problem meta); W2 `core` `map-bounded`, boot warning, outbound, log limiter; W3 `entity/` + `db/` index DDL; W4 `policy/`, `cache/`, `storage/` | 80 | 0–2 |
| 2 | [`04`](04-auth-http.md), [`05`](05-jobs-realtime.md) | W1 `auth/` invite; W2 `jobs` retention, indexes, settle; W3 `jobs` heartbeat, limiters, scheduler; W4 `realtime/` | 80 | 2–3 |
| 3 | [`06`](06-ai-mail-scraping-ui.md) | W1 `ai/`; W2 `mail/`; W3 `scraping/`; W4 `ui/`, `notify/`, `pwa/` | 75 | 4 |
| 4 | [`07`](07-gate-truth.md) | W1 `cli` verify floor + `live`; W2 `cli` + `testing` e2e, island coverage; W3 `x dev` binding, planned commands; W4 scaffold templates, `x.verify.json` schema, docs | 85 | 5 |
| 5 | [`08`](08-upgrade-without-hands.md) | W1 guard delivery; W2 `x upgrade` codemods; W3 superseded-workaround table + doctor; W4 `x repro` bundle, pins | 85 | 5–6 |
| 6 | [`09`](09-deploy-contract.md) | W1 `docker/helm/templates`; W2 chart alert generators + dashboards; W3 `cli` role boot wait, liveness route; W4 `docs/ops/` | 50 | 5, chart |
| 7 | [`10`](10-test-determinism.md) | four workers by package band (`jobs`+`realtime`, `cli`, `testing`+`scraping`, the rest + guards) | 95 | tests |
| 8 | [`11`](11-compat-and-longevity.md), [`12`](12-maintainer-loop.md) | W1 `.github/workflows/`; W2 `.dz/`, `scripts/health*`, `scripts/release-due*`; W3 `docs/ops/` playbooks + runbooks; W4 pin burn-down | 90 | CI, tooling |
| 9 | [`13`](13-shapes-and-declaration.md) | W1 `saas` shape; W2 `agent` + realtime-multiplayer shapes; W3 content + offline shapes; W4 wiki, `docs/history/finished.md` | 95 | apps, docs |
| A1…An | [`20`](20-audit-rounds.md) | audit: 4 read-only agents; fix: ≤ 4 workers on the confirmed findings | ≤ 100 each | all |
| R | [`30`](30-infra.md), [`31`](31-maintainer-platform.md), [`40`](40-adopter-a.md)–[`49`](49-adopter-j.md) | one agent per repository, ≤ 4 at a time, each its own PR in its own repository | n/a | other repositories |

About 770 files in this repository across 10 PRs, then the audit rounds. Release: one patch after sweep 0, one minor per merged sweep (`chore/release-X.Y.Z`; merging the bump PR is the release). Sweep R runs after sweep 5 for the adopters (they need the upgrade tooling) and may run alongside 6–9; [`30`](30-infra.md) and [`31`](31-maintainer-platform.md) start after sweep 0.

After each sweep's diff exists: `/code-review` on the PR; `concurrency-auditor` for sweeps 2 and 6; `security-auditor` for sweeps 1, 2 and 5.

## Plan files (execute in sweep order)
1. [`01-production-hotfixes.md`](01-production-hotfixes.md) — seven production defects, two red automations, the public-tree scrub; ships alone as a patch.
2. [`02-core.md`](02-core.md) — events that name their framework version; redaction by value; the tier-0 gaps apps wrapped.
3. [`03-db-entity-policy.md`](03-db-entity-policy.md) — keyset on nullable keys, `.all()` that cannot stop silently, tenant proofs for global reads, `scope` OR, redundant indexes.
4. [`04-auth-http.md`](04-auth-http.md) — the member-invite flow the `saas` shape waits on.
5. [`05-jobs-realtime.md`](05-jobs-realtime.md) — retention by index, scan attribution, a heartbeat liveness can read, named limiters, multi-node realtime proven.
6. [`06-ai-mail-scraping-ui.md`](06-ai-mail-scraping-ui.md) — model fallback, inbound mail, a scraping port with no stub, a11y roles, first proofs for `flags`/`notify`/`pwa`.
7. [`07-gate-truth.md`](07-gate-truth.md) — a floor that cannot pass on a skipped step; real Postgres and a real browser in the default gate.
8. [`08-upgrade-without-hands.md`](08-upgrade-without-hands.md) — guards that are not copies, codemods for scaffold-owned files, stale workarounds reported, repro bundles.
9. [`09-deploy-contract.md`](09-deploy-contract.md) — migrate gates the roles; liveness means the loop runs; the alert rules production lacks.
10. [`10-test-determinism.md`](10-test-determinism.md) — the five recurring flake classes, each closed by one helper and one guard; a nightly repeat run.
11. [`11-compat-and-longevity.md`](11-compat-and-longevity.md) — `next`, the previous-major lane, a runtime matrix, upgrade playbooks for Bun, Postgres and Solid.
12. [`12-maintainer-loop.md`](12-maintainer-loop.md) — briefs, health rows and runbooks so every loop closes without a person.
13. [`13-shapes-and-declaration.md`](13-shapes-and-declaration.md) — every app shape scaffolded and gated; the written definition of finished.
14. [`20-audit-rounds.md`](20-audit-rounds.md) — repeat audit → fix until two rounds converge.
15. [`30-infra.md`](30-infra.md) — production evidence an agent can read; the demo's deploy order.
16. [`31-maintainer-platform.md`](31-maintainer-platform.md) — error routing, upgrade schedules, stall fixes, asked of the platform in its own repository.
17. [`40`](40-adopter-a.md)–[`49`](49-adopter-j.md) — one per adopter: full gate, workarounds deleted, automated upgrades on.
18. [`90-owner-decisions.md`](90-owner-decisions.md) — eleven decisions, each with the default taken if unanswered.

## Done when
- Every row of [`13`](13-shapes-and-declaration.md)'s finished table answers by its command, in CI.
- Two consecutive audit rounds ([`20`](20-audit-rounds.md)) report zero confirmed P0/P1 and ≤ 5 P2, all fixed.
- 14 days in production on the final release: zero framework-attributable error-tracker issues, zero crash-loops on rollout, in both deployed apps.
- 30 days with no owner-authored commit on `main`, during which the maintainer platform merged ≥ 1 fix and cut ≥ 1 release end to end, and every adopter moved to it by an automated PR.
- `wiki/Known-Gaps.md` is the only list of open work; both predecessor trackers read `superseded`; 0 non-test `NotImplementedError` sites outside rows it names.
- `bun run verify` green, `bun run scripts/reference-app-gate.ts` green, `bun run scripts/registry-audit.ts --json` clean.

## Risks / open questions
- **"Fix 99% so only outside reports remain" cannot be proven by a fix list.** The four previous plans each ended with a new list. The exit here is measured instead: convergence of [`20`](20-audit-rounds.md) plus the 14- and 30-day windows above.
- **"AI maintains it already" is half true.** The policy, briefs and auto-merge exist (`.dz/maintainer/maintainer.yml`), but the loop has never run without the owner: 153 of the last 200 PRs and every release since 31.13.0 were the owner's, and the two main-red fixes the platform built were closed as superseded. Unattended operation is unproven, and most of what stalls it lives in another repository ([`31`](31-maintainer-platform.md)).
- **"Check the database gateway" — it is deployed, but not for this.** Its targets are one shared cluster; the demo's own database admits no traffic from it, and the stats role is denied `x_jobs`. No framework change fixes that ([`30`](30-infra.md)).
- **The framework needs no production SQL path of its own.** `x mcp serve` refuses non-loopback hosts (`packages/cli/src/cmd-mcp.ts:130`). The gateway is the one path (axiom 1); nothing here adds a second.
- **A billing package would break axiom 8.** Prices and plans are business convention. The `saas` shape ships billing as app code over `webhook-receiver` + meters + `flags` ([`13`](13-shapes-and-declaration.md)); only the invite flow is framework mechanism ([`04`](04-auth-http.md)).
- **Security fixes still stop at a person.** The platform escalates every `security` item to a human and that cannot be switched off per repository. [`90`](90-owner-decisions.md) OD4.
- **Ten years outlives the pins.** Bun 1.4.4, Postgres 17 and Solid 1.9.17 are each one version in CI; the model and key the platform runs on will be retired. [`11`](11-compat-and-longevity.md) makes each a scheduled, rehearsed upgrade rather than a surprise.
- **Gate changes can turn adopters red.** Making a skipped `live`/`e2e` step fail is a behaviour change to `x verify`, which semver covers. 31.x ships it opt-in with a warning; the default flips on `next` ([`07`](07-gate-truth.md)).
- Raw production evidence was never committed and sat in a session scratch directory. The numbers the slices need are restated in them; re-probe through [`30`](30-infra.md)'s read paths before acting on a figure older than 14 days.
- Line numbers are As of 2026-11-14 (31.22.3). Re-locate by symbol before editing.
