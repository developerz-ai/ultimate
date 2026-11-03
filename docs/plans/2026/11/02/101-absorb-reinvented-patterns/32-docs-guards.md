# 32 — Docs: a guard per class of drift that survived the existing ones

> Part of [`overview.md`](overview.md). Depends on: [`32-docs-false-claims.md`](32-docs-false-claims.md) (each guard lands at zero or a pinned baseline). Tier: `scripts/` only, plus `packages/cli` (5) for a run-time reader.

## Why
`docs/architecture/guards.md` already holds commands, flags, config keys, paths in backticks, anchors, fixes, counts and self-links: sampled against code, 269 of 269 registry flags are in `wiki/CLI-Reference.md`, 442 self-links 0 dead, 22 prose signatures 0 wrong. The classes that drift are the ones no guard reads: a known-gap row with nothing tying it to the code; a stamp saying "unreleased" after the release; a tutorial nobody runs.

## Files to change
- `scripts/known-gaps-pins.ts` (new) + `.test.ts` — rule 1.
- `scripts/doc-unreleased.ts` (new) + `.test.ts`; `scripts/release.ts` — rule 2.
- `scripts/tutorial-run.ts` (new) + `.test.ts`; `.github/workflows/tutorial-run.yml` (new) — rule 3.
- `scripts/generator-counts.ts:32` — rule 4.
- `scripts/doc-paths.ts` — rule 5.
- `docs/architecture/guards.md` (`bun run scripts/guards-doc.ts --write`), `packages/cli/src/verify-checks.ts` only if a rule needs a step host; prefer sibling `.test.ts` in `unit`.

## Steps
Private names are not here: [`37-scrub-adopter-names.md`](37-scrub-adopter-names.md) owns that guard and `X_PRIVATE_NAME`.

1. **A gap is a pinned test.** Every *Open* row in `wiki/Known-Gaps.md` links a test that asserts today's behaviour, `[pin](https://…/blob/main/<file>.test.ts#<name>)`. Closing the gap fails the pin, which sends the author to the row. Guard: every Open row has a pin, the file exists, the named test exists. Baseline ratchet for rows with none yet, falling only. *Open by decision* rows need none. A row that cannot be tested (one unreproduced sighting) says `pin: none` and why.
2. **Unreleased means unreleased.** Refuse, when `[Unreleased]` is empty or at a release commit: `As of Unreleased`, a Known-Gaps `` `main` `` cell, "next major", "not yet tagged". `release.ts --bump` rewrites `` `main` `` cells to the version, the same step that promotes the changelog section (its own derived-file list).
3. **A tutorial is a script, and it costs `ci` nothing.** `tutorial-run`: on a scaffold, run each ```` ```bash ```` fence of tutorials 1–4 in order, skipping fences marked `<!-- no-run: why -->` (long-lived servers, Docker). After each, compare the `✓`/`✗` summary line of the following `text` fence, numbers and timings normalised only where the page marks them variable. **Kept, made cheap: its own workflow, not `scaffold-smoke`,** on push to `main` with a `paths:` filter (`wiki/Tutorial-0[1-4]*`, `packages/cli/src/templates/**`, `packages/cli/src/cmd-generate*`, `packages/cli/src/verify-*`). Each run gates a scaffold several times, which is what [`33-ops-ci.md`](33-ops-ci.md) is shedding; here `ci`'s wall clock and its push-count spend do not move, and a push touching none of those paths starts nothing. A red run reads through the daily `health` brief. Not on a PR: a tutorial breaks a branch for an hour at most.
4. **Count what the CLI prints.** `generator-counts` reads the plan the `x g` command applies, not `generate()`'s array, against a scaffold that ran setup.
5. **Links too.** `doc-paths` reads backticks only. Add `](relative/path)` targets; the one dead link in 1,688 was found this way.

Killed, no guard: planned commands (12 wiki claims checked, 0 wrong, `cmd-planned.test.ts` holds the table); an age limit on `As of` stamps (503 of them, and age is not falsity); wiki title vs runtime title (70 of 687 differ, a sample are paraphrases, none false); `X_*` citations with no registration (35, all illustrative, reserved or stated as deleted); a ledger of undocumented exports (1,924 of 3,906, most of them internals: a ratchet for nobody's failure); a second fence-compile pass (181 pinned fences, one wrong, fixed by hand in [`32-docs-false-claims.md`](32-docs-false-claims.md)).

## Error codes
`bun run new-error-code <CODE> --package cli --off-socket …` for each; each guard also takes a `_PIN_STALE`/`_UNSCANNED` like its siblings.

| Code | When | Fix |
|---|---|---|
| `X_KNOWN_GAP_UNPINNED` | an Open row names no test, or a dead one | `add [pin](<test path>#<test name>) to the row, or state pin: none and why` |
| `X_DOC_UNRELEASED_STALE` | a page says unreleased about what has shipped | `bun run scripts/release.ts --bump` at release; else write the version in the row |
| `X_DOC_TUTORIAL_DIVERGED` | a tutorial's command or summary line differs from the run | `bun run scripts/tutorial-run.ts --json`, then edit the page or the generator |

## Tests
Each guard has a `scripts/<name>.test.ts` with a fixture tree that fails, as its siblings do, plus a red-then-green repo assertion. `bun test scripts/known-gaps-pins.test.ts`. Failing-first for 3: the current Tutorial 2 output fails it.

## Semver
None: repository guards. `x g`'s count text is unchanged.

## Done when
- `docs/architecture/guards.md` regenerated and listing each rule; `bun run verify` green.
- Each rule's fixture was seen to fail.
- `ci.yml` unchanged by rule 3; `tutorial-run.yml` green on `main` after a template edit, and absent from a push that touches no listed path.
