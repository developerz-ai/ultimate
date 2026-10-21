# Brief: is the project healthy?

Daily checkup, fired by `schedules: health` in `.dz/maintainer/maintainer.yml`. Ultimate is
maintained so that nobody has to watch it. This brief covers the failures no issue or PR announces.
Issue intake never admits a bot-authored issue, so the automation's own alarms reach the bot only
through here.

## Check, in order

| Signal | Command | Healthy |
|---|---|---|
| `main` is green | `gh run list --workflow ci.yml --branch main --event push --limit 1 --json conclusion,headSha` | `success` |
| the last tag published | `t=$(git describe --tags --abbrev=0 --match 'v[0-9]*' origin/main)`, then `gh run list --workflow release.yml --branch "$t" --json conclusion` | a `success` run for exactly that tag — none at all, or only a red one, is unhealthy |
| the stamped version is tagged | `bun run scripts/release-due.ts --json` | `ok: true` and `data.lastTag` present, with `data.reason` not `awaiting_tag` — the row is answered only then. A refusal (`ok: false`, findings and no `data`: `cannot tell` on a shallow or tagless checkout, `refused` on a bad flag) is not answered, never satisfied — file it, with its findings. A release commit that is green but untagged an hour after its `ci.yml` run is unhealthy whatever `release-tag.yml` returned, or failed to: its run's URL goes in the ask, and the recovery is the commands the failed `cut` step prints |
| tag runs ended well | `gh run list --workflow release-tag.yml --limit 5 --json status,conclusion` | no `failure`, `cancelled` or `timed_out`; `skipped` is a non-release commit |
| npm serves what the tree says | `bun run scripts/registry-audit.ts --json` | `ok: true` (lags for minutes after a publish; re-run before filing) |
| automation's own alarms | `gh issue list --state open --label registry-drift` | none |
| Dependabot is not stuck | `gh pr list --app dependabot --json number,createdAt,statusCheckRollup` | none older than 7 days |
| the deployed demo shipped | `gh run list --workflow deploy-social-demo.yml --limit 1 --json conclusion` | `success` |

## What to file

For each unhealthy signal, one ask, unless an open issue already names it. Its title names the
signal (`main is red at <sha>`, `publish failed: <v>`, `Dependabot #<n> stuck since <date>`).
Its body holds the command, its output and the failing run's URL. A red `main` comes first:
nothing releases from it.

Never re-run a publish, delete a tag or a Release, or `npm publish` from here. `PUBLISHING.md` owns
every recovery, and a fix ships as the next patch, never as a moved tag.
