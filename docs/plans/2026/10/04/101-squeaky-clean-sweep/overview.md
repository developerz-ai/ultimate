# Squeaky-clean sweep: every bug, leak, legacy path and open issue, to 25.0.0

## Goal
Make Ultimate safe to hand a large, high-stakes customer: fix every defect two read-only audit waves
found at `d7b8c7fa` (24.0.0), resolve every open issue (29, As of 2026-10-04), delete the legacy and
second paths, update dependencies, make it work on Windows, and finish with an attested 25.0.0 and a
readiness gate. Security and data integrity land first.

## Context
- Bun only (1.4.0 → 1.4.2 in sweep 3), Postgres with no ORM (PGlite in dev/tests), SolidJS 1.9.x + own
  router, SCSS modules + tokens, `@ultimat3/*` tiers 0–5 (`scripts/lib/tiers.ts`). **No new dependency.**
- **No new primitive.** Every row fixes or extends one of the eight; new capabilities in
  [`10-carried-backlog.md`](10-carried-backlog.md) are options/factories over existing ones.
- **Evidence:** 13 read-only agents in two waves + a Windows audit — tier bugs ×3, security,
  concurrency, legacy/architecture, open issues ×2, stale plans, second pass ×4, Windows. Every row is
  `file:line` + failure scenario; most are proven by a probe. Falsified leads and unreached files:
  [`11-audit-coverage.md`](11-audit-coverage.md).
