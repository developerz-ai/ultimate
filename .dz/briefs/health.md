# Brief: is the project healthy?

Daily checkup, fired by `schedules: health` in `.dz/maintainer/maintainer.yml`. Ultimate is
maintained so that nobody has to watch it. This brief covers the failures no issue or PR announces.
Issue intake never admits a bot-authored issue, so the automation's own alarms reach the bot only
through here.

## Check, in order

| Signal | Command | Healthy |
|---|---|---|
| `main` is green | `gh run list --workflow ci.yml --branch main --event push --limit 1 --json status,conclusion,headSha,url,createdAt,databaseId,displayTitle`, then `git rev-parse origin/main` | `status` `completed` and `conclusion` `success` and `headSha` equal to the `git rev-parse origin/main` output; the ask's title takes `headSha`, its body the `url`, `createdAt`, `databaseId` and `displayTitle` of that one run. The other readings: a `status` that is not `completed` is no verdict yet — re-run before filing, never unhealthy; an empty result — no `ci.yml` push run on `main` — is unhealthy, row 13's `none at all` precedent; `conclusion` `success` on a `headSha` off the `origin/main` tip is not `main` is green — re-run, then file; any other `conclusion` is red |
| the last tag published | `t=$(git describe --tags --abbrev=0 --match 'v[0-9]*' origin/main)`, then `sha=$(git rev-parse "$t"^{commit})`, then `gh run list --workflow release.yml --limit 1 --json conclusion,headBranch,event,headSha,url` | that row's `headSha` is `$sha` — the PEELED COMMIT of the annotated tag, and the only field that says which tag a row ran at: `gh run list` exposes no `ref`, and `headBranch` is the nearest it has (`packages/cli/src/ci-runs.ts:10`). Match-only: a `conclusion` is assessed only on a row whose `headSha` is `$sha`, and `success` is then the only healthy outcome — the newest row at another tag, or an empty list (no run yet), is no verdict from this row, never unhealthy; a tag whose release never ran is what `tag runs ended well` (the dispatch failed) and `npm serves what the tree says` (it never published) catch. Its `event` is the `workflow_dispatch` release-tag.yml dispatches at the tag, and release.yml's first step refuses any ref but `refs/tags/v*`, so the newest row is always a tag dispatch and `--limit 1` answers for this tag once its `headSha` matches. `url` is what the ask quotes |
| the stamped version is tagged | `bun run scripts/release-due.ts --json` | `ok: true` and `data.lastTag` present, with `data.reason` not `awaiting_tag` — the row is answered only then. A refusal (`ok: false`, findings and no `data`: `cannot tell` on a shallow or tagless checkout, `refused` on a bad flag) is not answered, never satisfied — file it, with its findings. A release commit that is green but untagged an hour after its `ci.yml` run is unhealthy whatever `release-tag.yml` returned, or failed to: its run's URL goes in the ask, and the recovery is the commands the failed `cut` step prints |
| tag runs ended well | `gh run list --workflow release-tag.yml --limit 5 --json status,conclusion` | no `failure`, `cancelled` or `timed_out`; `skipped` is a non-release commit |
| npm serves what the tree says | `bun run scripts/registry-audit.ts --json` | `ok: true`, and every `data.states[]` entry reads healthy on all three fields it carries: `kind` — `ok` for every publishable workspace, never `absent`, `behind`, `unattested` or `unreachable`; `latest` — npm's default tag is that entry's own `version`, so an `ok` state whose `latest` is another version is unhealthy (`X_REGISTRY_LATEST_DRIFT`: the set is split, every tarball real and attested, and `npm install` and `bunx create-ultimate` resolve the other release); and `tagged` — the stamped version's `v<version>` is on origin, so `tagged: true` on an `ok` state means published AND tagged, while `tagged: false` on an `ok` state is unhealthy (the tarball is attested but no release tag names it, so `release-tag.yml` never ran). `tagged: undefined` is git declining to answer — not a verdict; re-run. Lags for minutes after a publish; re-run before filing |
| automation's own alarms | `gh issue list --state open --label registry-drift` | none |
| Dependabot is not stuck | `gh pr list --app dependabot --json number,createdAt,statusCheckRollup` | none older than 7 days |
| the deployed demo shipped | `gh run list --workflow deploy-social-demo.yml --limit 1 --json databaseId,event,status,conclusion,headBranch,displayTitle,url,createdAt` | `conclusion` `success` on a `workflow_run` — a green push to `main` shipped the demo. The other readings: a null `conclusion` is a run still building, not a verdict — read `status` first and re-run the row before filing; the repo's own pattern: `release.yml:163` blanks `conclusion` unless `status` is `completed`. `conclusion` `skipped` means the `ci.yml` completion was not a green push — the deploy job's `if:` (`deploy-social-demo.yml:65-69`) only lets a green push run build. Row 12 of this table already files the ask for a red push run; if row 12 is green, check for a non-push `ci.yml` run. `event` `workflow_dispatch` (`deploy-social-demo.yml:25`) is a run an operator started, not a push publish — `headBranch` names the ref it ran on, whatever its `conclusion`. Any other non-success: name the guard the run log's `::error::` line names — the not-on-main tip guard `deploy-social-demo.yml:99-115` or the app-gate-verdict guard `deploy-social-demo.yml:127-144`. A real failure files an ask whose body carries the run's `url`, `createdAt`, `databaseId`, `displayTitle` and `headBranch` (a dispatch off `main` names its branch) |

## What to file

For each unhealthy signal, one ask, unless an open issue already names it. Its title names the
signal (`main is red at <sha>`, `publish failed: <v>`, `Dependabot #<n> stuck since <date>`).
Its body holds the command, its output and the failing run's URL. A red `main` comes first:
nothing releases from it.

A `Dependabot` npm-bump ask (row 7) carries the cause and the repair in its body, re-deriving
nothing: `bun.lock` is regenerated by hand and Dependabot cannot write it (`PUBLISHING.md:97-99`) —
the PR's lock is stale by construction; a pin left behind fails `X_RELEASE_VERSION_SKEW`,
`x verify`'s package-shape step (`PUBLISHING.md:70-73`); the repair is `bun run lockfile:fix`
(`package.json:45`); and a conflicted lock is never merged over — the local regeneration lands
first.

Never re-run a publish, delete a tag or a Release, or `npm publish` from here. `PUBLISHING.md` owns
every recovery, and a fix ships as the next patch, never as a moved tag.
