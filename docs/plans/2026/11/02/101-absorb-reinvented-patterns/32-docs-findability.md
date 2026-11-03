# 32 — Docs: finding the one way to do X, offline

> Part of [`overview.md`](overview.md). Depends on: [`22-cli-upgrade.md`](22-cli-upgrade.md) for the section pointer it can then make local. Tier: `manifest` (4), `cli` (5).

## Why
An adopter's agent has `x docs`, and a fresh scaffold's `AGENTS.md` and `CLAUDE.md` never mention it (`git grep -c 'x docs' packages/cli/src/templates/scaffold-docs.ts packages/cli/src/templates/scaffold-claude.ts`: 0, 0). So stale comments live on: three checked in one adopter's tree claim gaps closed majors ago. `x docs` reads package READMEs, CLAUDE.md files and source headers from `node_modules`, and no wiki page, which is the only public manual (`packages/cli/package.json:23`).

Measured, 20 task questions on a scaffold, right package in the top 3: 11 of 20.
| Question | Top hit | Wanted |
|---|---|---|
| `send email` | `auth.README#email-verification…` | `mail` |
| `upload a file to s3` | nothing | `storage` |
| `upgrade to the next major` | nothing (bare `upgrade`: a WebSocket section) | Upgrading |
| `scrape a website` | `seo.ld` | `scraping` |
| `streaming llm agent` | `cli.cmd-new` | `ai` |
| `feature flag` | `cli.flag-reads` | `flags` |

`wiki/Upgrading.md` is 386 kB, about 97k tokens, one file; its largest section 108 kB. Its summary table says "the `29.0.0` section" and links nothing, and no heading is called that. An agent moving one major cannot fetch one section.

## Files to change
- `packages/cli/package.json:23` plus a `prepack` copying `wiki/*.md` except `Error-Codes.md` into `packages/cli/wiki/`, git-ignored. Measure the tarball: the whole wiki gzips to 868 kB; an unacceptable figure means shipping a pruned set, with the number in the PR.
- `packages/manifest/src/docs-scan.ts:262` — index `wiki/` pages by heading as `wiki.<Page>#<anchor>`.
- `packages/manifest/src/docs-search.ts` — ranking, below.
- `packages/manifest/src/docs-search.eval-set.ts` (new) — the 20 questions and wanted topic prefixes, kept as the regression set.
- `packages/cli/src/cmd-docs.ts` — a `Page#anchor` topic prints that whole section. `X_`-prefixed question already routes to `x errors explain`.
- `packages/cli/src/templates/scaffold-docs.ts`, `scaffold-claude.ts` — one line in each convention file: before stating or working around a framework limit, `x docs "<question>"`, and `x errors explain <CODE>`. Scaffold tests pin it; size check `X_AGENTS_MD_TOO_LARGE` still holds.
- `wiki/Upgrading.md:9-36` — each row's third cell links `[28.x → 29.0.0](#28x--2900-entry-by-entry)`. `scripts/changelog-check.ts:292,302` asks for that form.
- `wiki/Contributing.md` — cut to a pointer at `CONTRIBUTING.md`. Two pages with different sections, teaching one job twice (axiom 1).
- `wiki/Home.md`, `wiki/Getting-Started.md`, `wiki/Troubleshooting.md` — state `x docs` as the first lookup; they do not today. Only `README.md:317`, `llms.txt:177`, `wiki/CLI-Reference.md:58` do.

## Steps
1. Add the eval set first, failing at 11 of 20.
2. Search: drop stop words before matching, because `upload a file to s3` matches on `file` or nothing. Rank a package's name and heading matches over a source-header hit. Prefer guide kinds over source headers. Keep it a pure function, no new dependency; no embeddings.
3. Ship and index the wiki. A question hits a section, so `upgrade 28` lands on `wiki.Upgrading#28x--2900-entry-by-entry`. Answer's `text` stays the section; 22's `section` gains `local: <topic>` alongside the URL (minor to 22's report, same sweep or later).
4. Keep `wiki/Upgrading.md` one file: `scripts/changelog-check.ts` reads it whole and the section read solves the cost. Split only if the eval shows sections too large to use.
5. Keep `Error-Codes.md` out of the index, since `x errors explain` is the one way. Its `docs:` URL stays.
6. Scaffold lines, Upgrading links, Contributing pointer.

Considered and killed: a second search command; a hosted docs site here ([`42-adopt-docs-site.md`](42-adopt-docs-site.md) owns that, and reuses this ranker); per-major wiki pages (28 sidebar rows, and the changelog guard rewritten for a cost the section read removes).

## Error codes
None. An unreadable wiki directory in an install is the existing `X_CLI_UNEXPECTED` branch in `cmd-docs.ts`, which keeps its `fix:`.

## Tests
- `packages/manifest/src/docs-search.test.ts`: the eval set scored, floor 18 of 20; it can fail, and starts failing. `bun test packages/manifest/src/docs-search.test.ts`.
- `docs-scan.test.ts`: a fixture `wiki/` yields heading topics; a page with fenced `#` lines does not yield false headings (`wiki/Upgrading.md:43` has them).
- `cmd-docs` test: `Upgrading#<anchor>` prints only that section.
- `scaffold-claude.test.ts`: both convention files name `x docs`.
- `scripts/wiki-anchors.ts` covers the Upgrading table links once they exist.
- Pack check: `bun pm pack` of `packages/cli` holds `wiki/Home.md`; add to `scripts/scaffold-smoke-overrides.ts`'s run only if `file:` overrides do not already exercise it.

## Semver
Minor. New topics, better ranking; `--json` shape unchanged. Ranking changes hits, which is not a stable surface; say so in `wiki/CLI-Reference.md`'s `x docs` section.

## Done when
- Eval at 18 of 20 or above, on a scaffold's installed tree.
- `x docs "upgrade to the next major"` returns an Upgrading section; `x docs "send email"` a `mail` topic.
- Fresh `AGENTS.md` and `CLAUDE.md` name `x docs`; scaffold gate green twice per shape.
- Tarball delta stated in the PR.
