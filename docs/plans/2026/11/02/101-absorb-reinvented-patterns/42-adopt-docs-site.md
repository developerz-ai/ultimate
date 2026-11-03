# 42 — Adoption: a docs site, built by Ultimate

> Part of [`overview.md`](overview.md). Depends on: [`32-docs-findability`](32-docs-findability.md) (ranker), [`32-docs-false-claims`](32-docs-false-claims.md), [`42-adopt-first-hour`](42-adopt-first-hour.md), [`38-ui-viewers`](38-ui-viewers.md) (`Markdown`), [`41-add-locale-and-content`](41-add-locale-and-content.md) (`/llms.txt`). Tier: new tracked app, `scripts/`, CI. **Decided: reverses `docs/idea/14-roadmap.md:45-46`.** Since `38-ui-viewers` is breaking, the site's routes land after v32.

## Why
Measured 2026-11-02: every wiki page answers `x-robots-tag: none`; the repository page does not. **Search engines are told to skip all 59 pages of the manual.** A stranger searching an `X_*` code or "how do I X in Ultimate" finds nothing.

| Wiki limit | Fact |
|---|---|
| discovery | `x-robots-tag: none`, `curl -sI …/wiki/Getting-Started` |
| size | `Error-Codes` 448 KB, `Upgrading` 380 KB, one page each; every error's `docs:` is the same URL, no per-code anchor (`docs/idea/14-roadmap.md:49`) |
| search | no site search |
| agents | no `llms.txt` at the docs origin, no plain markdown per page beyond raw repo links |
| demo value | the framework's own claims (0 KB `site/`, SEO gate, budgets) are not shown on its own front door |

The best demo of a framework is its own docs site at a 0 KB budget, gated by its own `x verify`.

## Decisions
| Question | Answer |
|---|---|
| Source | `wiki/*.md` stays the one source. The site and the GitHub wiki are both projections (axiom 1). `wiki.yml` keeps mirroring; its `_Footer` points at the site |
| Where | `dummy/docs-site`, third row in `scripts/lib/gated-apps.ts`, `expectedRed: {}` from day one. Scaffolded by `bunx create-ultimate`, so it hits what a stranger hits |
| Depends on published or workspace | workspace, as the other two tracked apps |
| Rendering | `render: 'static'` routes, `prerender` over paths (`cli/src/prerender.ts:326` already expands params). Markdown through `Markdown` from `@ultimat3/ui` (38-ui-viewers): one markdown path, no `innerHTML`, fences through `CodeBlock` with every language passed on the server at 0 B. No dependency |
| JS | 0 KB on every page, enforced. One `/search` route with an island and a declared budget, raised with its number (axiom 9) |
| Search index | built at build time from wiki sections; static JSON. The island and the build rank with one function, `searchDocs` (`manifest/src/docs-search.ts:192`), exported at a new leaf subpath `@ultimat3/manifest/docs-search`. It is pure and imports a type only, so the island pays for it alone |
| Long pages | split at render: `/errors/X_FOO` one page per code; `/upgrading/29` one per major. `wiki/` files unchanged |
| Hosting | `x build --target static`, output on free static hosting from this repo; no process and no database. A container remains possible, nothing depends on either (axiom 7) |
| Domain | `ultimate.developerz.ai`, next to the demo's host |
| Versions | latest only until [`42-adopt-stability`](42-adopt-stability.md)'s first window opens; then latest + previous major, from tags |
| Theme | `@ultimat3/ui` tokens, dark and light; nothing custom beyond the app's own tokens |
| Comments, analytics | none |

