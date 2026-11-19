# Brief: is the project healthy?

Weekly: the failures no issue or PR announces. No verdict is always re-run, never filed: a null `conclusion` (`status` not
`completed`) is one on every run row. Runbooks: `docs/ops/maintainer-runbooks/`.

## Check, in order

| Signal | Command | Healthy |
|---|---|---|
| `main-green` | `bun run x -- ci --workflow ci.yml --event push --branch main --json`, then `git rev-parse origin/main` | `ok: true`, `data.runs` exactly one run, `conclusion` `success`, `headSha` = the `origin/main` output. `ok: false` IS red: another `conclusion` among them, `findings[]` the gate's own X_* codes. `X_CI_RUN_NOT_FOUND` = no verdict. `success` off the tip is not green: re-run, then file. Title: `headSha`; body: `url`, `createdAt`, `id` (gh's `databaseId`), `title` (gh's `displayTitle`). Runbook `main-red.md` |
| `last-tag-published` | `t=$(git describe --tags --abbrev=0 --match 'v[0-9]*' origin/main)`, then `sha=$(git rev-parse "$t"^{commit})`, then `gh run list --workflow release.yml --limit 1 --json conclusion,headBranch,event,headSha,url` | match-only: a `conclusion` is read only off a run whose `headSha` is `$sha`, the annotated tag's PEELED COMMIT; there `success` alone is healthy. A run at another tag, or none = no verdict. The ask quotes `url` |
| `stamped-version-tagged` | `bun run scripts/release-due.ts --json` | `ok: true`, `data.lastTag` set, `data.reason` not `awaiting_tag`. A refusal (`ok: false`, findings, no `data`): file it with its findings. Green but untagged = unhealthy: the ask carries the run's URL; recovery = the commands the failed `cut` step prints. Runbook `release-commit-red.md` |
| `tag-runs-ended-well` | `gh run list --workflow release-tag.yml --limit 5 --json status,conclusion,databaseId,displayTitle,headSha,url,createdAt` | no `failure`, `cancelled`, `timed_out`, `startup_failure`; `skipped` = a non-release commit. Not `completed` = no verdict: re-run keeping its evidence, never a failure. A failed completed run's ask quotes `url`, `databaseId`, `status`, `conclusion`, `displayTitle`, `headSha` (the commit it ran at), `createdAt` |
| `npm-serves-tree` | `bun run scripts/registry-audit.ts --json` | `ok: true`; every `data.states[]` entry: `kind` `ok` (never `absent`, `behind`, `unattested`, `unreachable`); `latest` its own `version`, else unhealthy (`X_REGISTRY_LATEST_DRIFT`); `tagged: false` unhealthy (attested, no release tag names it), `undefined` = no verdict. Lags minutes after a publish: re-run first. Runbook `registry-lags.md` |
| `automation-alarms` | `gh issue list --state open --label registry-drift --json number,title,state,createdAt,updatedAt,url` | empty. Else the ask quotes this command, its `--json` output and the issue's `url`. `updatedAt` older than today = latched (the ask says so); today's = re-firing |
| `dependabot-not-stuck` | `gh pr list --app dependabot --limit 5 --state open --json number,createdAt,updatedAt,statusCheckRollup` | green checks at any age; failed checks until >7 days since `updatedAt` (7 exactly is not over). Green: completed CheckRuns `SUCCESS`, `NEUTRAL`, `SKIPPED`, StatusContexts `SUCCESS`; terminal failures red. Pending, missing, malformed, unknown, mixed evidence = no verdict; so is a missing or invalid `updatedAt`, never replaced by `createdAt`. A page of `--limit` (5) is truncated: raise it, file nothing until short. A confirmed stuck PR files even beside a PR with unread evidence. |
| `demo-shipped` | `gh run list --workflow deploy-social-demo.yml --limit 1 --json databaseId,event,status,conclusion,headBranch,displayTitle,url,createdAt` | `success` on a `workflow_run`. Null `conclusion` = still building: read `status`. `skipped` = the `ci.yml` completion was no green push: red `main-green` files it; with it green, look for a non-push `ci.yml` run. `workflow_dispatch` = an operator's run, not a push publish; `headBranch` names the ref. Other non-success: name the guard its log's `::error::` line names. The ask carries `url`, `createdAt`, `databaseId`, `displayTitle`, `headBranch` |
| `release-exists` | `t=$(git describe --tags --abbrev=0 --match 'v[0-9]*' origin/main)`, then `gh release view "$t" --json tagName,isDraft,publishedAt` | `isDraft` false AND `publishedAt` set; a draft is unhealthy. Missing = unhealthy: gh prints `release not found` and no JSON — the message is the signal, not the exit code. Any other unreadable answer = `cannot tell` (`X_HEALTH_ROW_UNREADABLE`) |
| `tutorials-run` | `gh run list --workflow tutorial-run.yml --branch main --limit 20 --json databaseId,event,status,conclusion,headBranch,displayTitle,url,createdAt` | newest non-`pull_request` run: as `bench`. Else diverged: the ask names `url` and `bun run scripts/tutorial-run.ts --json` |
| `flake-hunt` | `gh run list --workflow flake-hunt.yml --limit 1 --json databaseId,event,status,conclusion,headBranch,headSha,displayTitle,url,createdAt` | `success` under 48 h; older = unhealthy, the schedule stopped. No run or `cancelled` = re-run. Else red: open `flake-hunt` issues name test, seed, rerun |
| `bench` | `gh run list --workflow bench.yml --limit 1 --json databaseId,event,status,conclusion,headBranch,headSha,displayTitle,url,createdAt` | `success` under 8 days; older = the weekly schedule stopped. No run or `cancelled` = re-run. Else a figure failed to measure |
| `compat` | `gh run list --workflow compat.yml --limit 1 --json databaseId,event,status,conclusion,headBranch,headSha,displayTitle,url,createdAt` | as `bench`. Else open `compat` issues name each red cell and its replay |
| `next-sync` | `gh run list --workflow next-sync.yml --limit 1 --json databaseId,event,status,conclusion,headBranch,headSha,displayTitle,url,createdAt` | as `bench`. Else `main` is not in `next`: the open issue names the merge |
| `maint-lane` | `gh api repos/{owner}/{repo}/git/matching-refs/heads/release/ --jq .[].ref`, then `npm view @ultimat3/core dist-tags --json` | each window SECURITY.md promises: open, `release/<N>.x` on origin and `maint-<N>` a `<N>.x` version (`X_MAINT_LANE_ABSENT`); closed, no branch (`X_MAINT_LANE_EXPIRED`). `findings[]` carry each fix |
| `registry-trust` | `NPM_CONFIG_OTP=<code> bun run scripts/trust-publishers.ts --check --json` | `ok: true`. No `NPM_CONFIG_OTP` = no verdict, never filed: a person with npm 2FA runs it. `X_TRUST_PUBLISHER_MISSING` = unhealthy (an expired OTP reads the same: re-run first); other codes pass through |
| `private-names-secret` | `gh secret list --json name,updatedAt` | lists `ULTIMATE_PRIVATE_NAMES`; absent reds every push to `main` (`X_PRIVATE_NAMES_UNSET`) |
| `docs-site-origin` | `gh variable list --json name,value`, then `gh api repos/{owner}/{repo}/pages` | `DOCS_SITE_ORIGIN` set; Pages on, `cname` its host, certificate `approved` and unexpired, `https_enforced` |
| `stale-bot-issues` | `gh issue list --state open --search author:app/github-actions --limit 100 --json number,title,labels,updatedAt,url`, then `gh run list --workflow registry-audit.yml --status success --limit 1 --json createdAt,url`, then `gh run list --workflow actions-cache.yml --status success --limit 1 --json createdAt,url`, then `gh run list --workflow compat.yml --status success --limit 1 --json createdAt,url` | no open bot issue whose label's closer (`BOT_ALARMS`) ran green after its `updatedAt`. A person closes `flake-hunt` ones. Another label, or a full page = no verdict |
| `stale-branches` | `gh api graphql -F query=@scripts/lib/health-branches.graphql` | no `dz/*` branch whose newest PR merged or closed, or with none and a tip >7 days old. `totalCount` past the page = no verdict. The ask lists `branches[]` |

## What to file

One ask per unhealthy row unless an open issue names it, titled by the signal (`main is red at <sha>`,
`publish failed: <v>`, `Dependabot #<n> failed checks, inactive since <updatedAt>`), its body the
command, its output and the failing run's URL. A red `main` first.

A `Dependabot` npm-bump ask's repair: `bun run lockfile:fix`; a conflicted lock is regenerated
locally, never merged over.

Never re-run a publish, delete a tag, a Release or a branch, or `npm publish` from here.
`PUBLISHING.md` owns every recovery; a fix ships as the next patch, never a moved tag.

## Machine verdicts

Run `bun run scripts/health.ts --json` first. `ok: false` = an unread row (`X_HEALTH_ROW_UNREADABLE` or a
child's codes, naming row and command): file that, never a verdict over it. `ok: true` carries `data.rows[]`, one `RowVerdict` per row in
table order:

- `unhealthy` — one ask, as the table says. A run row carries its command's fields (`id` = `databaseId`, `title` =
  `displayTitle`; `expectedSha` on the first two); `issues[]`, `prs[]`, `branches[]` are lists to file from; paste `fix`, the repair, in the ask.
- `unverdicted` — re-run before filing, never unhealthy; its `fix` is a person's command (an OTP;
  an admin token on `HTTP 403`).
- `healthy` — nothing to file.

## Finished

Then `bun run finished --check --json`: one ask per `red` row, its
`fix` the repair; `unverdicted` is re-run, never filed.

## Rows

- `main-green`
- `last-tag-published`
- `stamped-version-tagged`
- `tag-runs-ended-well`
- `npm-serves-tree`
- `automation-alarms`
- `dependabot-not-stuck`
- `demo-shipped`
- `release-exists`
- `tutorials-run`
- `flake-hunt`
- `bench`
- `compat`
- `next-sync`
- `maint-lane`
- `registry-trust`
- `private-names-secret`
- `docs-site-origin`
- `stale-bot-issues`
- `stale-branches`
- `finished`

<!-- cap: scripts/lib/brief-cap.test.ts -->
