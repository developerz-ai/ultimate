# Brief: does an app on the previous release upgrade to this one cleanly?

Weekly checkup (Wednesday) fired by `schedules: adopter-canary` in `.dz/maintainer/maintainer.yml`.
**Act only on Releases published in the last 7 days** — the schema has no release event, so this
run polls for them. A week can hold two (Monday's and an off-cycle security one): run the steps
below once per such Release, oldest first, `$t` its tag. A red canary blocks nothing: the release is
out. It files an issue before an adopter meets the failure.

```bash
git fetch --tags origin
gh release list --limit 10 --exclude-drafts --json tagName,publishedAt
```

Stop, file nothing, when no Release in that list has `publishedAt` within the last 7 days. A missing
Release, or a stamped version with no tag, is not this brief's: `scripts/health.ts` reports it (docs/ops/health.md),
and `docs/ops/maintainer-runbooks/release-commit-red.md` is the repair.

## 1. npm serves it

`bun run scripts/registry-audit.ts --tarballs --json` must be `ok: true` before anything installs.
Not yet: re-read it once an hour, up to six times; still not, follow
`docs/ops/maintainer-runbooks/registry-lags.md`, and stop. A tag the audit or the Release says was
not made by `release-tag.yml`: `docs/ops/maintainer-runbooks/tag-squatted.md`.

## 2. A scaffold at the previous minor, upgraded from npm

`<new>` is `$t` without its `v`. `<prev>` is the newest release of the previous minor:
`npm view @ultimat3/cli versions --json`, the highest `<major>.<minor - 1>.x` (for a `.0` minor of
a new major, the previous major's newest).

In an empty temporary directory, with no workspace on the path:

| # | Step | Red when |
|---|---|---|
| 1 | `bunx create-ultimate@<prev> canary`, then `cd canary && bun run setup` | the old scaffold no longer sets up: the registry changed under it — file it |
| 2 | `bunx @ultimat3/cli@<new> upgrade --dry-run --json` | `ok: false`; the codemods it lists are what step 3 will write |
| 3 | `bunx @ultimat3/cli@<new> upgrade --json` | `data.done` is not `true`: the hop's own gate (`x verify`) refused |
| 4 | `git status --porcelain` after step 3 | anything the hop left for a human — a file the codemods skipped and reported with its diff |

`x upgrade` refuses a dirty tree (`X_UPGRADE_DIRTY_TREE`), and `x new` commits the scaffold by
default, so step 1's tree is clean. Never `--no-git` here.

## 3. The tracked apps

`examples/dummy`, `dummy/social-media-clone` and `dummy/docs-site` move in lockstep inside this
repository, linked as workspaces — not installed from npm, so `x upgrade` has nothing to hop in
them. Their check is the gate at the release commit: `bun run scripts/reference-app-gate.ts` on a
checkout of `$t`. Red there with `ci.yml` green on the same commit is a reproducibility defect —
file it.

`bun run scripts/upgrade-fixtures.ts --verify --json` hops the older scaffolds
(`FIXTURE_VERSIONS`) to this tree; its workflow, `upgrade-fixtures.yml`, runs it weekly. Read its
newest run (`gh run list --workflow upgrade-fixtures.yml --limit 1 --json conclusion,headSha,url`)
rather than re-running it here.

## What to file

One issue per red step, unless an open one names the same `<prev>` → `<new>` hop:
`gh issue list --state open --search 'canary: in:title' --json number,title,url`. Title:
`canary: <prev> → <new> — <step>`. Body: the command, its `--json` output, the `git diff --stat`
the hop left, and the `x upgrade` section it named. Never a fix PR from this brief: the next sweep
or the platform's red-base ask and the `audit` checkup fix it.

All green: end the run summary with `canary <new>: <prev> upgraded clean, tracked apps green`.

## Rows

- `fresh-release` — Stop unless a Release was published in the last 7 days; canary each one, oldest first.
- `registry-serves` — Install nothing until `registry-audit --tarballs` is `ok`; else the registry-lags runbook.
- `scaffold-upgrade` — Scaffold `<prev>` from npm, set it up, upgrade it with `@ultimat3/cli@<new>`; red on a refusal, a red hop gate or a file left to a human.
- `tracked-apps` — Gate the three tracked apps at the release commit; red only when `ci.yml` was green on it.
- `file` — One issue per red step, deduped by hop; never a fix PR from here.
