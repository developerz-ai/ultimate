# Brief: is the project healthy?

Daily checkup fired by `schedules: health` in `.dz/maintainer/maintainer.yml`: the failures no
issue or PR announces. One ask per unhealthy signal; a no-verdict row is always re-run, never filed.

## Check, in order

| Signal | Command | Healthy |
|---|---|---|
| `main` is green | `bun run x -- ci --workflow ci.yml --event push --branch main --json`, then `git rev-parse origin/main` | `ok: true` and `data.runs` exactly one run whose `conclusion` is `success` and whose `headSha` equals the `git rev-parse origin/main` output; `ok: false` IS the red verdict — any other `conclusion` among them, `findings[]` carrying the gate's own X_* codes. Null `conclusion` (`status` not yet `completed`) and `X_CI_RUN_NOT_FOUND` = no verdict — re-run before filing, never unhealthy. `success` on a `headSha` off the `origin/main` tip is not green — re-run, then file. The ask's title takes `headSha`, its body the `url`, `createdAt`, `id` (gh's `databaseId`) and `title` (gh's `displayTitle`) |
| the last tag published | `t=$(git describe --tags --abbrev=0 --match 'v[0-9]*' origin/main)`, then `sha=$(git rev-parse "$t"^{commit})`, then `gh run list --workflow release.yml --limit 1 --json conclusion,headBranch,event,headSha,url` | the run's `headSha` is `$sha`, the PEELED COMMIT of the annotated tag. Match-only: a `conclusion` is read only off a run whose `headSha` is `$sha`, and `success` is then the only healthy outcome; the newest run at another tag, or an empty list, is no verdict — never unhealthy. The ask quotes `url` |
| the stamped version is tagged | `bun run scripts/release-due.ts --json` | healthy only on `ok: true`, `data.lastTag` present and `data.reason` not `awaiting_tag`. A refusal (`ok: false`, findings and no `data`) is not answered — file it, with its findings. Green but untagged = unhealthy: the run's URL goes in the ask, and the recovery is the commands the failed `cut` step prints |
| tag runs ended well | `gh run list --workflow release-tag.yml --limit 5 --json status,conclusion,databaseId,displayTitle,headSha,url,createdAt` | no `failure`, `cancelled`, `timed_out` or `startup_failure`; `skipped` is a non-release commit. A run whose `status` is not `completed` — including one queued on the `release-tag` concurrency group — has no completion verdict: re-run, retaining its run evidence, never filing it a failure. A failing completed run files through the filing rule: its ask quotes the run's `url`, with `databaseId`, `status`, `conclusion`, `displayTitle`, `headSha` (the commit it ran at) and `createdAt` |
| npm serves what the tree says | `bun run scripts/registry-audit.ts --json` | `ok: true` and every `data.states[]` entry healthy on all three fields: `kind` `ok` only, never `absent`, `behind`, `unattested` or `unreachable`; `latest` the entry's own `version`, else unhealthy (`X_REGISTRY_LATEST_DRIFT`: the set is split); `tagged` true — `tagged: false` is unhealthy (attested, but no release tag names it). `tagged: undefined` = no verdict — re-run. Lags minutes after a publish; re-run before filing |
| automation's own alarms | `gh issue list --state open --label registry-drift --json number,title,state,createdAt,updatedAt,url` | empty list = healthy. Non-empty files through the filing rule: the ask's body quotes this command, its `--json` output and the issue's `url`. `gh issue list` returns no comments field, so `updatedAt` is the newest comment — the alarm's last re-fire, daily at 06:17 UTC. A newest comment predating today's audit = latched (the ask names it latched); a comment from today's audit = re-firing |
| Dependabot is not stuck | `gh pr list --app dependabot --limit 5 --state open --json number,createdAt,updatedAt,statusCheckRollup` | green checks healthy regardless of age; failed checks healthy until >7 days since `updatedAt` (exactly 7 not over), unhealthy after. Completed CheckRuns with `SUCCESS`, `NEUTRAL` or `SKIPPED`, and StatusContexts with `SUCCESS`, are green; terminal failures are red. Pending, missing, malformed or unknown evidence = unverdicted, including mixed rollups; missing or invalid `updatedAt` is unverdicted, never replaced by `createdAt`. Only a SHORT page files: a returned count equal to `--limit` (5) is truncated — raise `--limit`, file nothing until the page is short. A confirmed stuck PR files even when a different PR on the page carries pending or unreadable evidence — `unverdicted` is for pages with no confirmed failure, never a mute on a confirmed one. Re-run unresolved evidence before filing. `--state open` excludes merged or closed PRs; `createdAt` is context only, never inactivity |
| the deployed demo shipped | `gh run list --workflow deploy-social-demo.yml --limit 1 --json databaseId,event,status,conclusion,headBranch,displayTitle,url,createdAt` | `conclusion` `success` on a `workflow_run` = healthy. Null `conclusion` = still building — read `status` first and re-run before filing. `skipped` = the `ci.yml` completion was not a green push (the deploy job's `if:`); row 1 already files a red main, so with row 1 green, check for a non-push `ci.yml` run. `workflow_dispatch` = an operator's run, not a push publish — `headBranch` names the ref. Any other non-success: name the guard the run log's `::error::` line names. A failure's ask body carries `url`, `createdAt`, `databaseId`, `displayTitle` and `headBranch` |
| the GitHub Release exists | `t=$(git describe --tags --abbrev=0 --match 'v[0-9]*' origin/main)`, then `gh release view "$t" --json tagName,isDraft,publishedAt` | healthy = `isDraft` false AND `publishedAt` non-null; draft = unhealthy; non-draft without `publishedAt` = unhealthy. Missing Release = unhealthy — gh prints `release not found` and no JSON document: the message is the signal, not the exit code. Any other unreadable answer = `cannot tell` for the whole checkup (`X_HEALTH_ROW_UNREADABLE`), never a silent healthy; re-run before filing |

## What to file

For each unhealthy signal, one ask, unless an open issue already names it. Its title names the
signal (`main is red at <sha>`, `publish failed: <v>`, `Dependabot #<n> failed checks, inactive since <updatedAt>`).
Its body holds the command, its output and the failing run's URL. A red `main` comes first:
nothing releases from it.

A `Dependabot` npm-bump ask (row 7's only filing — a PR with failed checks and more than 7 days
since `updatedAt`) carries the cause and the repair in its body: `bun.lock` is regenerated by hand
and Dependabot cannot write it, so the PR's lock is stale by construction; a pin left behind fails
`X_RELEASE_VERSION_SKEW`; the repair is `bun run lockfile:fix`; a conflicted lock is never merged
over — the local regeneration lands first. File only for failed checks with >7 days of inactivity
measured from `updatedAt`, never creation age alone. Re-run row 7 before filing: a page that came
back full is missing the older PRs the ask is about — raise the limit until the page is short.

Never re-run a publish, delete a tag or a Release, or `npm publish` from here. `PUBLISHING.md` owns
every recovery, and a fix ships as the next patch, never as a moved tag.

## Machine verdicts

`scripts/health.ts` reads this table and answers with one machine verdict per row. Run
`bun run scripts/health.ts --json` first. `ok: false` is a row its command could not read — the
findings name the row and the command (`X_HEALTH_ROW_UNREADABLE`, or a child script's own codes
verbatim): file that, never a verdict over an unread row. `ok: true` carries `data.rows[]`, one
`RowVerdict` per row in this table's order — branch on each row's fields:

- `unhealthy` — one ask per row, exactly as the table above prescribes; a row that reads a run
  (1, 2, 4 and 8) carries that run's `conclusion`, `status`, `headSha`, `url`, `createdAt`, `id`
  and `title` — plus `event` and `headBranch` where its command asks for them (2 and 8; row 4's
  asks for the commit it ran at instead), with the `expectedSha` it judged against on rows 1 and 2;
  `issues[]`/`prs[]` are the lists rows 6 and 7 file from.
- `unverdicted` — no verdict: re-run the row's command before filing, never unhealthy.
- `healthy` — nothing to file. `data.healthy` is true only when all nine rows read healthy.

This table stays the definition of each row's healthy condition; the script is its machine reading,
never a second definition.

## Rows

- `main-green` — row 1: `main` is green
- `last-tag-published` — row 2: the last tag published
- `stamped-version-tagged` — row 3: the stamped version is tagged
- `tag-runs-ended-well` — row 4: tag runs ended well
- `npm-serves-tree` — row 5: npm serves what the tree says
- `automation-alarms` — row 6: automation's own alarms
- `dependabot-not-stuck` — row 7: Dependabot is not stuck
- `demo-shipped` — row 8: the deployed demo shipped
- `release-exists` — row 9: the GitHub Release exists

<!-- 8460 characters; checkup cap 10000 -->
