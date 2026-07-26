# Changelog

All notable changes to Ultimate. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Framework packages version in **lockstep** — a release bumps every `@ultimat3/*` package to the same version. See [PUBLISHING.md](PUBLISHING.md).

## [Unreleased]

### Added

- Repository foundation: monorepo layout, tier-enforced package boundaries, Biome + strict TypeScript, free-runner CI, npm OIDC trusted publishing.
- The eight primitives as typed package skeletons: `entity`, `policy`, `action`, `mutator`, `query`, `job`, `route`, `task`.
- `@ultimat3/core` — `UltimateError` and the error contract, ALS request context, typed env, roles, clock, structured logging, OpenTelemetry spans, graceful drain.
- `@ultimat3/schema` — Standard Schema interface with a built-in default provider and JSON Schema projection.
- `@ultimat3/http` — the owned `Bun.serve` lifecycle with an explicit, ordered request pipeline.
- `@ultimat3/action` — one declaration projecting to HTTP route, OpenAPI entry, typed client, MCP tool, job handle, and contract tests.
- `@ultimat3/jobs` — Postgres queue driver, durable steps with memoized replay, transactional outbox on by default, cron tasks with a required timezone.
- `@ultimat3/realtime` — tier 1 channels and presence, tier 2 live queries with per-subscriber policy, tier 3 offline queue and rebase.
- `@ultimat3/i18n` · `@ultimat3/money` · `@ultimat3/time` — the cross-cutting concerns, enforced rather than documented.
- `@ultimat3/ui` — SCSS-module design system with semantic tokens for both colour schemes.
- `@ultimat3/render` · `@ultimat3/pwa` · `@ultimat3/seo` — five render modes, generated service worker, build-error SEO gates.
- `@ultimat3/mcp` · `@ultimat3/ai` · `@ultimat3/manifest` — the AI-first layer, including the built-in MCP dev server.
- `@ultimat3/admin` — the `/_x` dev dashboard and `defineAdmin()` for generated apps.
- `@ultimat3/cli` — the `x` binary, and `create-ultimate` for `bunx create-ultimate myapp`.
- `examples/dummy` — the reference app exercising every primitive and every cross-cutting concern.
- Documentation: `docs/idea/` (design), `docs/architecture/` (internals), `wiki/` (reference), `site/` (GitHub Pages), `llms.txt`.

### Notes

Pre-alpha. Nothing here is production-ready. Milestones 0–5 are the path to usable — see [docs/idea/14-roadmap.md](docs/idea/14-roadmap.md). Remote drivers (Redis, NATS, real S3, Postgres logical replication) are interface-complete and throw `X_NOT_IMPLEMENTED` with a fix line rather than pretending to work.
