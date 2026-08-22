# 09 — Gate scripts and new checks

> Part of [`overview.md`](overview.md). Depends on: 01 (`PRIMITIVE_FACTORIES`), 04 (realtime barrel split). Tier: `scripts/` (host checks, tier-agnostic; may import `@ultimat3/cli`).

## Files to change
- `scripts/lockfile-pins.ts:31-32` and `scripts/version-stamps.ts:277,280` — workspace dir and dep name matched with `[a-z-]+` (misses `i18n`) and anchored on `"packages/…"` (skips every app workspace). **Proven**: the shipped check says "bun.lock agrees"; a widened scan finds **72 stale `@ultimat3/*` ranges** (`bun.lock:357-363` `packages/i18n` at 6.0.0 → `core@6.0.0`; `:20-35` `dummy/social-media-clone` at 5.0.1; `:77` `@ultimat3/i18n: ^1.2.0`). `version-stamps.ts:106-112` says the rule exists because "90 entries sat at 1.2.0 … and `--frozen-lockfile` accepted every one"; it recurred at 72. `scripts/release.ts:111-113` has the correct class and a comment naming this exact bug.
- `scripts/gate-steps.ts:31-38,80` — `STEP_GLOBS` reads only `.md`; `llms.txt:3,46` says "eighteen steps" and omits `i18n` (**proven** by feeding the file to `checkGateSteps`). `OF_TOTAL` requires the literal word `steps`, so `README.md:334` "16 of 18" (is 17 of 19) and `dummy/social-media-clone/CLAUDE.md:9` "2 red of 17" pass.
- `scripts/render-modes.ts:33,69` — `VOCABULARIES` lacks `JOB_STATES`, `TEST_TYPES`, `IMAGE_FORMATS`; `AS_CONST` matches `as const` only, so a typed array literal (`: readonly JobState[] =` — `jobs-report.ts:26`'s exact shape) is invisible.
- `scripts/bun-pin.test.ts:38-49` — reads five files, none an app; six `FROM oven/bun:1.3-alpine` lines in the apps (slice 10) sit outside it.
- `scripts/scaffold-gate.ts:47-80` — `scaffoldFindings` lacks `declaredStepIssues` (`reference-app-gate.ts:106-132,167`), so a gate that crashes mid-run and prints a short table passes `scaffold-smoke`.
- `scripts/browser-barrel.test.ts` — exists, does not cover `@ultimat3/realtime`'s client entry (slice 04's critical).
- `scripts/doc-fixes.ts` — resolves `x <command>` citations; a `fix:` citing an `app.config.ts` key (`jobs.driver`, deleted in 5.0.0, cited 4× in `docs/`) is unchecked.
- `scripts/lib/tiers.ts:6-7,55` — "checked by this file's own rule" (no such rule), "28 framework packages" (29). Floor reality: `policy` 2 (floor 1, no written reason), `pwa` 4 (floor 2, no reason), `render`/`ui`/`scraping` above floor with reasons.
- `scripts/boundaries.ts:2-4,38-100` — private import scanner beside `packages/cli/src/workspace-graph.ts`; the header's reason ("the CI job that runs it needs no `bun install`") names a job that does not exist, and `scripts/render-modes.ts:7` already imports `@ultimat3/cli`.
- `scripts/verify.ts:114` — `String(error)` in a `cause:`; `scripts/registry-audit.ts:94-97` `failureDetail` is the total form. `scripts/coverage-gate.ts:202` — `endsWith('/' + rel)` re-introduces the substring collision `:159-165` fixed. `scripts/doc-commands.ts:157-158` — both ternary branches identical. `scripts/version-stamps.ts:119` — lexicographic version sort.

