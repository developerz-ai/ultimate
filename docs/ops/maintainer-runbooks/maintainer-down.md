# The maintainer itself is down for N days

**The bot cannot report its own absence: a person, or a check that does not run on the platform,
has to notice.** Every brief in `.dz/briefs/` runs on the platform; when the platform stops, its
checkups and reviews stop with it, and nothing they would have filed gets filed.

## Who notices, `As of 2026-11-15`

| Watcher | Notices | State |
|---|---|---|
| a scheduled workflow in this repository reading the bot's last activity, filing an issue past a threshold | the bot silent for more than 8 days — a missed week of reviews and checkups plus a day | **planned, not built.** No workflow in `.github/workflows/` reads it; the closest is `registry-audit.yml`, which files its own alarm daily whether or not anyone answers |
| a person opening the repository | open `registry-drift` issues re-fired daily with no reply; Dependabot PRs older than 7 days; PRs with no review from the bot | today's only watcher |

Until the workflow exists, this page is a person's.

## Notice

| Signal | Command | Down when |
|---|---|---|
| the bot's newest comment | `gh api 'repos/developerz-ai/ultimate/issues/comments?sort=created&direction=desc&per_page=100' --jq '[.[] \| select(.user.login == "developerz-ai[bot]")][0].created_at'` | older than 8 days, or `null` across the newest 100 comments |
| the bot's newest PR | `gh search prs --repo developerz-ai/ultimate --author app/developerz-ai --sort created --limit 1 --json number,createdAt` | context only: the bot opens PRs when work is owed, so an old date alone is not down |
| PRs it should have reviewed | `gh pr list --state open --json number,createdAt,reviews` | an open PR older than a day with no `reviews[].author.login` equal to `developerz-ai` (the bot's login as `gh pr` prints it) |
| alarms unanswered | `gh issue list --state open --label registry-drift --json number,updatedAt,url` | open for more than a week |

## Do

| # | Step |
|---|---|
| 1 | Read the platform's status for the account first. A retired model or key is [`model-or-key-retired.md`](./model-or-key-retired.md) |
| 2 | Run the health rows by hand: `bun run scripts/health.ts --json`, and file what `docs/ops/health.md` says to file |
| 3 | `main` red: [`main-red.md`](./main-red.md). A release owed: `bun run scripts/release-due.ts --json`; a person may cut it (PUBLISHING.md § Ongoing releases) |
| 4 | Open PRs: review and merge them as a member would. `require_review: true` still holds |
| 5 | When the bot is back, re-run `bun run scripts/health.ts --json` and close what it finds healthy |

## The gap

The watchdog workflow: weekly, `GITHUB_TOKEN` with `issues: write` only, reads the first command
above and opens or updates one `maintainer-down` issue past 8 days, closed by its own green run —
the shape `registry-audit.yml` already has. Owned by whoever next edits `.github/workflows/`.