- Supersedes the open trackers of `2026/08/12/101`, `2026/09/22/102`, `2026/09/28/101`; closes
  `2026/10/01/101` and `2026/10/02/101` (reconciled in this plan's own PR).

## How a sweep runs (binding — `.claude/commands/feature.md`)
- **A sweep = one coordinator + ≤ 4 agents on disjoint paths → one PR, ≤ 100 changed files →
  `bun run verify` green → CI green + agent reviews (CodeRabbit et al.) addressed → merged → `main`
  pulled → next sweep.** Never two PRs open. Agents never spawn, never touch git.
- Each slice's *Agents* table is the file lock. Coordinator-only files: `CHANGELOG.md`,
  `wiki/Error-Codes.md`, `framework.manifest.json` (`bun run manifest`, once), `bun.lock`, `status.yml`.
- **Failing test first** for every row: it must fail on `d7b8c7fa` and pass after.
- **High-stakes review:** a PR touching auth, policy, mcp, http, db, jobs or realtime gets
  `security-auditor` + `concurrency-auditor` (+ `bug-hunter` for 12a) read-only over the diff
  **before** it opens; confirmed findings fixed in the same PR, listed in the body.

## Tiers touched
| Package | Tier | Why |
|---|---|---|
| core, schema | 0 | deprecation home (07), cookie/SigV4 seams (10a), DECIMAL export (06) |
| time, storage, i18n, db | 1 | count/calendar screens (04), upload sniff + fix-line escaping (01), object lock (10a), append-only trigger (10b) |
| http, auth, entity | 2 | bearer scope oracle, sessions, OAuth pre-hijack (01); drain (02); redirect decode, error page (04) |
| action, query, jobs, realtime | 3 | rate limits on every surface (01); leases, webhooks, idempotency (02); write echo, shared runtime (09) |
| mcp, ai, render, pwa, mail, notify, ui | 4 | scope fail-open, hive leak (01); digest replay (02); parity (04); issues (05) |
| cli, admin, testing, scraping | 5 | robots, /media (01); replicator, helm, stop sequence (02); guards, CI, issues (06); Windows (08) |
Land lowest tier first inside a sweep. No new sideways edge; S4 (`action` → `http` `RateLimitStore`) is a downward import.

## Sweeps (one PR each, ≤ 4 agents, ≤ 100 files, merged before the next)
| Sweep | Slices | Agents → exclusive paths | Est. files | Tier band |
|---|---|---|---|---|
| 0 | this plan + `.claude/commands/{feature,planx}.md` + tracker reconciliation; then issue triage (step below) | coordinator | ~25 | docs |
| 1 | [`01-security.md`](01-security.md) | A mcp/http scopes · B action/ai · C auth · D storage/scraping/realtime/jobs-webhook | ~40 | 1–5 |
| 2 | [`02-data-integrity.md`](02-data-integrity.md) | A drain + roles + helm · B jobs · C notify · D action idempotency | ~45 | 2–5 |
| 3 | [`03-deps-bun.md`](03-deps-bun.md) | A Bun pin · B #276 · C #354 · D toolchain/actions/images | ≤ 100 (split biome lint fixes if over) | tooling |
| 4 | [`04-correctness.md`](04-correctness.md) | A http/i18n/time · B ai · C pwa/mail/ui · D realtime decode | ~35 | 0–4 |
| 5 | [`05-open-issues-web.md`](05-open-issues-web.md) | A navigation · B ui · C mcp · D http/cli dev | ~40 | 2–5 |
| 6 | [`06-cli-ci-tooling.md`](06-cli-ci-tooling.md) | A cli runtime · B cli cmds/admin · C guards · D CI/harness | ~60 | 5 + scripts |
| 7 | [`07-cleanup.md`](07-cleanup.md) | A fixture renames · B twins → core · C doc paths · D root trash | ~85 | 0–5 + docs |
| 8a–b | [`08-windows.md`](08-windows.md) | 8a: A line endings · B scaffold shell · C repo-root paths · D CI job — 8b: A binary · B browser · C dev processes · D paths/secrets/tsc | ~30 + ~45 | 0–5 + CI |
| 9 | [`09-realtime-islands.md`](09-realtime-islands.md) | A write echo · B shared runtime · C first paint · D e2e | ~40 | 3 + 5 |
| 10a–e | [`10-carried-backlog.md`](10-carried-backlog.md) | ≤ 4 per sub-sweep | ≤ 100 each | 0 → 5 |
| 11 | [`11-audit-coverage.md`](11-audit-coverage.md) (read-only wave; any time after 2) | R1–R4 bands | docs | — |
| 12a–b | [`12-major-25.md`](12-major-25.md) | deletions, then release | ≤ 100 | 0–5 |

**Sweep 0 issue triage** (coordinator, after this PR merges; comment cites the evidence, then close):
- Already fixed:
  - #629 `render/src/navigation-swap.ts:290-295`, ef16a571
  - #628 beaad04a, 23.0.0
  - #490 `2a72c00b`
  - #446 `18efd906` + `10edffe0`
  - #445 catalog half (`212102df`, `a8e2462d`, `4b4b92dc`, `0022518f`; bug half → #488)
  - #440 `0b514494`
  - #439 `0b514494`
- Decided in [`00-owner-decisions.md`](00-owner-decisions.md) (default close): #513, #491, #355, #615.

## Plan files (execute in order)
0. [`00-owner-decisions.md`](00-owner-decisions.md) — 21 carried + 15 new owner questions, each with a default or a block.
1. [`01-security.md`](01-security.md) — MCP scope fail-open, bearer oracle, OAuth pre-hijack, rate limits on every surface, session ceiling, hive leak, abuse caps.
2. [`02-data-integrity.md`](02-data-integrity.md) — drain stall, lease clocks, digest replay, webhook double-POST, stranded jobs, #591, replicator rollout, helm numeric tag.
3. [`03-deps-bun.md`](03-deps-bun.md) — Bun 1.4.2 + toolchain/actions/images; retire #276/#354 workarounds.
4. [`04-correctness.md`](04-correctness.md) — memory/pg + stream parity, unscreened counts, i18n, decode.
5. [`05-open-issues-web.md`](05-open-issues-web.md) — #627 #621 #488 #494 #590 #492 #541.
6. [`06-cli-ci-tooling.md`](06-cli-ci-tooling.md) — cli runtime/commands, guards that slip, CI deploy-proof, #444 #572 #519 #518.
7. [`07-cleanup.md`](07-cleanup.md) — test-only modules in tarballs, twins, dead doc paths + guard, root trash, 500-line files, #441 #442.
8. [`08-windows.md`](08-windows.md) — native Windows for contributors, app developers, and Windows hosts; a `windows-latest` CI job enforces it.
9. [`09-realtime-islands.md`](09-realtime-islands.md) — #507 #505 #506.
10. [`10-carried-backlog.md`](10-carried-backlog.md) — features owed by superseded plans (months, object lock, append-only, api routes, query audit, MCP confirm, SES, AI blocks, admin MCP, scaffold, factory coverage).
11. [`11-audit-coverage.md`](11-audit-coverage.md) — falsified leads, unreached files, wave-3 bands.
12. [`12-major-25.md`](12-major-25.md) — breaking deletions, 25.0.0 release, readiness gate.

## Done when
- Every row in 01–10 merged with a failing-first test, or moved to `wiki/Known-Gaps.md` with an issue
  (never a security or data-integrity row).
- `gh issue list --state open` holds no issue this plan covers; the owner-decisions issue holds the rest.
- Every `docs/plans/**/status.yml` is `complete` or `superseded` (guard 07 T10).
- [`12-major-25.md`](12-major-25.md) readiness table all green: `bun run verify` (20 steps, live
  services up), `bun run scripts/reference-app-gate.ts`, `windows-latest` CI job, 25.0.0 on npm attested
  (`bun run scripts/registry-audit.ts --json`).

## Risks / open questions
- **Owner decisions gate parts of 02 (D7), 05 (#492), 06 (#518), 09, 10, 12** — defaults given where
  safe; the rest wait ([`00-owner-decisions.md`](00-owner-decisions.md)). Several unanswered since 2026-09-28.
- **Claims the code disproved:**
  - "solve all open issues": 7 of the 29 are already fixed (sweep 0 list).
  - #541 is probably fixed already (10edffe0); it gets a test, not a fix.
  - #615's plan is done apart from owner decisions.
- **Behaviour changes in a minor:**
  - S1: an app whose `scopes:` map leaves a tool uncovered now fails to boot.
  - S4: `rateLimit` is now enforced over MCP and the agent too.
  - K9: `x jobs drain` becomes planned.

  Each is called out under **Changed** in CHANGELOG. They are security fixes, so they do not wait for 25.0.0.
- **Bun 1.4.2 grows browser bytes** (`.github/actions/setup/action.yml:89-100`, measured 2026-09-05):
  raise budgets by the measured amount (axiom 9), never stub.
- **Coverage is partial:** about a third of `packages/cli/src` and most of `scripts/` were not read
  ([`11-audit-coverage.md`](11-audit-coverage.md)). Don't claim the framework has been fully audited
  until wave 3 reports.
- **Windows in production vs axiom 7:** see [`08-windows.md`](08-windows.md) § Risks.
- The slices name no other product or repository; infrastructure changes (a demo deploy) are made
  from their own repository.
