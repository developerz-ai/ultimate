# 11 — Compatibility and longevity

> Part of [`overview.md`](overview.md). Depends on: [`10`](10-test-determinism.md). Tier: CI, release tooling, docs.

## Files to change
- Remote branches + `scripts/release.ts`, `scripts/release-due.ts` — L1. Breaks are parked for `next`; no `next` branch exists, and no tracking issue (the previous plan's `90` done-when is unmet). Nothing merges `next` when the window opens.
- `SECURITY.md:10` + release tooling — L2. Promises previous-major security patches from `release/<major>.x` under dist-tag `maint-<major>`; neither exists for 30.
- `.github/workflows/ci.yml`, a new `compat.yml` — L3. One Bun (`.bun-version` 1.4.4), Postgres 17, Solid 1.9.17. Dependabot ignores Bun and Postgres majors; the monthly `improve` brief is the only Bun path.
- `docs/ops/` — L4. No playbook for a Bun, Postgres or Solid major.
- `scripts/health.ts` — L5. No check on the framework's own credentials: registry trust, the private-names secret, the docs-site origin.
- `wiki/Stability.md`.

## Steps
1. L1: create `next` from `main`; open the tracking issue listing every parked break (the previous plan's OD10 list, [`03`](03-db-entity-policy.md) E2, [`07`](07-gate-truth.md) G1 and G6, the `ERROR_DOCS_URL` flip). `ci.yml` already runs on `next`. A weekly job merges `main` into `next` and files an issue on conflict. `release-due.ts` gains the major path: when the window is open and `next` is green and ahead, it proposes the merge and the major bump as one PR (majors stay proposed, not auto-cut — [`90`](90-owner-decisions.md) OD3).
2. L2: `release.ts` cuts `release/<N>.x` from the last tag of a major when the next one ships, and publishes patches from it under `maint-<N>`. Do it for 30 now (window ends 2027-05-10, six months after 31.0.0). A health row turns red when a `maint` window has closed and the branch is still open, and when one is promised and absent.
3. L3: `compat.yml`, weekly and on dispatch, non-gating: the gate's `unit` + `live` on Bun latest and canary; Postgres 16, 17, 18; Solid latest 1.x. Each cell failing files or updates one issue, closed by its own green run. The supported range becomes a tested table in `wiki/Stability.md`, generated from the workflow.
4. L4: three playbooks, each a rehearsed sequence ending in the gate: raise `.bun-version` and the floor; move a Postgres major (the demo and the test services); adopt a Solid major behind `next`. Rehearse the Bun one for real in this sweep if a newer stable exists.
5. L5: health rows for trust and secret presence, read by command (the facts table in `CLAUDE.md`), each with the fix.

## Tests
- `bun test ./scripts/release-due-major.test.ts` — window open + `next` ahead proposes; window closed refuses.
- `bun test ./scripts/release.test.ts -t 'maint'` — a patch from `release/30.x` tags under `maint-30`, never `latest`.
- `bun test ./scripts/health.ts.test.ts`.

## Done when
- `git ls-remote origin next release/30.x` returns both; `npm view @ultimat3/core dist-tags` shows `maint-30`.
- `compat.yml` has one full run recorded and `wiki/Stability.md` shows the generated table.
