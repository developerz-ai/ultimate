# `main` is red

**Revert first when a revert is clean; fix forward otherwise; never rerun to green.** Nothing
releases from a red `main`: `release-tag.yml` tags only a release commit whose `ci.yml` concluded
`success`.

## Notice

| Signal | Command |
|---|---|
| the newest push run on `main` | `bun run x -- ci --workflow ci.yml --event push --branch main --json` |
| its failed steps' findings, with their `X_*` codes | `bun run x -- ci --run <run-id> --json` |
| the last green commit | `gh run list --workflow ci.yml --branch main --event push --status success --limit 1 --json headSha,url` |
| the tip | `git fetch origin main && git rev-parse origin/main` |

A run with `status` not `completed` has no verdict yet: wait for it, never file on it.

Before 31.31.0 the first command refused with `X_GH_RESPONSE_INVALID` while a push run on `main`
was still in progress (`gh` prints `conclusion: ""` for a run in flight). On an older CLI read the
runs with `gh run list --workflow ci.yml --branch main --event push --limit 5 --json status,conclusion,headSha,url`.

## Do

| # | Step |
|---|---|
| 1 | Name the failing step from the findings: `typecheck`, `unit`, `live`, … — the names are `VERIFY_STEP_NAMES` in `packages/cli/src/verify-step.ts` |
| 2 | Reproduce it on the tip: `bun run x -- verify --only <step> --json`. A `live` step needs the test services: `docker compose -f docker/docker-compose.test.yml up -d --wait`, then `set -a; . docker/test-services.env; set +a` |
| 3 | Green locally and red on CI twice on the same commit = an environment difference; red once and green once = a flake — both are a fix, never a rerun. Open the flake as an issue with the seed, as `flake-hunt.yml` files them |
| 4 | Find the commit: between the last green `headSha` and the tip, `git bisect start origin/main <last-green-sha>`, then `git bisect run bun run x -- verify --only <step>` |
| 5 | The culprit reverts cleanly (`git revert --no-edit <sha>` applies with no conflict and the step goes green on it): open the revert as a PR titled `revert: <subject> — main red at <sha>`, linking the run. Reopen the original PR's issue |
| 6 | It does not: fix forward, one PR, the failing test first. The PR body carries the failing run's URL and the step's output before and after |
| 7 | Green again: the next push run's `conclusion` is `success` on the new tip. Close the issue with that run's URL |

A red release commit is its own page: [`release-commit-red.md`](./release-commit-red.md).

## Never

- `gh run rerun` on a red test step to get a green tick. The one rerun this repository uses is
  PUBLISHING.md's, for a release commit whose CI died of the runner, not of a test.
- Skip, `.todo` or delete a failing test to turn the step green.
- Push to `main` directly. The ruleset `main-protection` requires the `verify` check on every
  change (`gh api repos/developerz-ai/ultimate/rulesets --jq '.[] | {id, name, enforcement}'`).
