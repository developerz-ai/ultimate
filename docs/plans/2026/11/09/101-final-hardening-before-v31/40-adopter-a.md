# 40 — Adopter A: upgrade to v31

> Part of [`overview.md`](overview.md). Depends on: [`39`](39-v31-release.md). **Edited from adopter A's own repository**, never from here. The letter → path mapping is kept off-tree with the owner (committed plans never name adopters). Run by an agent started in that repository, under its own `CLAUDE.md`.

## From
30.0.0 (installed node_modules 27.10.1)

## Steps
1. Bump every `@ultimat3/*` and `create-ultimate` to 31.0.0 in one commit; `bun install`.
2. Apply `wiki/Upgrading.md` 30 → 31 in this repo (ports into `apps/<app>/runtime.ts`, semconv dashboards, removed setters, rate-limit IPv6 keys, remote MCP tools opt-in, Sentry boot reporter).
3. Its Biome bump PR is red on `docker/helm/templates/*`, `docs/*.md`, `packages/ui/src/card.module.scss`: copy the scaffold's Biome excludes from this repo (`packages/cli/src/templates/scaffold-repo.ts`, fixed by #1031).
4. Fresh `bun install`; expect new `exercise` findings from the 30.x line.
5. Add the scaffolded `.github/dependabot.yml` grouping if absent ([`17`](17-cli-runtime.md) C6).
6. `bun run verify` (`x verify`) green; open a PR; CI green; merge.

## Done when
- The adopter pins 31.0.0 with no patch, no restated framework constant and no workaround this plan made obsolete; its gate is green on `main`.
