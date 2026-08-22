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

## Carried in from slice 05 (found during execution, 2026-08-22)

- **The FIFTH canonical serialiser lives in `scripts/lib/framework-manifest.ts`.**
  `export function canonical(value: unknown): string { return JSON.stringify(sortKeys(value)); }` —
  byte-for-byte the pair deleted from `packages/manifest/src/build.ts` in this sweep, and it feeds
  `framework.manifest.json`'s own `buildId` and `manifestDrift`. `packages/core/src/canonical-json.ts`'s
  header says "never add a fourth copy"; after slice 05 removed copies three and four, **this is the
  one left, in the file that hashes the framework's own manifest**. Its consumer
  `scripts/manifest.test.ts` imports `canonical` from it directly, so the barrel removal did not
  break it and nothing flagged it. Replace with `canonicalJson` from `@ultimat3/core` and delete the
  local pair. Note the consequence slice 05 already hit and pinned: a canonical form that
  distinguishes `-0`/`NaN`/`±Infinity`/`Date` makes a fact carrying one fail `verifyBuildId`, because
  `JSON.stringify` cannot write those values down — that is the honest answer, but check the
  framework manifest holds none before landing it.

- **`scripts/error-render.ts` cannot see the `catch` binding class, and this was PROVEN, not argued.**
  It reads *parameters typed `unknown`* that reach a `cause:`; every
  `catch (error) { error instanceof Error ? error.message : … }` site is a catch binding, which it
  cannot see. Measured: the check was green **before and after** a seven-site fix in
  `@ultimat3/ai` / `@ultimat3/mail`. The same pattern has now been found and fixed at **fifteen sites
  across five packages** in this sweep (`cache`, `auth` ×4, `ai` ×4, `mail` ×3, plus the ones already
  correct) — every one found by a human-style read, none by a gate. `instanceof` throws on a hostile
  value and `String(x)` throws on a Symbol, so each site turns a coded refusal into an uncoded crash.
  **Add the second rule**: a `catch` binding reaching a `cause:`/`fix:`/`detail:` through
  `instanceof` / `String()` / `${}` / `JSON.stringify()`. A ratchet, like `test-bare-error.ts`.
  Without it this defect class has no mechanical half at all, which is axiom 3 saying it does not exist.

- **Nothing refuses a third `formatBytes`.** Slice 05 hoisted one into `@ultimat3/core` after finding
  two divergent copies — render's had no `mb` branch, so a 5 MiB route read `5120kb` in
  `X_BUDGET_EXCEEDED` while pwa's said `5mb` for the same number. `render-modes` refuses a second
  `RENDER_MODES` on its literal member set; there is no equivalent for a shared *function*, so the
  rule currently lives only as a sentence in `packages/core/CLAUDE.md` — which axiom 3 says means it
  does not exist. Note `packages/ui/src/components/file-input-view.ts` has a genuinely different
  byte formatter (base **1000**, `Intl` `style: 'unit'`, locale-aware) that must NOT be caught: the
  guard has to key on behaviour, not on the name.

- **No checker compiles a `wiki/` fence.** `scripts/readme-fences.ts` scans `packages/*/README.md`
  only (`readme(pkg)`), so every ```ts``` block on the wiki — the framework's ONLY public
  documentation surface — is unverified. Measured during slice 05: `wiki/Configuration.md`'s
  top-level `app.config.ts` example failed with
  `TS2353: 'urlEnv' does not exist in type 'Input<DatabaseConfig>'`, and the page went on to
  document roughly **40 config fields that exist on no declaration** (`auth.providers`,
  `auth.session.*`, `auth.passkeys`, `jobs.retry.*`, `jobs.retention.*`, `cache.redis.*`, all 8
  `seo.*`, all 7 `budgets.*`, `storage.driver/bucket/dir`, `otel.endpoint/sampling`). The page is
  rewritten and the fence now compiles — but **by hand**, so it will rot again silently. Widen the
  fence check to `wiki/**/*.md`, on a ratchet.

- **Add the cache-tier pair to `render-modes`' `VOCABULARIES` — see issue #293.** `CacheTier`
  (`core`, `memo|lru|shared|isr|cdn`) and `TierName` (`cache`, `request-memo|lru|redis|cdn`) are one
  set of rungs spelled twice, with `isr` accepted by config and served by nothing. Exactly the
  literal-set-under-a-second-name defect `render-modes` was built for; it shares two members
  (`lru`, `cdn`), which is that check's own stated threshold. **The divergence must be decided
  (#293) before the guard lands**, or the guard just reds a known-bad pair.

- **`gate-steps.ts` did not see `packages/cli/README.md`'s wrong list, measured 2026-08-22.** That
  page spelled the count as the WORD "Seventeen" and listed 17 step names, omitting `seo` and
  `i18n` — and the check was green over it. Two separate misses: `OF_TOTAL` requires the literal
  word `steps` beside a numeral, so a spelled-out count is invisible; and nothing compares a bare
  space-separated run of step names against `VERIFY_STEP_NAMES`. Both are now corrected by hand in
  that README, so the check must learn to catch them or the same page rots again. Widen to: a
  spelled-out number adjacent to a step list, and any run of ≥5 known step names treated as a list
  claiming completeness.

## Tests
- Each script above has a `.test.ts` beside it asserting against `repoRoot()` (the pattern `changelog-check.test.ts` uses); the lockfile one additionally runs against a fixture lock carrying an `i18n` and an `examples/x` block.
- `scripts/gate-steps.test.ts` — a fixture `llms.txt` stating 18 → `kind: 'count'`; "16 of 18" under gate context → reported.
- `scripts/render-modes.test.ts` — a fixture `const X: readonly T[] = [...]` copy is reported.
- Command: `bun test scripts`.

## Done when
- `bun run scripts/lockfile-pins.ts` reports 0 on the regenerated lock and 72 on the old one (keep the old lock in a fixture); `bun run scripts/gate-steps.ts` green after slice 11; `bun run verify` green; `framework.manifest.json` regenerated for any new `X_*` code.
