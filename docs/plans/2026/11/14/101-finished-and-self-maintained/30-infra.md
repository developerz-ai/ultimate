# 30 — Infrastructure: evidence an agent can read, and the demo's deploy order

> Part of [`overview.md`](overview.md). Depends on: [`01`](01-production-hotfixes.md); I5 on [`09`](09-deploy-contract.md). **Another repository** (`../infrastructure`): edited from its own checkout, in a git worktree if that checkout is dirty or off its default branch (8 uncommitted files there on 2026-11-14, not ours). Owner-owed rows from the 2026/11/11 plan's slice 30 (I6, I7, I8, I9, I12) carry over unchanged.

## Files to change
Paths are in that repository; locate by its own README.

| # | Change | Evidence (2026-11-14) |
|---|---|---|
| I1 | each framework app's database becomes a target of the database gateway: a server entry, a read-only role with statistics read, a grant to the coding service token | the gateway's targets are one shared cluster; the demo's database is absent |
| I2 | the demo database's network policy admits the gateway's namespace | it admits its own namespace, backup, operator and metrics only |
| I3 | a job-state view (counts by job, state, error code — no payloads) granted to the stats role | `permission denied for table x_jobs`: dead jobs cannot be counted |
| I4 | a read path to the metrics store for agents (a reader service account + a policy exception) | the API proxy returns 502; no firing alerts, peaks or volume usage readable |
| I5 | the demo adopts the chart's gating migrate Job | crash-loop on every rollout |
| I6 | `idle_in_transaction_session_timeout` on the demo's database (60 s, as the shared cluster) | set to 0 |
| I7 | tracker alert rules split by severity; a retry warning does not page | every new issue pages |
| I8 | a blackbox probe for the fourth app hostname | 3 of 4 probed |
| I9 | the stats script takes an output path instead of writing into the repository; statement text off by default | a text read spills ~250 MB of temp on the shared cluster |
| I10 | a per-agent access handle for the read scripts instead of the owner's key | owner sign-off required by that repository's own rule |
| I11 | the gateway deploys a pinned release, not a moving tag | image tag is a branch name |
| I12 | the demo's captcha secret set, or the feature off | ~550 `auth.captcha.unverified` lines a week |

## Steps
1. One PR per row or per two related rows, each ≤ 100 files, through that repository's own gate.
2. Read-only stays read-only: no write grant, no payload columns in the view, the audit log on.
3. After I1–I4: run the [`12`](12-maintainer-loop.md) `evidence` brief once by hand and confirm it gets slow statements, dead-job counts and firing alerts with no owner credential.

## Tests
- That repository's checks. Then, from the agent's path only: the three reads in step 3 succeed; a write through the same token is refused.

## Done when
- The `evidence` brief runs unattended; I10 is granted or recorded as the one manual step in [`90`](90-owner-decisions.md) OD5.
