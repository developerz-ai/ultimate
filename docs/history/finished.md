# Finished

**Finished means the list of intended work is empty — not that every idea was built.** An idea
nobody intends to build is a decision, written down with the extension point an app builds on
instead ([Known gaps](../../wiki/Known-Gaps.md#open-by-decision), "not planned"). Plan 101b slice 13
([`13-shapes-and-declaration.md`](../plans/2026/11/14/101-finished-and-self-maintained/13-shapes-and-declaration.md))
defined it, `As of 2026-11-16`.

Finished is a command, never a sentence:

```bash
bun run finished --check --json
```

`bun run finished` is `scripts/finished.ts`. Exit 0 under `--check` only when every row is green. A
row whose source could not be read — no `gh`, a logged-out one, an `npm` with no answer — is
`unverdicted` (`X_FINISHED_UNVERDICTED`) and fails `--check` exactly as `red` does: a green read
over nothing is the claim this table exists to refuse. It is **not** an `x verify` step: half its
rows read GitHub, and the gate runs sealed. The weekly `health` brief runs it
([`.dz/briefs/health.md`](../../.dz/briefs/health.md)).

## The table

Each row is a read of the repository or of GitHub; each red one is an `X_FINISHED_*` finding whose
`fix:` opens with what to run or the line to edit.

| Row | Fact | Read by | Red is |
|---|---|---|---|
| `no-stub` | no shipped stub | every `new NotImplementedError(` / `notImplemented(` in `packages/*/src`, minus tests, fixtures, `packages/core/src/errors.ts` and any file a `wiki/Known-Gaps.md` table row names | `X_FINISHED_STUB` |
| `no-planned-command` | no planned command | `PLANNED_COMMANDS` and `PLANNED_SUBCOMMANDS` (`packages/cli/src/cmd-planned.ts`) both empty | `X_FINISHED_PLANNED_COMMAND` |
| `every-shape-gates` | every shape gates | each `NEW_SHAPES` entry's `scaffold-smoke (<shape>app)` job `success` on the newest of the last 10 completed `ci.yml` pushes to `main` that ran it: `gh run list --workflow ci.yml --branch main --event push --status completed --limit 10 --json databaseId,headSha,url`, then `gh run view <id> --json jobs` | `X_FINISHED_SHAPE_UNGATED` |
| `gate-whole` | the gate is whole | `GATED_APPS` (`scripts/lib/gated-apps.ts`): every `expectedRed` empty; each app's `x.verify.json` `strict: true` and asserting every `VERIFY_STEP_NAMES` step but `roadmap`, which reads this repository's own roadmap | `X_FINISHED_GATE_PARTIAL` |
| `no-exemption-debt` | no exemption debt | every `*_PINS`, `*_UNPINNED`, `*BACKLOG` export of `scripts/lib/*-pins.ts` and of `SCRIPT_PIN_TABLES` (`scripts/lib/pin-tables.ts`): empty, or each row reasoned — a string, a `why`/`reason` field, or a `// why:` comment above its key | `X_FINISHED_PIN_UNREASONED` |
| `tests-deterministic` | tests are deterministic | `gh run list --workflow flake-hunt.yml --branch main --event schedule --status completed --limit 7 --json conclusion,createdAt,url`: seven runs, all `success`, the newest inside 48 h | `X_FINISHED_FLAKY` |
| `range-tested` | the supported range is tested | the `compat` health row's read and judge (`scripts/lib/health-compat.ts`): the newest `compat.yml` run `success` inside eight days | `X_FINISHED_COMPAT_RED` |
| `lanes-exist` | the lanes exist | `gh api repos/{owner}/{repo}/git/matching-refs/heads/next`, the same for `release/<prev>.x`, and `npm view @ultimat3/core dist-tags --json` naming `maint-<prev>` on a `<prev>.x` version; `<prev>` is one below the stamped major | `X_FINISHED_LANE_ABSENT` |
| `one-ledger` | one ledger | at most one `docs/plans/**/status.yml` reading `in_progress`; every `wiki/Known-Gaps.md` table row under `## Open by decision` or `## Closed`, or with a Decision cell of `deferred` or `rejected` | `X_FINISHED_LEDGER_OPEN` |
| `loop-closed` | the loop is closed | the newest merged `chore: release` PR, and the PR that turned the newest red `ci.yml` push to `main` green, both opened by `app/developerz-ai` | `X_FINISHED_LOOP_OPEN` |

Two readings are decisions, flagged so a later plan can overturn them in one constant each:
`FRAMEWORK_ONLY_STEPS` (`scripts/finished-gate.ts`) holds `roadmap` alone, so a tracked app's skip
of any other step — `dummy/docs-site`'s `job` included — is red; and `DECIDED_HEADINGS` /
`DECISIONS` (`scripts/finished-ledger.ts`) count `## Open`, `## Not built yet` and
`## Deferred by plan 101` rows as owed work.

## Maintenance mode

Once `bun run finished --check` is green on `main`, Ultimate is in maintenance mode. The date it
entered is stated in `README.md` and `wiki/Stability.md`, nowhere else.

| | |
|---|---|
| **Still changes** | fixes for reported defects; security fixes, off-cycle when a first-tier source confirms one; runtime upgrades (Bun, Postgres, Solid — `compat.yml` reads the range weekly); dependency bumps; one major per 90-day window at most (`X_RELEASE_MAJOR_WINDOW`), a break waiting on `next` (`X_BREAKING_ON_MAIN`) |
| **Does not change** | the eight primitives (`PRIMITIVE_KINDS`, pinned at eight); no new package and no new capability without an outside report behind it — an issue from someone running an app, not an idea from inside the repository; a request that fits no primitive is declined by `.dz/maintainer/maintainer.yml`'s `non_goals` |
| **Who acts** | the maintainer (`.dz/maintainer/maintainer.yml`, `app/developerz-ai`): triages issues, repairs a red `main` ([`main-red.md`](../ops/maintainer-runbooks/main-red.md)), judges weekly whether a release is due and opens the bump PR that cuts it ([`.dz/briefs/release-due.md`](../../.dz/briefs/release-due.md)), runs the weekly checkup ([`.dz/briefs/health.md`](../../.dz/briefs/health.md)). No person is on the path; the platform's hardcoded asks — security, license, CLA — are the only ones that reach a human |

A finished row that goes red again is an ask the `health` checkup files, and the row's own finding
is the repair. Finished is re-read every week, never declared once.
