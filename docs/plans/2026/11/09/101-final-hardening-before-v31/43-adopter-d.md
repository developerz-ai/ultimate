# 43 — Adopter D: upgrade to v31

> Part of [`overview.md`](overview.md). Depends on: [`39`](39-v31-release.md). **Edited from adopter D's own repository**, never from here. The letter → path mapping is kept off-tree with the owner (committed plans never name adopters). Run by an agent started in that repository, under its own `CLAUDE.md`.

## From
^30.0.0 (lock 30.0.0)

## Steps
1. Bump every `@ultimat3/*` and `create-ultimate` to 31.0.0 in one commit; `bun install`.
2. Apply `wiki/Upgrading.md` 30 → 31 in this repo (ports into `apps/<app>/runtime.ts`, semconv dashboards, removed setters, rate-limit IPv6 keys, remote MCP tools opt-in, Sentry boot reporter).
3. Refresh the lock; Biome excludes (its dev-deps PR is red on lint/format).
4. Its `determinism` job failed on `setup-bun` (infra, not framework): recheck.
5. Add the scaffolded `.github/dependabot.yml` grouping if absent ([`17`](17-cli-runtime.md) C6).
6. `bun run verify` (`x verify`) green; open a PR; CI green; merge.

## Done when
- The adopter pins 31.0.0 with no patch, no restated framework constant and no workaround this plan made obsolete; its gate is green on `main`.
