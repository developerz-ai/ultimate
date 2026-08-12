# 03 — The four CHANGELOG-named gaps

> Part of [`overview.md`](overview.md). Depends on: none. Tiers: 0 (`core`), 1 (`cache`, `seo`), 5 (`cli`), plus `docker/`.

All four 1.1.0 gaps verified still present (2026-08-12) and pinned in `wiki/Known-Gaps.md:9-12`.
Closing one = fixing code + deleting its Known-Gaps row + CHANGELOG entry.

## (a) `x build --target binary` crashes at import

- `packages/core/src/version.ts:37` — `FRAMEWORK_VERSION` resolved at module scope via `readFileSync` on `import.meta.dir/../package.json` (`:16,23-24`); missing file throws `X_INVARIANT` (`:27-33`). A compiled single-file binary has no such file.
- Fix: lazy accessor with a build-time define fallback (`Bun.build` `define`) or `Bun.embeddedFiles`; keep the throw only when both are absent. `packages/cli/src/cmd-build.ts:37` stays pointed at `apps/web/server.ts`.
- Test: a `scaffold-smoke`-style check that compiles and boots the binary — the gap existed because nothing executed the artifact.

## (b) compose publishes a host port on a replicated service

- `docker/docker-compose.prod.yml:28,33-34` (`ports: ['3000:3000']` + `replicas: 3`; same on `sync` at `:40-42`), propagated to `examples/dummy/docker/docker-compose.prod.yml:23-24`, and — worse — scaffolded into every new app by `packages/cli/src/templates/scaffold-container.ts:129-130`.
- Fix: front replicated services with the proxy service and `expose:`, or drop replicas to 1 with a comment pointing at the ops doc. Fix template first (every `x new` inherits it), then the three checked-in copies.

## (c) shared cache Lua `DEL`s undeclared keys

- `packages/cache/src/redis.ts:36-47` — `KEYS` carries tag-set keys only (`:120-124`); `:41` `DEL`s value keys discovered via `SMEMBERS` at runtime. Fails on Redis Cluster (cross-slot) and Dragonfly (strict declaration).
- Fix: two-phase — `SMEMBERS` from the client, then `DEL` with every key declared (accepting non-atomicity, documented) or hash-tag scheme `{tag}:key` for cluster slot affinity. Pick one; the Lua comment says why.
- Test: assert every key touched by the script appears in `KEYS` (recording redis fake).

## (d) `resolveEnvironment` × 2 with different semantics

- `packages/core/src/environment.ts:45` — `'development'|'test'|'staging'|'production'`, throws `X_ENVIRONMENT_INVALID` on unknown (`:49-55`). `packages/seo/src/robots.ts:32` — includes `'preview'`, lacks `'staging'`, silently maps unknown → `'preview'` (`:39`). With `ULTIMATE_ENV=staging` core says staging while seo de-indexes the site as preview. Both exported publicly (`core/src/index.ts:107`, `seo/src/index.ts:99`) — name collision.
- Fix: seo (tier 1) imports core's (tier 0) resolver and derives `SeoEnvironment` from `Environment` (`staging` → `preview` mapping stated in one place); seo stops exporting a `resolveEnvironment` name. One resolver, one throw policy (axiom 1).

## Done when

- Each gap: code fixed, failing-first test added, `wiki/Known-Gaps.md` row deleted, `CHANGELOG.md` entry written; `bun run verify` green.
