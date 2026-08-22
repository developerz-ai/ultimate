# 11 — Docs drift

> Part of [`overview.md`](overview.md). Depends on: 09 (widened `gate-steps`, `doc-fixes` config keys). Tier: none.

Every row was checked against the tree during the audit. Counts are measured `As of 2026-08-21`.

## Files to change
| File | Says | Tree |
|---|---|---|
| `CLAUDE.md` "## CI" | "`ci.yml` runs three jobs"; "every job starts with `./.github/actions/setup`"; "a fourth workflow" | six jobs (`verify`, `reference-app-verify`, `scaffold-smoke`, `container`, `package-list`, `package`); the `container` job deliberately skips setup (`ci.yml:303-305`); five workflows |
| `CLAUDE.md:181` | `frozen-records` "21 sites, 4 left open" | 22 explicit, 4 annotated-open |
| `CLAUDE.md` realtime paragraph | "the bridge is the one caller that still throws the answer away" | literally true, but `SocketRegistry.deliver` (`packages/realtime/src/socket.ts:369-392`) counts, logs and exposes every drop — say "unrepairable, not uncounted" |
| `CLAUDE.md` primitives section | two factory examples | six exist; point at `PRIMITIVE_FACTORIES` (slice 01) |
| `llms.txt:3,46` | "eighteen steps", list omits `i18n` | 19 |
| `README.md:334` | demo app "16 of 18" | 17 of 19 |
| `dummy/social-media-clone/CLAUDE.md:9` | "2 red of 17" | 2 red of 19 |
| `scripts/reference-app-gate.ts:109,404`, `scripts/lib/gated-apps.ts:19,75`, `scripts/lib/unpin.ts:57`, `scripts/scaffold-gate.ts:4`, `.claude/commands/planx.md:113` | "17" | 19 |
| `scripts/lib/tiers.ts:55` | "28 framework packages" | 29 |
| `wiki/Error-Codes.md:505` | scraping "owns 24 codes" | 26 (#285 added two); nothing derives the number — either derive it in `gate-codes.ts` or delete the count |
| `wiki/CLI-Reference.md:917` | `x shot` `ok` is "exactly two conditions" | three in code, four after slice 07 — restate from `buildVerdict` |
| `docs/architecture/04-error-contract.md:168,196`, `docs/architecture/08-jobs-internals.md:81`, `docs/idea/17-scale-ladder.md:140-141` | `jobs.driver` as the worked `fix:` example / the ladder's switch | deleted in 5.0.0; the page defining axiom 4 demonstrates it with a no-op |
| `docs/idea/14-roadmap.md:26` | "every `x g` generator's output passing unmodified is not gated" | `ci.yml:232-234` runs `scaffold-first-run.ts` (every generator) then `scaffold-gate.ts` — the roadmap understates the tree |
| `packages/render/CLAUDE.md:73` | "ui (tier 5, upward)" | ui is tier 4; same tier, not a declared edge (`docs/architecture/01-package-map.md:67` has it right) |
| `packages/entity/src/columns-data.ts:30` | `json()` "never stringified" | `pg-row.ts:126` stringifies + `pg-sql.ts:267` `::text::jsonb` |
| `packages/cli/src/jobs-report.ts:25` | "`@ultimat3/jobs` exports the type but no runtime list" | `driver.ts:20` exports `JOB_STATES` (deleted with slice 07) |
| `packages/cli/src/templates/scaffold-db-package.ts:60` | migration generator reads `schema.ts` | reads the registry (deleted with slice 08) |
| `packages/cli/src/templates/route.ts:141`, `island.ts:81` | "a raw hex here is … a lint failure" | it is not, until slice 08 ships the guard |
| `dummy/social-media-clone/docker/docker-compose.prod.yml:71`, `…/docker/README.md:11`, `examples/dummy/docker/docker-compose.prod.yml:52`, `…/docker/README.md:11`, `wiki/Scheduled-Tasks.md:98`, `wiki/Timezones-And-Dates.md:94`, `wiki/Tutorial-04-Jobs-And-Realtime.md:84`, `wiki/Tutorial-06-Growing-Up.md:41` | scheduler leader = Postgres advisory lock | expiring lease row (`dev-roles.ts:315-318`, `driver-pg-ddl.ts:144`); the prior sweep fixed the framework files and not these |
| `packages/entity/src/describe.ts:70` | `arrayOf` element encoding "total in practice" | false; slice 03 |

## Found during execution, 2026-08-22 — not in the original audit

| File | Says | Tree |
|---|---|---|
| root `CLAUDE.md`, command table, "test (one name)" | `bun test -t 'formats the fix line'` | matches **zero** tests in the repo — `grep -rn "formats the fix line"` finds nothing. Worse, running it loads all 1,143 test files into one process and reports 16 fails / 19 errors from cross-file module-scope collisions, so the documented example not only does not work, it looks like a broken repo. Replace with a name that exists |
| root `CLAUDE.md` primitives section | two factory examples, "the rule's **second** instance" | six factories ship; `PRIMITIVE_FACTORIES` (landed #288) is now the derived list — point at it and delete the ordinal |
| `packages/ai/src/hive.ts` header | "The fourth instance of the framework's factory rule" | at most one of the three files claiming "fourth" can be right; slice 05 deletes it |
| `packages/scraping/src/scrape.ts` header | "The rule's fourth instance" | same; slice 06 deletes it |
| `packages/core/CLAUDE.md`, `wiki/` readiness prose | `/readyz` semantics | `HealthReport.registered` shipped in #288; an empty registry still answers **200**, which is now a documented three-state table rather than an implied binary. Any page describing `/readyz` as "ready = all checks pass" must say what zero checks means |
| `scripts/error-map-backlog.ts` core group | — | gained `X_OTLP_HEADERS_INVALID` in #288; the group comment's description of what core's unpinned codes have in common still holds, but confirm the count if any prose states one |

**Note on this plan's own citations.** Three `file:line` references in `02-tier1.md` point at lines that do not exist (`context.ts:670-674` in a 271-line file; `tier-failures.ts:559`; `invalidate.ts:384`), and `01`'s step 4 implies an error code was new when it already existed. The findings were all real. Left as written — this file is the historical record of what the audit saw — but any future slice must locate defects **by content, not by line number**.

## Steps
1. Land slice 09's widened `gate-steps` first; fix every line it reports (the 17/18 rows above are its output).
2. Edit the remaining rows by hand; where a number can be derived (`Error-Codes.md` per-package counts, `frozen-records` sites, package count), derive it in the script that already reads the set and delete the prose number, per axiom 3.
3. Run `bun run scripts/doc-fixes.ts` after slice 09 step 8 and fix the four `jobs.driver` citations it then reports; replace the worked example with a key that exists (`cache.tiers` or `auth.signInPath`).
4. Advisory-lock wording: one grep, ten edits; add `advisory lock` to a `wiki-frames`-style forbidden-phrase list if the checker has one, else leave.

## Tests
- `bun run scripts/gate-steps.ts`, `bun run gate-codes`, `bun run changelog-check`, `bun run scripts/doc-commands.ts`, `bun run scripts/doc-fixes.ts` — all green.
- `bun run scripts/roadmap.ts` green after the milestone-10 edit.

## Done when
- Every row above is edited or derived; the checkers above are green; `bun run verify` green.
