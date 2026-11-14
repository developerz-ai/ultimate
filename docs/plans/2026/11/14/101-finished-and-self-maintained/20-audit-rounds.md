# 20 — Audit rounds until convergence

> Part of [`overview.md`](overview.md). Depends on: sweeps 0–9 merged and released. Tier: all.

## Files to change
Unknown by design: whatever a round confirms. Each fix sweep obeys the sweep caps and the lock rule.

## Steps
1. A round is one audit pass then one or more fix sweeps.

| Agent (read-only) | Scope |
|---|---|
| `bug-hunter` ×2 | tiers 0–2 · tiers 3–5 + `scripts/`, disjoint |
| `concurrency-auditor` | shutdown, at-least-once, reconnect, transactions, cache fills, the deploy path |
| `security-auditor` | one axis per round, rotating: authz + tenancy → injection + secrets → resource exhaustion + supply chain |

   Every second round swaps one `bug-hunter` for `dx-auditor` (scaffold each shape, upgrade from the previous minor, make realistic mistakes, grade the errors) and one for `architecture-reviewer` (second paths, dead declarations).
2. Evidence in, each round: the last 14 days of tracker issues, logs and `pg_stat_*` from both deployed apps ([`30`](30-infra.md)); the adopter canary's results; issues opened since the last round. A finding from production outranks one from reading.
3. Confirm before fixing: a finding counts only with `file:line` and a reproduction — a failing test, or a command and its wrong output. Unreproduced findings are dropped, not parked.
4. Grade: P0 data loss, security, a crash in production; P1 wrong result or a broken documented path; P2 everything else that is a real defect. Style is not a finding.
5. Fix: every confirmed finding gets a failing-first test, then the fix, in a sweep of ≤ 4 workers; release as a patch or minor; roll both deployed apps.
6. Repeat. Each round reads the files the previous rounds did not: keep the read ledger (package → files read) in the plan's `status.yml` notes so coverage widens instead of repeating.
7. Stop when two consecutive rounds each confirm zero P0/P1 and ≤ 5 P2. Cap at six rounds; if round six has not converged, stop anyway and record the trend in [`90`](90-owner-decisions.md) — the monthly `audit` brief ([`12`](12-maintainer-loop.md) M3) carries on.

## Tests
- Per finding: the reproducing test, next to source, named for the behaviour.
- Per round: `bun run verify`, `bun run scripts/reference-app-gate.ts`, the canary.

## Done when
- The convergence rule in step 7 is met, with the per-round counts recorded in `status.yml`.
