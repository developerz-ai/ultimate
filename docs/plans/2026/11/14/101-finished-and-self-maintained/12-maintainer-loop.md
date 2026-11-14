# 12 — The maintenance loop, closed in this repository

> Part of [`overview.md`](overview.md). Depends on: [`11`](11-compat-and-longevity.md). Tier: tooling. The platform-side half is [`31`](31-maintainer-platform.md).

## Files to change
- `docs/plans/2026/11/02/…/status.yml`, `docs/plans/2026/11/11/…/status.yml` — M1. Two live trackers with open rows; the second's `current_focus:8` still says "Next: 31.22.1".
- `wiki/Known-Gaps.md` — M1. Becomes the one ledger.
- `.dz/maintainer/maintainer.yml:77,84` — M2. Comments say "no branch protection"; a ruleset has been active since 2026-11-10.
- `.dz/briefs/` — M3. Four briefs (`health`, `improve`, `release-due`, `security-release`). Missing: main-red repair, audit sweep, production evidence, adopter canary.
- `scripts/health.ts`, `.dz/briefs/health.md` — M4. Ten rows; none for `bench`, `flake-hunt`, `compat`, a latched alarm, stale `dz/*` branches (3 for closed issues).
- `docs/ops/` (new `maintainer-runbooks/`) — M5.
- `scripts/lib/source-header-pins.ts` (316 rows), `secret-compare-pins.ts` (~62), `fix-prose-pins.ts` (~30), `adapter-port-pins.ts` (~29), `test-bare-error-pins.ts` (~26), `fix-shell-arg-pins.ts` (~17), `node-import-pins.ts` (~15), `proto-index-pins.ts` (~13), `coverage-pins.ts:80` (`scripts` at 83/89 against 95) — M6.

## Steps
1. M1: move every open row of both predecessor plans into this plan's slices (already mapped) or into `wiki/Known-Gaps.md` with a decision (build, deferred with a reason, rejected). Mark both trackers `superseded` with a pointer here. A guard: a plan tracker `in_progress` for more than 30 days with no commit fails the `roadmap` step.
2. M2: correct the comments; state the real protection by the command that reads it.
3. M3, one brief each, same shape as `health.md`:
   - `main-red.md` — triggered by a failed `ci.yml` on `main`: bisect by the failing step, revert first when a revert is clean, fix forward otherwise; never rerun to green.
   - `audit.md` — monthly: one rotating tier band through `bug-hunter`, `concurrency-auditor` or `security-auditor` (`.claude/agents/`), confirmed findings fixed with a failing-first test, capped at three PRs. This is [`20`](20-audit-rounds.md) continuing after the plan ends.
   - `evidence.md` — weekly: production evidence through [`30`](30-infra.md)'s read paths (tracker issues tagged with a framework code or frame, slow framework statements, dead jobs); each framework-attributable finding becomes an issue with the `x repro` bundle shape.
   - `adopter-canary.md` — after each release: run `x upgrade` + `x verify` against the tracked apps and a scaffold at the previous minor; a failure blocks nothing but files an issue before adopters meet it.
4. M4: health rows for the three workflows, for any bot-opened issue whose condition is no longer true, and for merged-and-stale branches (delete them).
5. M5: runbooks the briefs cite — main is red; a release commit is red (the 31.22.2 case: stamped, never published); the registry lags; a tag was squatted; a review bot disagrees; the model or key the platform runs on is retired; the maintainer itself is down for N days (who notices: the health row's own staleness, checked by `scorecard`-style scheduled workflow in this repository, not by the platform).
6. M6: burn each pin table to zero or to rows that carry a permanent reason; the ratchet refuses growth. Raise `scripts` coverage to the bar and delete its pin.

## Tests
- `bun test ./scripts/health.ts.test.ts` — each new row red on a fixture, green on the fix.
- `bun run x -- verify --only roadmap` — fails on a stale tracker fixture.
- Validate `maintainer.yml` against the platform's policy schema before merging (a scratch script; the schema lives in the platform's repository).

## Done when
- Exactly one plan tracker is `in_progress`; `wiki/Known-Gaps.md` holds every deferred item with a decision.
- Each of the four new briefs has run once and left evidence (an issue, a PR or a recorded "nothing found").
- `source-header-pins.ts` is empty.
