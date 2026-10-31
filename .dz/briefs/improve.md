# Brief: monthly improvement

Fired every Monday by `schedules: improve` in `.dz/maintainer/maintainer.yml` — the schema has
weekdays, not days of the month. **Act only on the first Monday of the month:**
`[ "$(date -u +%-d)" -le 7 ]`. On any other Monday stop here, file nothing, open nothing.

Ultimate is feature-complete and maintained by agents only. Once a month, leave it measurably
better and one step ahead of the next Bun release. The other checkups already cover the alarms:
a red `main`, a missing publish, a stuck Dependabot PR are `health`'s; a release owed is
`release-due`'s. This one looks for what nothing announces because nothing is broken yet.

Read `CLAUDE.md` and `AGENTS.md` first. The design axioms, the tier table, the non-negotiables
(no `any`, no bare `Error`, no raw colours, no float money, one file one job) and "one way to do
each thing" bind every change made here exactly as they bind any other PR.

## 1. Read the signals first

| Signal | Command | Worth acting on |
|---|---|---|
| the gate on fresh `main` | `bun run verify` | anything red or slow: a step near its deadline (`packages/cli/src/verify-deadline.ts`), a test that only passed on retry |
| Bun | `npm view bun version` against `.bun-version` | a newer series. Dependabot ignores `bun` (`.github/dependabot.yml`), so nothing else ever bumps it; every pin site moves together (`scripts/bun-pin.test.ts`) |
| dependency majors | `bun outdated` | a major Dependabot's grouped minor/patch PRs never cover, or a Dependabot major closed red |
| coverage, per unit | `bun run coverage` | a package close to its bar, or a bar that could be raised with tests that fail on a real regression |
| open bugs | `gh issue list --state open --label bug --json number,title,labels,updatedAt,url` | a reproduced bug nobody has picked up |
| the tracked apps' ratchet | `bun run scripts/reference-app-gate.ts` | a step pinned in `expectedRed` (`scripts/lib/gated-apps.ts`) that could now pass: `--unpin <app>:<step>` |
| docs drift | `grep -rn 'As of 20' wiki docs README.md CLAUDE.md AGENTS.md` | a dated claim older than three months that a command now contradicts; a wiki page that says it documents an older major |

A signal whose command cannot be read is not "nothing to do": re-run it, and if it still cannot
be read, that is the first improvement.

## 2. Pick at most three improvements, in this order

1. **Anything the gate or the signals found broken or flaky.** Root cause, not a retry or a skip.
2. **Bun and dependency majors.** One series or one major per PR; the full `bun run verify` is the
   verdict, and `bun run lockfile` must be clean after.
3. **Correctness.** Open `bug` issues first, then an error path that can still end in a bare
   `Error`, a swallowed rejection or a silent skip: every failure carries a stable `X_*` code, a
   cause and an executable `fix:` (`bun run new-error-code`).
4. **Speed and bytes, measured.** A route or island budget, a hot path in `packages/render`,
   `packages/realtime` or `packages/entity`. Counts only with before/after numbers from the same
   box; never cut or stub a feature to hold a budget (axiom 9, `bun run budget-raises`).
5. **Docs drift.** `wiki/`, `README.md`, `CLAUDE.md`, `llms.txt`: every claim still matches the
   code, as a command rather than a number (`README.md`, "Every number here has a command
   beside it"). Run the snippet before keeping it.
6. **Simplification.** Dead code, a second way to do something, a file past ~200 LOC, a slow or
   flaky test. Never a sweeping refactor.

Fewer is fine. Three small merged PRs beat one large one nobody can review.

## 3. Ship

One pull request per improvement, small and reviewable, titled with what it changes. The body
carries the evidence:

| Kind | Evidence |
|---|---|
| a fix | the failing test or the failing log before, green after |
| speed or bytes | a before/after table: command, box, numbers |
| a dependency or Bun bump | the release notes read, `bun run verify` green |
| docs | the command that contradicted the old claim, and its output |

`bun run verify` green before the PR opens. A user-visible change gets a line under
`## [Unreleased]` in `CHANGELOG.md`.

**Never bump the version here** — `release-due` decides that, and merging its bump is the release.
**Never ship a breaking change from this checkup**: an improvement nobody asked for is not worth a
migration for every app. Open an issue for the owner instead, titled `Breaking improvement
proposed: <what>`, with the evidence and the `wiki/Upgrading.md` entry it would need, and move on.
Never touch release or publish automation (`.github/workflows/release*.yml`, `scripts/release*`,
`PUBLISHING.md`) from here; a problem there is an issue, not a drive-by.

**If nothing is worth changing this month, do nothing.** No empty PRs, no churn, no reformatting,
no renames, no comment-only diffs to show activity.

## Rows

- `first-monday` — Stop unless the UTC day of the month is 1-7.
- `signals` — Run every signal command on fresh `main`; an unreadable one is the first improvement.
- `pick` — At most three improvements, in the priority order above.
- `ship` — One small PR each, with its evidence and a green `bun run verify`; no version bump, no breaking change, no churn.