## Steps
1. Lockfile: `[a-z0-9-]+` in all four regexes; iterate every workspace from `workspaceManifests(root)` rather than `packages/*/package.json`; `--write` covers apps. Then `bun install` to regenerate `bun.lock`, commit it, and confirm the check now reports 0 (it must report 72 before the regen — that is the test).
2. `gate-steps.ts`: add `'llms.txt'`, `'.github/workflows/*.yml'`, `'scripts/**/*.ts'`, `'.claude/**/*.md'` to `STEP_GLOBS` (`readMarkdown` takes any glob); second `OF_TOTAL` span `\b(\d+)\s+(?:red\s+)?of\s+(\d+)\b` consumed only under `GATE_CONTEXT` (`:59`). Fix every hit it then reports (slice 11 lists them).
3. `render-modes.ts`: add the three vocabularies; widen `AS_CONST` to typed array literals. Must land in the same PR as slice 07's `JOB_STATES`/`TEST_TYPES` deletions and slice 05's image-format derivation, or the guard passes over the copies it was widened to catch.
4. `bun-pin.test.ts`: add `{examples,dummy}/*/docker/Dockerfile*` to `imagePins`.
5. `scaffold-gate.ts`: call `declaredStepIssues(steps, VERIFY_STEP_NAMES)`; add the fix-follow loop from slice 08 step 5.
6. `scripts/browser-barrel.test.ts`: one `Bun.build({ target: 'browser' })` per client-facing barrel — `@ultimat3/realtime` (`"."`), `@ultimat3/render`, `@ultimat3/pwa`, `@ultimat3/ui` — assert success. Reds on `main` for realtime; green after slice 04.
7. New `scripts/primitive-factories.test.ts` (in `@ultimat3/cli`'s reach, which may import `ai`, `jobs`, `scraping`): every exported function outside `action`/`jobs` whose return type is `Action<…>`/`JobHandle<…>` appears in `PRIMITIVE_FACTORIES`. Shape: `mcp-exposure-pin.test.ts`.
8. `doc-fixes.ts`: resolve `<section>.<key>` citations in a `fix:` against the leaf keys of `AppConfigInput`; a cited key must exist.
9. `tiers.ts`: `FLOOR_ABOVE: Readonly<Record<string, string>>` beside `SIDEWAYS_ALLOW` — package → written reason, blank refused; `boundaries.ts` computes each package's floor from shipped imports and fails when a package sits above it without a row. Rows today: `render`, `ui`, `scraping` (reasons already written in `tiers.ts`/CLAUDE.md files), `policy`, `pwa` (write the sentence or move them — `pwa` to 2 is legal; `policy` to 1 is legal). Fix `:55` to 29 and `:6-7` to describe this rule. Decision on moving → `12-decisions.md`.
10. `boundaries.ts`: import the scan from `@ultimat3/cli` (`workspace-graph.ts`'s scanner, extended to follow relative cross-package specifiers and test files, which is what `boundaries` needs); delete the private copy and the header sentence.
11. `verify.ts:114` → `renderThrowable`; `coverage-gate.ts:202` → `startsWith`; `doc-commands.ts:157` → say the direction; `version-stamps.ts:119` → semver compare.
12. New script `scripts/config-readers.ts` (gate `unit` step via its `.test.ts`): for each leaf key of `AppConfig`, at least one read site in `packages/*/src` outside `config.ts`/`defaults()`. Reds on day one for `installPrompt`, `afterSignInPath`, `modelEnv` — the three slice 12 decides on; a ratchet with `--unpin` like `test-bare-error.ts` if they stay.

## Tests
- Each script above has a `.test.ts` beside it asserting against `repoRoot()` (the pattern `changelog-check.test.ts` uses); the lockfile one additionally runs against a fixture lock carrying an `i18n` and an `examples/x` block.
- `scripts/gate-steps.test.ts` — a fixture `llms.txt` stating 18 → `kind: 'count'`; "16 of 18" under gate context → reported.
- `scripts/render-modes.test.ts` — a fixture `const X: readonly T[] = [...]` copy is reported.
- Command: `bun test scripts`.

## Done when
- `bun run scripts/lockfile-pins.ts` reports 0 on the regenerated lock and 72 on the old one (keep the old lock in a fixture); `bun run scripts/gate-steps.ts` green after slice 11; `bun run verify` green; `framework.manifest.json` regenerated for any new `X_*` code.
