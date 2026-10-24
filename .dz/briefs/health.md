# Brief: is the project healthy?

Daily checkup, fired by `schedules: health` in `.dz/maintainer/maintainer.yml`. Ultimate is
maintained so that nobody has to watch it. This brief covers the failures no issue or PR announces.
Issue intake never admits a bot-authored issue, so the automation's own alarms reach the bot only
through here.

`.claude/settings.json` (`permissions.allow`) is the source of truth for this allowlist. Every `gh`
command the eight rows below run is pre-approved: `gh run list`, `gh issue list`, `gh pr list`, and
rows 1–2's git reads `git rev-parse` and `git describe` beside them. Rows 3 and 5 are NOT
pre-approved — they run `bun run scripts/release-due.ts` and `bun run scripts/registry-audit.ts`,
which the allowlist's `bun run x --` entry does not match, so those two rows can prompt. The
generated-app allowlist (`packages/cli/src/templates/scaffold-claude.ts`) is a different list for a
different audience and is not this one.

## Check, in order

| Signal | Command | Healthy |
|---|---|---|
| `main` is green | `bun run x -- ci --workflow ci.yml --event push --branch main --json`, then `git rev-parse origin/main` | `ok: true` and `data.runs` exactly one run whose `conclusion` is `success` and whose `headSha` equals the `git rev-parse origin/main` output; `ok: false` IS the red verdict — any other `conclusion` among them — its `findings[]` carrying the gate's own X_* codes; null `conclusion` (`status` not yet `completed`) = run still going, no verdict yet — re-run before filing, never unhealthy; `X_CI_RUN_NOT_FOUND` = no `ci.yml` push run on `main` at all — no verdict, never unhealthy and never `main is green` — re-run before filing; `conclusion` `success` on a `headSha` off the `origin/main` tip is not `main` is green — re-run, then file. The ask's title takes `headSha`, its body the `url`, `createdAt`, `id` (gh's `databaseId`) and `title` (gh's `displayTitle`) of that one run |
| the last tag published | `t=$(git describe --tags --abbrev=0 --match 'v[0-9]*' origin/main)`, then `sha=$(git rev-parse "$t"^{commit})`, then `gh run list --workflow release.yml --limit 1 --json conclusion,headBranch,event,headSha,url` | that row's `headSha` is `$sha` — the PEELED COMMIT of the annotated tag, and the only field that says which tag a row ran at: `gh run list` exposes no `ref`, and `headBranch` is the nearest it has (`packages/cli/src/ci-runs.ts:10`). Match-only: a `conclusion` is assessed only on a row whose `headSha` is `$sha`, and `success` is then the only healthy outcome — the newest row at another tag, or an empty list (no run yet), is no verdict from this row, never unhealthy; a tag whose release never ran is what `tag runs ended well` (the dispatch failed) and `npm serves what the tree says` (it never published) catch. Its `event` is the `workflow_dispatch` release-tag.yml dispatches at the tag, and release.yml's first step refuses any ref but `refs/tags/v*`, so the newest row is always a tag dispatch and `--limit 1` answers for this tag once its `headSha` matches. `url` is what the ask quotes |
| the stamped version is tagged | `bun run scripts/release-due.ts --json` | `ok: true` and `data.lastTag` present, with `data.reason` not `awaiting_tag` — the row is answered only then. A refusal (`ok: false`, findings and no `data`: `cannot tell` on a shallow or tagless checkout, `refused` on a bad flag) is not answered, never satisfied — file it, with its findings. A release commit that is green but untagged an hour after its `ci.yml` run is unhealthy whatever `release-tag.yml` returned, or failed to: its run's URL goes in the ask, and the recovery is the commands the failed `cut` step prints |
| tag runs ended well | `gh run list --workflow release-tag.yml --limit 5 --json databaseId,status,conclusion,event,headBranch,displayTitle,url,createdAt` | no `failure`, `cancelled`, `timed_out` or `startup_failure` (the workflow file never started); `skipped` is a non-release commit. A run whose `status` is not `completed` has no completion verdict — including a run queued on concurrency group `release-tag` — so re-run it rather than filing it as a failure, while retaining its available run evidence. A failing completed row files through the filing rule (`health.md:23-26`): its ask quotes that run's `url`, with `databaseId`, `status`, `conclusion`, `event`, `headBranch`, `displayTitle` and `createdAt` alongside; the URL is included whenever available |
| npm serves what the tree says | `bun run scripts/registry-audit.ts --json` | `ok: true`, and every `data.states[]` entry reads healthy on all three fields it carries: `kind` — `ok` for every publishable workspace, never `absent`, `behind`, `unattested` or `unreachable`; `latest` — npm's default tag is that entry's own `version`, so an `ok` state whose `latest` is another version is unhealthy (`X_REGISTRY_LATEST_DRIFT`: the set is split, every tarball real and attested, and `npm install` and `bunx create-ultimate` resolve the other release); and `tagged` — the stamped version's `v<version>` is on origin, so `tagged: true` on an `ok` state means published AND tagged, while `tagged: false` on an `ok` state is unhealthy (the tarball is attested but no release tag names it, so `release-tag.yml` never ran). `tagged: undefined` is git declining to answer — not a verdict; re-run. Lags for minutes after a publish; re-run before filing |
| automation's own alarms | `gh issue list --state open --label registry-drift --json number,title,state,createdAt,updatedAt,url` | empty list is `none` — no open alarm. Every non-empty result files through the filing rule (`health.md:23-26`): the ask's body quotes this command, its `--json` output and the issue's `url`. `gh issue list` returns no comments field, so `updatedAt` carries the newest comment — the alarm's last re-fire, one comment per failing audit, daily at 06:17 UTC (`registry-audit.yml:18`, which comments on the open issue at `registry-audit.yml:68`): a newest comment predating today's audit is a latched stale alarm — the drift stopped re-firing but the issue was left open — the ask's body names it latched; a comment from today's audit is today's drift re-firing |
| Dependabot is not stuck | `gh pr list --app dependabot --limit 5 --state open --json number,createdAt,updatedAt,statusCheckRollup` — the `--limit 5` is `open-pull-requests-limit: 5`, the repo’s only bound, and it sits on the `bun` ecosystem (`.github/dependabot.yml:20`): `github-actions` (`:38`), `docker` (`:53`) and `docker-compose` (`:71`) set none, so 5 is Dependabot’s ceiling rather than a gh default, and a sixth queued PR can exist unpaged — the bound this healthy reading is stated against | green checks are healthy regardless of age; failed checks are healthy for stuck detection when `updatedAt` is at most 7 days ago, and unhealthy only after >7 days of inactivity. This >7-day inactivity threshold is separate from the four 14-day release cooldowns (`.github/dependabot.yml:18-19`, `:43-44`, `:58-59`, `:76-77`) and weekly Monday schedules (`:11-15`, `:40-42`, `:55-57`, `:73-75`). Completed CheckRuns with `SUCCESS`, `NEUTRAL` or `SKIPPED`, and StatusContexts with `SUCCESS`, are green; terminal failures are red. Pending, missing, malformed or unknown check evidence is unverdicted, including mixed rollups; missing or invalid `updatedAt` is unverdicted, never replaced by `createdAt`. Only a SHORT page can establish a filing verdict: a returned count equal to `--limit` (5) means the page was truncated, and the PRs just cut are the old ones this row exists to find, so a full page is an incomplete answer, never a clean verdict — re-run with a raised `--limit` and file nothing until the page is short: a short page is complete, but only a PR with failed checks and >7 days since `updatedAt` files its stuck-PR ask; exactly 7 days is not over threshold. A PR that meets that bar files even when a DIFFERENT PR on the page carries pending or unreadable evidence — `unverdicted` is for pages with no confirmed failure, never a mute on a confirmed one (a mixed rollup is still one PR's own unknown, and files nothing). Re-run unresolved evidence before filing. `--state open` excludes merged or closed PRs; `createdAt` is context only, never inactivity |
| the deployed demo shipped | `gh run list --workflow deploy-social-demo.yml --limit 1 --json databaseId,event,status,conclusion,headBranch,displayTitle,url,createdAt` | `conclusion` `success` on a `workflow_run` — a green push to `main` shipped the demo. The other readings: a null `conclusion` is a run still building, not a verdict — read `status` first and re-run the row before filing; the repo's own pattern: `release.yml:163` blanks `conclusion` unless `status` is `completed`. `conclusion` `skipped` means the `ci.yml` completion was not a green push — the deploy job's `if:` (`deploy-social-demo.yml:65-69`) only lets a green push run build. Row 12 of this table already files the ask for a red push run; if row 12 is green, check for a non-push `ci.yml` run. `event` `workflow_dispatch` (`deploy-social-demo.yml:25`) is a run an operator started, not a push publish — `headBranch` names the ref it ran on, whatever its `conclusion`. Any other non-success: name the guard the run log's `::error::` line names — the not-on-main tip guard `deploy-social-demo.yml:99-115` or the app-gate-verdict guard `deploy-social-demo.yml:127-144`. A real failure files an ask whose body carries the run's `url`, `createdAt`, `databaseId`, `displayTitle` and `headBranch` (a dispatch off `main` names its branch) |

## What to file

For each unhealthy signal, one ask, unless an open issue already names it. Its title names the
signal (`main is red at <sha>`, `publish failed: <v>`, `Dependabot #<n> failed checks, inactive since <updatedAt>`).
Its body holds the command, its output and the failing run's URL. A red `main` comes first:
nothing releases from it.

A `Dependabot` npm-bump ask (row 7's only filing — a PR with failed checks and more than 7 days since `updatedAt`) carries the cause and the repair in its body, re-deriving
nothing: `bun.lock` is regenerated by hand and Dependabot cannot write it (`PUBLISHING.md:97-99`) —
the PR's lock is stale by construction; a pin left behind fails `X_RELEASE_VERSION_SKEW`,
`x verify`'s package-shape step (`PUBLISHING.md:70-73`); the repair is `bun run lockfile:fix`
(`package.json:45`); and a conflicted lock is never merged over — the local regeneration lands
first. File only for failed checks with >7 days of inactivity measured from `updatedAt`, never creation age alone. Re-run row 7 before filing any of these: its `--limit 5` page (`health.md:26`) is one page, and a page that came back full is missing the older PRs the ask is about — raise the limit until the page is short, or the ask is filed on an answer nobody read.

Never re-run a publish, delete a tag or a Release, or `npm publish` from here. `PUBLISHING.md` owns
every recovery, and a fix ships as the next patch, never as a moved tag.

## Machine verdicts

`scripts/health.ts` reads this table and answers with one machine verdict per row. Run
`bun run scripts/health.ts --json` first. `ok: false` is a row its command could not read — the
findings name the row and the command (`X_HEALTH_ROW_UNREADABLE`, or a child script's own codes
verbatim): file that, never a verdict over an unread row. `ok: true` carries `data.rows[]`, one
`RowVerdict` per row in this table's order — branch on each row's fields:

- `unhealthy` — one ask per row, exactly as the table above prescribes; a row that reads a run (1,
  2, 4 and 8) carries that run's `conclusion`, `status`, `headSha`, `event`, `url`, `createdAt`,
  `id`, `title` and `headBranch` — the fields the ask's body quotes, with the `expectedSha` it
  judged against on rows 1 and 2; `issues[]`/`prs[]` the lists rows 6 and 7 file from.
- `unverdicted` — no verdict: re-run the row's command before filing, never unhealthy.
- `healthy` — nothing to file. `data.healthy` is true only when all eight rows read healthy.

This table stays the definition of each row's healthy condition; the script is its machine reading,
never a second definition.
