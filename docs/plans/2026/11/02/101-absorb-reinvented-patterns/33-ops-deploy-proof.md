# 33-ops-deploy-proof — Prove what zero-downtime claims: jobs, a migration, six deploys

> Part of [`overview.md`](overview.md). Depends on: [`33-ops-worker-roll`](33-ops-worker-roll.md), [`19`](19-cli-deploy-verify.md), [`04`](04-db-migration-safety.md); step 6 and the M8 flip on the retention half of [`28-assets-deploy-skew`](28-assets-deploy-skew.md). Tier: 5 (`cli`), plus `docker/deploy-proof` and workflows.

## Why
`deploy-proof` is green (0 of 9,028 requests failed, `docs/idea/14-roadmap.md:37`) and measures only HTTP against two images that differ by `BUILD_ID` alone (`docker/deploy-proof/run.sh:64-66`). So:

| Claim | State |
|---|---|
| a deploy never cuts a running job (owner goal) | process-level only, `packages/cli/src/serve-retire.live.test.ts`. No job runs during the proof |
| a migration during a roll drops nothing | no schema change in the proof. 04 fixes the migrations; nothing runs one under load on a cluster |
| "a rolling restart is invisible to connected clients" (`14-roadmap.md:27`) | the proof runs without `sync` (`:37`). True for HTTP. Sockets are measured by a forced-restart bench, not a roll |
| M8: six deploys, a tab left open, no 404 (`14-roadmap.md:24,84`) | undemonstrated. The row blames a missing harness and that is stale: `deploy.newBuild()` and `update()` work when the driver gets `restart({ BUILD_ID })` (`packages/testing/src/e2e-driver.ts:19`, `packages/cli/src/verify-e2e.ts:3`). What was missing is retention, 28 |
| the demo really serves what CI published | `deploy-social-demo.yml:7-9` admits a frozen updater reports nothing. Probe 2026-11-02: `/readyz` answered `sha-c68a477`, main's tip, so it works today, unwatched |

## Decisions
| Question | Answer |
|---|---|
| `sync` in the proof | no. It needs NATS, a replicator and `wal_level=logical` in kind; the job has minutes. Correct the sentence |
| Six deploys on a cluster or in a browser | browser. The claim is a tab and a chunk, not a Service; six rollouts in kind is ~4 min per main push |
| Hash realism | each round edits an island's source. `BUILD_ID` alone gives identical chunk hashes and a test that passes on nothing |
| Time budget | the job's 8-minute budget stands; p50 234 s. Ran on 20 of the last 40 main pushes, skipped by `scripts/deploy-proof-due.ts` otherwise |
| Demo check failure | a red workflow, which the daily `health` brief reads. No issue-writing job: `scripts/health.ts` already files |

## Files to change
- `docker/deploy-proof/run.sh` — after `x new`, add to the scaffold a slow job (`timeout: '5m'`, sleeps 60 s, records a row per attempt), an action to enqueue it, and in v2 only one nullable column via `x db gen` plus a marker migration. v1 and v2 now differ by a migration.
- `docker/deploy-proof/load.ts` — POST writes through the enqueue action and reads the new column path; the existing failure tally stands.
- `scripts/deploy-proof-due.ts:28` — `VERDICT_PATHS` gains `packages/jobs/src/worker` and `driver-pg`.
- `.github/workflows/deploy-social-demo.yml` — job `served`, needs `build`: `x deploy verify --url https://social-media.ultimate.demo.developerz.ai --build sha-<7> --timeout 10m --json`.
- `packages/cli/e2e/six-deploys.e2e.test.ts` (new) — the M8 claim.
- `docs/idea/14-roadmap.md:24,27,84` — flip M8 to ✅ in the same diff the test lands; row 11's sentence says HTTP, and sockets point at the bench. `scripts/roadmap.ts` reads the row.
- `wiki/PWA-And-Offline.md:247,329`, `wiki/Known-Gaps.md`.

## Steps
1. Proof, before `deploy "$NUMERIC_TAG"`: enqueue the slow job, wait for its row `running`.
2. Upgrade under load, unchanged.
3. Assert, by `kubectl exec` into Postgres: exactly one attempt row, state `done`, `claimed_by` a worker of v1; a second job enqueued after the roll is claimed by a v2 worker; `x_job_workers` lists a v2 worker for the queue; `drain.deadlineSeconds` (25) is well under the job's 60 s, so a pass cannot be the old behaviour.
4. Assert the old pod's exit was the retire: `jobs.worker.retired` in its log, read before it goes.
5. Refusals in the existing `refuse` shape, each naming the fix file, and `failed` still must be 0.
6. Six-deploy e2e, with 28's `assets.retain` set on a local disk: open a tab on build 0 with an `interaction` island not yet booted. Six rounds: edit the island, `update()`. Click. Assert the island runs build 0's code, its chunk answered 200, no 404 in the request log, and the page saw `AppUpdateAvailable`. Same run without `retain`: asserts the dead island, so it can fail.
7. Demo: `served` needs slice 19 and two minutes for the updater; `--timeout` covers it.

## Error codes
No new code. The shell proof refuses in its own form; `x deploy verify` uses 19's codes; the e2e test is a test.

## Tests
- The proof is the test: `bash docker/deploy-proof/run.sh`. To show it can fail, run once with `retireSeconds=0`: step 3 must refuse.
- `scripts/deploy-proof-due.test.ts`: the new paths are due.
- `packages/cli/e2e/six-deploys.e2e.test.ts`: `bun test packages/cli/e2e/six-deploys.e2e.test.ts`.
- `scripts/ci-workflow-shape.test.ts`: `served` needs `build`.

## Semver
none for apps. Docs and CI, one e2e test. Roadmap marker changes.

## Done when
- `deploy-proof` on `main` shows 0 failed requests, one attempt on the held job, a v2 claim after, across a real migration.
- With `28`'s retention half: M8 reads ✅ and `bun run scripts/roadmap.ts` passes. Without it: M8 stays open, naming the decision.
- A demo that stops updating reds `deploy-social-demo`, named by `X_DEPLOY_BUILD_MISMATCH`.
- `bun run verify` green; the 5-minute target in [`33-ops-ci.md`](33-ops-ci.md) still holds.