## Files to change
- `dummy/docs-site/**` (new) — the app: `apps/web/site/[...slug]`, `errors/[code]`, `upgrading/[major]`, `search`, home, `sitemap`, `robots`.
- `dummy/docs-site/packages/docs-source/` — wiki reader: wiki-link rewrite, heading ids, split rules, a `.md` sibling per page. Pure, unit-tested.
- `scripts/lib/gated-apps.ts`, `tsconfig.json` references, `scripts/ci-workflow-shape.test.ts`, `.github/workflows/ci.yml` — third app.
- `.github/workflows/deploy-docs-site.yml` (new) — after green `ci` on `main`, the static artifact, same gate pattern as `deploy-social-demo.yml:64-68`.
- `packages/manifest/package.json:17`, `packages/manifest/src/docs-search-subpath.test.ts` (new) — the `./docs-search` leaf; nothing but it in the island's graph.
- `wiki/_Footer.md`, `wiki/Home.md`, `CLAUDE.md:101`, `docs/architecture/19-cutting-a-major.md:33`, `docs/idea/14-roadmap.md:45-49`, `README.md` — the decision, recorded.
- `packages/core` `ERROR_DOCS_URL`, `wiki/Error-Codes.md` — final step only.

## Steps
PR 1: the scaffold alone. `bunx create-ultimate`, the third row in `scripts/lib/gated-apps.ts`, CI wiring, green with no content. PR 2: steps 1-7, so a scaffold defect is seen apart from the reader's.

1. Reader first: `wiki/*.md` → `{ slug, title, source, sections }`. Rewrites `[x](Getting-Started)` and `blob/main` links; a dead link fails the build. Strips HTML comments, since `Markdown` prints raw HTML as text. A section past `Markdown`'s size cap is a build error, never a page of plain text.
2. Routes, static, 0 KB. Home states what · run · demo · why · when not; it is authored, not `wiki/Home.md` verbatim.
3. Split rules for error codes and upgrading sections; stable URLs from the code and the major. Every shipped code has a page; missing one is the gate's `errors` set against the build's page list.
4. `/search` island over `searchDocs`; budget raised with its measured number in the same diff. A `CodeBlock` here takes its `languages` prop with what it uses, not all seven.
5. Agents: `/llms.txt` comes from `seo.llms` (41-add-locale-and-content), which owns every site's; this slice adds no generator. `<page>.md` from the reader.
6. `seo` gate on every route: titles, descriptions, JSON-LD for docs, sitemap. A wiki section missing a lead sentence falls back to its first line; empty is a build error.
7. CI deploy workflow, dry until the owner step below.
8. **Owner publishes**, the final step, since it is outward-facing: sets DNS for the domain above, enables hosting, flips the workflow on, sets the repo homepage, and only after the site has served for two weeks flips `ERROR_DOCS_URL` to `<site>/errors/<code>` in the next scheduled major. No announcement is implied by any of this.

## Error codes
`bun run new-error-code`, app-local in `dummy/docs-site` unless shared.

| Code | When | Fix |
|---|---|---|
| `X_DOCS_LINK_DEAD` | a wiki link resolves to no page or heading | fix the link in the named `wiki/` file |
| `X_DOCS_CODE_PAGE_MISSING` | a declared `X_*` code has no built page | add its row in `wiki/Error-Codes.md` via `bun run new-error-code` |

## Tests
- `docs-source` unit tests: link rewrite, split, heading collision; a broken fixture link fails.
- `x verify` on the app, through `reference-app-gate.ts`: budgets (0 KB), `seo`, `i18n`.
- A built-output `e2e`: `/errors/X_DB_DRIFT` 200 with the row's cause; `/search` finds it; no `<script>` on a docs page.
- `bun run scripts/reference-app-gate.ts`

## Semver
App only: none. `ERROR_DOCS_URL` is a changed exported constant, so its flip is breaking: Upgrading entry "the `docs` URL on an error changed; a test pinning the old string updates". Waits for the window.

## Done when
- `bun run scripts/reference-app-gate.ts` holds three apps, all green.
- Built output: every wiki page, code and major has a URL; docs pages carry 0 KB JS.
- After the owner step: `curl -sI <site>/errors/X_DB_DRIFT` has no `x-robots-tag: none`, and the sitemap lists it.
