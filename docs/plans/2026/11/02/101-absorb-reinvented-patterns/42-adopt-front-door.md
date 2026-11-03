# 42 — Adoption: 30 seconds on the README, the npm page, the wiki home

> Part of [`overview.md`](overview.md). Depends on: [`42-adopt-first-hour`](42-adopt-first-hour.md) (numbers), [`42-adopt-stability`](42-adopt-stability.md) (link). Claims outside these files stay [`32-docs-false-claims`](32-docs-false-claims.md). Tier: docs, `scripts/`, every `package.json`.

## Why
Grade, cold read 2026-11-02. **What it is: clear in 10 seconds. Why pick it: nowhere.** `README.md` is 411 lines.

| Stranger looks for | Found | Grade |
|---|---|---|
| one-line what | `README.md:6,28` | good |
| a reason over the alternatives, and when not to | none. `wiki/FAQ.md:161-168` is one row each, all favourable | fail |
| a live demo | **live** (200, 0.43 s), linked from no public page: `git grep` finds the host only in `dummy/social-media-clone/PLAN.md` and `deploy-social-demo.yml:74`. Repo homepage is the wiki | fail, and the cheapest fix here |
| what it looks like | first code at line 72, after a 130-word paragraph on `x manifest` (line 56) and a film still (line 33) | poor |
| honesty | `README.md:350-358` "what the number does not say" is rare and good. Keep it | good |
| true numbers | `:44` "installs 104 packages" (run: 299 tarballs, 117 `bun pm ls --all` lines). `:165,285` and `llms.txt`: capacity figures "in `CLAUDE.md`", moved out 2026-09-23 (`scripts/bench-claims.ts:6`). `:169` "no production deployments… none exist" while `overview.md` counts nine adopters | false |
| rights | `assets/never-send-a-human.webp`, `README.md:33,36`: a still from a commercial film in an MIT repository, shown nowhere under a licence | a risk for zero information |
| wiki landing | `wiki/Home.md` opens with lockstep and provenance history; 218 `As of 2026-08` stamps across 41 pages; "Is it production ready?" (`wiki/FAQ.md:7`) answers about 2.0.0's attestation | poor |
| npm page | no `keywords` on `create-ultimate` or any of 4 sampled packages. `homepage` is `#readme` for all. `@ultimat3/core`'s README opens on an internal module table | poor |

## Decisions
| Question | Answer |
|---|---|
| README length | at most 150 lines. Depth moves to existing pages; one hop per question stays |
| Order | what · one real code sample · run it (one line, three steps) · live demo · why pick / when not · proof table · stability link · AI-maintained, governance link |
| "When not" | quoted from the `non_goals` of `.dz/maintainer/maintainer.yml:48-54`, plus `wiki/Known-Gaps.md` |
| Film still | removed, file deleted. No replacement image |
| Adopter claim | an unnamed count, marked as ours: "N apps run it in production, all ours so far" |
| Code sample | a real file from `examples/dummy`, quoted, with a guard; never hand-written |
| Screenshot | one of the demo, `x shot`-produced, committed; only with the demo link beside it |

## Files to change
- `README.md` — restructure; `:44,165,285,169`.
- `assets/never-send-a-human.webp` — delete.
- `scripts/readme-sample.ts` (new) + test, `scripts/verify.ts:343` — sample guard. `scripts/readme-fences.ts` is the neighbour; extend it if its shape fits.
- `wiki/Home.md`, `wiki/FAQ.md` status section, `wiki/_Footer.md` — lead with what and how; move publication history to `PUBLISHING.md`.
- `packages/create-ultimate/README.md`, `packages/core/README.md` and any package failing step 4.
- all 31 `package.json` — `keywords`, `homepage` per package page once [`42-adopt-docs-site`](42-adopt-docs-site.md) lives, the wiki page until then. Stamped by `scripts/new-package.ts` going forward.
- `scripts/package-shape*` or the `package-shape` step in `packages/cli` — the check.
- `dummy/social-media-clone/README` or home page — "this is the demo; source here".

## Steps
1. Sample: pick the shortest real action in `examples/dummy` with policy and `mcp`; `readme-sample.ts` compares the fence to the file.
2. Rewrite `README.md` in the order above. Link `https://social-media.ultimate.demo.developerz.ai` beside the first run command, with the read-this line: "fabricated data, every row decided by a policy".
3. Re-derive `:44` figures through `scripts/generator-counts.ts` and put the command beside each.
4. Package README shape, checked: first screen is one sentence, an install line, the smallest example, then the wiki page. Internal tables below. Budget: first 30 lines hold all four. Pin failures and burn down in this slice.
5. `wiki/Home.md`: same order; `wiki/FAQ.md:7`: yes/no answer first, with `As of`, what is proven (`deploy-proof`), what is not. Stale stamps on rewritten text go; other pages stay [`32-docs-guards`](32-docs-guards.md)'s.
6. Prepared text for the repo's About field and homepage in the PR body. **Owner publishes**: repo description, homepage URL, topics. The npm pages change at the next release.

## Error codes
`bun run new-error-code`, `--off-socket`.

| Code | When | Fix |
|---|---|---|
| `X_README_SAMPLE_DRIFT` | the README fence differs from its file | `bun run scripts/readme-sample.ts --write` |
| `X_PACKAGE_README_SHAPE` | first 30 lines miss install or example | edit that package's `README.md` head, or pin with a reason |
| `X_PACKAGE_KEYWORDS_MISSING` | a publishable package has no `keywords` | add `keywords` to its `package.json` |

## Tests
- `scripts/readme-sample.test.ts`: a one-character edit in the example fails.
- Package shape unit test: fixtures for each new code; the framework's own 31 pass after step 4.
- `scripts/doc-*` existing guards stay green, including `bench-claims`.
- `bun test scripts/readme-sample.test.ts`

## Semver
No API change. Patch; metadata reaches npm with the next release.

## Done when
- `wc -l README.md` ≤ 150; first code before line 40; the demo link before line 40; a "when not" table exists.
- `git ls-files assets` has no film still.
- `npm view create-ultimate keywords` is non-empty after the next release.
- A cold reader answers "what, why, when not" from the first screen; the PR body shows the reader's answers.
