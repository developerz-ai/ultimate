# 12 — Decisions a human makes before code moves

> Part of [`overview.md`](overview.md). Depends on: none; gates parts of 03, 04, 05, 07, 09. Tier: n/a.

Each row is a call the executor must not make alone. A recommendation is given; the decision is recorded in `status.yml` `notes` before the dependent slice runs.

| # | Decision | Evidence | Recommendation |
|---|---|---|---|
| 1 | **One major for four breaking changes**, or four majors | realtime `exports` split (04), `IdempotencyStore.settle(key, value, id)` (04), deleting `PwaConfig.installPrompt` / `AuthConfig.afterSignInPath` / `AiConfig.modelEnv` (05/01), removing `manifest`'s `canonical` export (05) | One major, 8.0.0; four `BREAKING —` rows; `wiki/Upgrading.md` count 4; `changelog-check` pins it |
| 2 | `@ultimat3/seo`'s unwired half — wire or delete | 11 exports with zero callers (`assertMeta`, `buildSitemap`, `sitemapUrls`, `chunk`, `buildRobots`, `isIndexable`, `indexableRoutes`, `expandRoute`, `isDynamic`, `renderPicture`, `inlineBlur`, `hreflangSet`); `routes.ts` is a second route model beside `render`'s registry and cannot consume it (tier 1) | **Wire**: `x new` scaffolds `site/sitemap.xml/route.ts` and `site/robots.txt/route.ts` calling `buildSitemap`/`buildRobots` over the CLI's `seo-meta.ts` adapter; `RouteRecord` becomes the sitemap's view of the table. Deleting removes a capability with no live equivalent |
| 3 | Dead config fields — wire or delete | `installPrompt` is `readonly` and **required**; `modelEnv`'s own comment says it does the inverse of its purpose; both tracked apps set them | Delete all three (the 4.0.0/5.0.0 precedent), one-line migration each; slice 09's `config-readers` check keeps the class out |
| 4 | Shared rate-limit / auth-limiter store | every limit is per-pod; charts ship 2–3 replicas; nothing shared exists; `postgresIdempotencyStore` is the shape | Ship `postgresRateLimitStore` + `postgresAuthLimiter` in `@ultimat3/auth`/`@ultimat3/http` over a `PgExecutor` seam; wire from `startWeb` via `RuntimeOverrides.rateLimitStore`; until then the warning in 07 |
| 5 | Floor rule — literal, declared-with-reason, or none | `render`/`ui` held level by axiom 6; `scraping` reserves room for `→ ai`; `policy` and `pwa` above floor with no written reason | Declared floor with reason (`FLOOR_ABOVE`, slice 09 step 9); move `pwa` to 2 (legal, lets `seo` stay below it); write `policy`'s sentence or move it to 1 |
| 6 | `x verify --only <step>` | every iteration is 18 s (14 s `tsc -b`); `verify-step.ts:60-65` argues "a knob, never a narrowing" deliberately; `x test … --worker N` proves scoping is possible | Add `--only`, print `NOT A GATE RUN` in the header and `--json`, exit with the step's own status; `x.verify.json` floor untouched. Green-means-shippable is preserved because the gate is still the no-flag run |
| 7 | `updateSignal` (`pwa/version-skew.ts:171`) | no runtime caller; `cmd-deploy.ts:150` names it as the wire behind `x deploy --critical` — a security-shaped flag that currently does nothing | Wire it in the same PR that makes `--critical` real, or delete both the export and the flag. Not this plan's call — filed as #289 |
| 8 | `render`'s `matchRoute` vs `http`'s trie | two exported matchers, different precedence; `http/src/stages.ts:164` is live; `render`'s has zero consumers | Delete `render`'s (`registry.ts:337-370`) unless `dev-render.ts` is meant to route through it |
| 9 | `invalidateWireTags`, `recentTierFailures` | zero callers; the first's sole consumer is `x cache bust`, a `PLANNED_COMMANDS` entry | Delete `invalidateWireTags` now, restore with `x cache`; wire `recentTierFailures` into `/_x` (deferred by #117) |
| 10 | `arrayOf(json())` / `arrayOf(bytes())` — refuse or encode | no tracked app uses either; encoding is two literal forms | Refuse at declaration (03 step 1) |
| 11 | `x new` runs `git init` | four surfaces assume a repo; `--no-git` escape | Yes, default on |
| 12 | `scaffold-smoke` follows printed fixes | the only assertion that would have caught the lint loop | Yes (08 step 5); accept the extra ~40 s on free runners |

## Done when
- Each row has a recorded decision in `status.yml` `notes` (`D1: one major` …) before the slice it gates starts.
