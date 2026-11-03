# 32 — Docs: the claims a cold read proved false

> Part of [`overview.md`](overview.md). Depends on: [`21-cli-verify-and-stop.md`](21-cli-verify-and-stop.md) (the `budgets` output Tutorial 2 prints), [`36-dx-generators.md`](36-dx-generators.md) (the files and fixes the tutorials print). Land [`32-docs-guards.md`](32-docs-guards.md) in the same sweep, so each class stays fixed. Tier: docs only.

## Why
`wiki/Known-Gaps.md` is the page an agent reads to learn what not to trust, and 15 of 25 rows checked on 2026-11-02 are false. 11 are the `main` rows: `CHANGELOG.md`'s `[Unreleased]` is empty, so every one has shipped. Tutorial 2, run command by command on a fresh `x new myapp --no-example` with `bun run setup` first, does not end green. Its first line says it was run on 1.1.0, 28 majors ago, though the body was edited in 2026-10. One adopter on 28.0.0 still carries a comment that MCP has no `instructions` field (shipped in 23.0.0), one that `@ultimat3/time` has no month math (`packages/time/src/index.ts:102`, absent from every wiki page), one that `jobs` has no final-attempt signal (`wiki/Jobs-And-Workflows.md:183`).

## Files to change
| Path:line | Says | Is |
|---|---|---|
| `wiki/Known-Gaps.md:43` | `error-render` cannot see a `catch` binding | closed: `scripts/error-render.ts:441-457` joins `catchRenderFindings`. Move to Closed |
| `wiki/Known-Gaps.md:60` | `x manifest diff` cannot see `readonly`, `matching` or `count` | closed: `packages/manifest/src/diff-admin.ts:49,130`; B29 is closed. Check the permission noun, keep only what is still true |
| `wiki/Known-Gaps.md:82` | milestone 11 still open | closed: `docs/idea/14-roadmap.md:27,37`, `ci.yml:815`. Move to Closed |
| `wiki/Known-Gaps.md:36,130` | default flips "in the next major" | two majors have passed and `packages/render/src/render-isr-key.ts:22` still keys on the whole query. Decided: flip, in [`35-fix-isr-default.md`](35-fix-isr-default.md), which removes these rows |
| `wiki/Known-Gaps.md:125,129-139` | `main`, no published release | stamp each with its release from `CHANGELOG.md` (first checked: 27.8.1) |
| `wiki/Known-Gaps.md:3,90,94` | whole-page stamp `As of 2026-10-07` | per-row stamps already exist; drop the page stamp, it reads as a promise about every row |
| `wiki/MCP-And-AI.md:224` | `As of Unreleased` | shipped, `CHANGELOG.md:5542`. Stamp the version |
| `wiki/Migrating-An-Existing-App.md:427` | "next major closes it, not yet tagged", action on 21.x | shipped. Say the version; keep the action as a pinned-below note |
| `wiki/Home.md:55` | tutorials 2–5 were run on 1.1.0 | replace after the re-run below |
| `wiki/Tutorial-02-First-Feature.md:5`, `Tutorial-03:5`, `Tutorial-04:5`, `Tutorial-05:5` | same stamp | same |
| `wiki/Tutorial-02-First-Feature.md:49,60`, `wiki/CLI-Reference.md:311` | `x g resource` writes 33, 35 with `--admin` | a run prints 38 before setup, 40 after setup, 41 with `--admin` (see Steps 2) |
| `wiki/Tutorial-02-First-Feature.md:254-268`, `wiki/CLI-Reference.md:575` | `x verify` green, 17 of 20, e2e skipped | `✗ budgets X_BUDGET_UNMEASURED`, only `roadmap` skipped. Slice [21](21-cli-verify-and-stop.md) changes this; take the output after it lands |
| `wiki/Testing.md:516` | `associations: { orgId }` on a `post` with no `orgId` | TS2353 under the stubbed compile. Add the column to the example |
| `docs/idea/05-caching.md` | link to `packages/cache/src/single-flight.ts` | moved to `packages/core/src/single-flight.ts` |
| `wiki/Timezones-And-Dates.md` | no month arithmetic | add `addMonthsInZone`, `addPlainMonths`, from `packages/time/README.md:137` |
| `wiki/Upgrading.md:43-64` | maintainer notes on how the count is computed, in a reader's page | move to `scripts/changelog-check.ts`'s header |

## Steps
1. Re-run tutorials 1–4 on a scaffold (`scripts/scaffold-smoke-overrides.ts <app>`, then each `bunx x` fence). Replace each output block with what printed. Tutorial 5 needs Docker and a host: re-run what runs locally, and its stamp says which steps did not.
2. Decide what the count means. `scripts/generator-counts.ts` measures `generate(...).length`, and the CLI also writes `package.json`, the catalog and the wiring. State the count the CLI prints; [`32-docs-guards.md`](32-docs-guards.md) moves the guard onto it.
3. Fix the table above. Each move to Closed names its release and its pinned-below workaround, in the page's own format.
4. Replace each adopter-name mention with a neutral example or "one adopter" (the list is held outside this plan). Sites: wiki pages, package READMEs and CLAUDE.md files, shipped source comments, the generated templates' comments, `examples/dummy`. Test fixtures use a neutral name.
5. `CHANGELOG.md` and `docs/history/` also carry those names. They stay: their records stand, and the published history keeps them anyway. The forward rule is [`37-scrub-adopter-names.md`](37-scrub-adopter-names.md).

## Error codes
None new here; the guards slice carries them.

## Tests
- No test of its own. `bun run doc-paths`, `doc-commands`, `wiki-anchors`, `wiki-fences`, `generator-counts`, `known-gaps-links` stay green.
- Renaming fixtures in tests: run each touched file, e.g. `bun test packages/action/src/openapi-complete.test.ts`.

## Semver
Patch, docs only.

## Done when
- `` git grep -nE 'As of Unreleased|^\| [^|]+ \| `main` \|' -- wiki/ ':!wiki/Error-Codes.md' `` answers nothing: a `main` in a table's second column (Known-Gaps' "Fixed in"), never a flag's `--base` default in the third; `wiki/Error-Codes.md` names the phrase in `X_DOC_UNRELEASED_STALE`'s row.
- A fresh scaffold following tutorials 1–4 ends with the outputs the pages print.
- The private-name guard reports zero outside the paths [`37-scrub-adopter-names.md`](37-scrub-adopter-names.md) excludes.
