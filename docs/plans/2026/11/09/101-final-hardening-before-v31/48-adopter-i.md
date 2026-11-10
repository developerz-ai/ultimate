# 48 — Adopter I: upgrade to v31

> Part of [`overview.md`](overview.md). Depends on: [`39`](39-v31-release.md). **Edited from adopter I's own repository**, never from here. The letter → path mapping is kept off-tree with the owner (committed plans never name adopters). Run by an agent started in that repository, under its own `CLAUDE.md`.

## From
30.0.0

## Steps
1. Bump every `@ultimat3/*` and `create-ultimate` to 31.0.0 in one commit; `bun install`.
2. Apply `wiki/Upgrading.md` 30 → 31 in this repo (ports into `apps/<app>/runtime.ts`, semconv dashboards, removed setters, rate-limit IPv6 keys, remote MCP tools opt-in, Sentry boot reporter).
3. Biome excludes (Helm present).
4. Its raw-SQL guard already points to `keyset()`: no change.
5. Add the scaffolded `.github/dependabot.yml` grouping if absent ([`17`](17-cli-runtime.md) C6).
6. `bun run verify` (`x verify`) green; open a PR; CI green; merge.

## Done when
- The adopter pins 31.0.0 with no patch, no restated framework constant and no workaround this plan made obsolete; its gate is green on `main`.

## Outcome (2026-11-10)
Done. Run from this adopter's own repository, in a git worktree.

| Step | Result |
|---|---|
| upgrade to 31.0.0 | done |
| upgrade to 31.2.0 | done; it picks up the field-report fixes listed in [`39`](39-v31-release.md#outcome-2026-11-10) |
| production | none: it does not auto-roll production on merge, or has no live deploy |
