# Brief: is `main` red, and what turns it green?

Daily checkup fired by `schedules: main-red` in `.dz/maintainer/maintainer.yml`. The schema has
weekdays and hours, not workflow events, so this run polls for the event it exists for: a failed
`ci.yml` push run on `main`. **Act only when the newest completed push run on `main` is not
`success`;** otherwise stop, file nothing, and end the run summary with `main green at <sha>`.
The procedure is `docs/ops/maintainer-runbooks/main-red.md`; this brief is its schedule and its
limits.

## Check, in order

| Signal | Command | Act when |
|---|---|---|
| the newest push runs | `gh run list --workflow ci.yml --branch main --event push --limit 5 --json status,conclusion,headSha,databaseId,url,createdAt` | the newest run whose `status` is `completed` has a `conclusion` other than `success`. Runs still in flight are no verdict — never act on them |
| its failing steps | `bun run x -- ci --run <databaseId> --json` | always, for the act: `findings[]` name the steps and their `X_*` codes |
| the last green commit | `gh run list --workflow ci.yml --branch main --event push --status success --limit 1 --json headSha,url` | always, for the bisect range |
| an issue already names it | `gh issue list --state open --search 'main is red in:title' --json number,title,url` | one is open: add the run's URL to it, start nothing new |
| a fix already in flight | `gh pr list --state open --search 'main red in:title' --json number,title,url` | one is open: drive it, start nothing new |

`bun run x -- ci --workflow ci.yml --event push --branch main --json` reads the same runs, but
refuses with `X_GH_RESPONSE_INVALID` while any run is still in flight (`As of 2026-11-15`: `gh`
prints `conclusion: ""` and `packages/cli/src/ci-runs.ts:17` accepts only `null`) — hence the raw
`gh run list` above.

## Act

1. **Bisect by the failing step.** Reproduce on the tip with
   `bun run x -- verify --only <step> --json`, then between the last green `headSha` and the tip:
   `git bisect start origin/main <last-green-sha>` and `git bisect run bun run x -- verify --only <step>`.
2. **Revert first when the revert is clean** — `git revert --no-edit <sha>` applies with no
   conflict and the step is green on it. One PR, titled `revert: <subject> — main red at <sha>`,
   its body the run URL, the step, the bisect log. Reopen what the reverted PR closed.
3. **Fix forward otherwise.** One PR, the failing test first, titled `fix: main red at <sha> — <step>`.
4. **Never rerun to green.** A red test step is a defect or a flake, and a flake is a fix
   (`docs/ops/maintainer-runbooks/main-red.md` § Never). A red release commit follows
   `docs/ops/maintainer-runbooks/release-commit-red.md`.
5. A review thread on the fix that disagrees: `docs/ops/maintainer-runbooks/review-bot-disagrees.md`.

`bun run verify` green on the PR before it opens; the next push run's `success` on the new tip is
the close.

## What to file

When the revert and the fix are both out of reach in this run (the step is not reproducible
locally, or the bisect lands on a merge of two green PRs), one ask: `main is red at <sha>`, its
body the run URL, the failing step, its findings and the bisect range. Never more than one open.

## Rows

- `main-completed-run` — Read the newest completed push run on `main`; stop and file nothing when its `conclusion` is `success` or no run has completed.
- `main-open-work` — An open `main is red` issue or `main red` PR already covers the run: add the run's URL and drive it; start nothing new.
- `main-bisect` — Reproduce the failing step on the tip, then bisect it between the last green commit and the tip with `x verify --only <step>`.
- `main-revert-or-fix` — Revert the culprit when the revert is clean and green, else fix forward with a failing-first test; never rerun a red test step.
