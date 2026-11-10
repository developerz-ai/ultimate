# 47 — Adopter H: upgrade to v31

> Part of [`overview.md`](overview.md). Depends on: [`39`](39-v31-release.md). **Edited from adopter H's own repository**, never from here. The letter → path mapping is kept off-tree with the owner (committed plans never name adopters). Run by an agent started in that repository, under its own `CLAUDE.md`.

## From
30.6.0

## Steps
1. Bump every `@ultimat3/*` and `create-ultimate` to 31.0.0 in one commit; `bun install`.
2. Apply `wiki/Upgrading.md` 30 → 31 in this repo (ports into `apps/<app>/runtime.ts`, semconv dashboards, removed setters, rate-limit IPv6 keys, remote MCP tools opt-in, Sentry boot reporter).
3. Its roadmap gaps doc: F2 streaming storage writes and F10 `WORKER_QUEUES` exist upstream — close them.
4. Fix its `X_QUERY_SCALES_WITH_ROWS` findings in its event dispatch job and sequence launch action (app N+1s surfaced by the 30.x `exercise` step, not framework bugs).
5. After [`15`](15-ai-mcp.md) I6: drop its hand-raised MCP `list_resources` budget (155,000) in its MCP endpoint test.
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
