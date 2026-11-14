# 01 — Production hotfixes

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 3–5 + CI. Ships alone as a patch.

## Files to change
- `packages/cli/src/site-llms-pages.ts:60-68` — H1. The collector runs a page `load`/`meta` under `runWithContext` with no request; a page reading `useActionAnswer` → `useRequestCookie` throws `X_NO_REQUEST` (5 events on 31.22.3).
- `packages/action/src/` (the `useActionAnswer` read) — H1. Outside a request there is no answer: return `null`, do not throw.
- `packages/jobs/src/execute.ts:404-406` — H2. Every retried attempt is reported as a `warning`; the tracker opens an issue and pages. 30 events / 6 issues for one expected retry.
- `packages/jobs/src/jobs-retention.ts` — H3. `done_rows`/`ended_rows` read the whole heap (3,534 blocks, 47.6 ms mean) though a partial index exists.
- `packages/jobs/src/` scheduler tick (`jobs.scheduler.tick-failed`) and the LISTEN redial — H4. 154 + ~60 identical lines per database restart.
- `packages/cli/src/` boot warning for `X_ASSET_RETAIN_UNDECLARED` — H5. 41 repeats; once per build id is enough.
- `.github/workflows/registry-audit.yml`, `scripts/registry-audit.ts` — H6. Opens or comments, never closes: #1096 says 31.12.0 while npm serves 31.22.3.
- `.github/workflows/bench.yml` — H7. Red on both runs (2026-11-09 schedule, 2026-11-10 dispatch: the first-hour step and the PR step); silent since.
- Six files #1104 names (`ci.yml`, `docs/architecture/guards.md`, two `packages/cli/src/cmd-doctor-*.test.ts`, `scripts/scaffold-gate*.ts`) + two carrying private repository names — H8.
- `scripts/private-names.ts` — H8. Covers adopter names only.

## Steps
1. H1: fix at the read (`null` without a request), then pin the collector with a page that calls `useActionAnswer`. Do not teach the collector to skip pages: one behaviour, at the source.
2. H2: report a retried attempt only when `decision.retry` is false (dead letter) by default. Keep the count: one metric increment per retried attempt, labelled by job and code. A job opts a retry into the tracker with a declared option on the job definition, not a global switch.
3. H3: rewrite the sweep to walk the partial index in bounded batches (follow the claim path's keyset in the same package). Pin the block count with a work-count test (`packages/schema/src/standard.large.test.ts` is the pattern).
4. H4: one line when a tick first fails, one when it recovers, a counter between. Reuse [`02`](02-core.md) C7's limiter if sweep 1 has landed; otherwise a local first/recovered pair and C7 replaces it.
5. H5: warn once per build id per role, not per boot.
6. H6: the audit closes its own issue on a clean run, and edits the title to the current gap on a dirty one. Close #1096 by that run, not by hand.
7. H7: reproduce both failures locally (`gh run view --log-failed`), fix the root cause; if the PR step needs a permission the workflow lacks, grant it in the workflow (`zizmor` clean). Add the workflow to `scripts/health.ts` ([`12`](12-maintainer-loop.md) M4).
8. H8: remove the names; widen `scripts/private-names.ts` to a public-tree check over `git ls-files` with the deny-list held in the existing private secret; answer and close #1104.

## Tests
- `bun test ./packages/cli/src/site-llms-pages.test.ts` — a page reading an action answer collects without throwing.
- `bun test ./packages/jobs/src/execute.test.ts -t 'retry'` — a retried attempt reports nothing and increments the metric; a dead letter reports once.
- `bun test ./packages/jobs/src/jobs-retention.live.test.ts` — block-count pin; fails on a heap scan.
- `bun test ./scripts/private-names.test.ts`, `bun test ./scripts/registry-audit.test.ts`.

## Done when
- #1096 and #1104 closed by their own mechanism; `bench.yml` green on a dispatched run.
- A patch release is on npm; the demo rolls to it and the tracker shows no new `X_NO_REQUEST` in 48 h.
