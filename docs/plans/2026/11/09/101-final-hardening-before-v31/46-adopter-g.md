# 46 — Adopter G: upgrade to v31

> Part of [`overview.md`](overview.md). Depends on: [`39`](39-v31-release.md). **Edited from adopter G's own repository**, never from here. The letter → path mapping is kept off-tree with the owner (committed plans never name adopters). Run by an agent started in that repository, under its own `CLAUDE.md`.

## From
30.2.0

## Steps
1. Bump every `@ultimat3/*` and `create-ultimate` to 31.0.0 in one commit; `bun install`.
2. Apply `wiki/Upgrading.md` 30 → 31 in this repo (ports into `apps/<app>/runtime.ts`, semconv dashboards, removed setters, rate-limit IPv6 keys, remote MCP tools opt-in, Sentry boot reporter).
3. In its upstream-issues doc: §18 → `RouteMeta.socialCard` (#887); §19 → `site.favicon` (#894), then drop the `.ico`-only workaround; §20 → `page.activity()` (`packages/scraping/src/page.ts:146`) exists: retire its engine and client "bridges"; §26 shapes (a)/(b) → fixed by [`18`](18-admin-testing.md) T3.
4. After [`14`](14-render.md) P4 and [`08`](08-http.md) H10: delete its restated modal attribute and timezone-cookie constants; re-measure its island budget (the core error registry no longer rides along).
5. Its 881-line Sentry wrapper: replace with the framework hooks ([`02`](02-core-schema.md) K5) and the single boot reporter ([`17`](17-cli-runtime.md) C4); stop hiding `SENTRY_DSN` from the boot.
6. Add the scaffolded `.github/dependabot.yml` grouping if absent ([`17`](17-cli-runtime.md) C6).
7. `bun run verify` (`x verify`) green; open a PR; CI green; merge.

## Done when
- The adopter pins 31.0.0 with no patch, no restated framework constant and no workaround this plan made obsolete; its gate is green on `main`.

## Outcome (2026-11-10)
Done. Run from this adopter's own repository, in a git worktree.

| Step | Result |
|---|---|
| upgrade to 31.0.0 | done |
| upgrade to 31.2.0 | done; it picks up the field-report fixes listed in [`39`](39-v31-release.md#outcome-2026-11-10) |
| production | rolled by the coordinator and verified: pods on the new image, logs clean, sign-in redirect checked |
