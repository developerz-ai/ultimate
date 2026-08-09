# Stack

One choice per layer. No alternatives, no adapters, no `driver:` config for things that are not deployment concerns.

## Locked

| Layer | Decision | Rationale |
|---|---|---|
| Runtime | Bun >= 1.3 (target 2.0), **only**. No Node APIs unless via `node:` and unavoidable. | natives replace whole dependency trees; one runtime means one perf profile to reason about |
| HTTP | thin layer over `Bun.serve` routes; own the lifecycle for ALS context / tracing / authz | policy must run on every surface — impossible if a third-party router owns the request |
| DB | Postgres + Drizzle | Postgres does queue, pubsub, vectors, logical replication. Drizzle's SQL is legible, so an agent reads the generated statement and self-corrects |
| Validation | Standard Schema interface; **ArkType** blessed, exposed as `t` | one schema drives runtime parse + TS type + OpenAPI + MCP tool schema |
| Auth | Better Auth, wrapped, with our `policy` layer on top | sessions/OAuth/passkeys are solved; authorization is ours because it must be identical in HTTP, WS, jobs, and MCP |
| Frontend | SolidJS 2 + our own minimal router | fine-grained reactivity → streaming shells cost ~0 hydration; the router must own render mode + offline strategy, so it can't be a dependency |
| Styling | **SCSS modules + design tokens** | build-time only, zero runtime, dark theme is a token flip. No Tailwind, no CSS-in-JS |
| Jobs | Postgres queue default; redis / nats drivers behind one interface | the outbox needs the same transaction as the write — only possible in-DB |
| Realtime | 3 tiers: channels → live queries → local-first. Own protocol, Zero-shaped mutators | one mutator shape at every rung; see [`03-realtime.md`](./03-realtime.md) |
| Transport | NATS (or Redis streams) for fanout; sync nodes stateless | no sticky sessions, so `sync` scales on connection count alone |
| Observability | OpenTelemetry, always on | not a flag. An agent debugging production needs traces that already exist |
| Money | integer minor units + ISO currency code, `Intl.NumberFormat` at the edge | `Money = { minor: number; currency: string }`. Never a float |
| Time | store UTC, format with `Intl.DateTimeFormat` + explicit IANA tz | a date formatted without a `timeZone` is a bug waiting for a user in Auckland |
| i18n | flat key catalog, loud misses (`⟦key⟧`), `Intl` for numbers/dates/money | a missing key must be visible in dev and a `x verify` failure, not silently English |

## What Bun natives replace

Each row is a dependency subtree that never enters the lockfile.

| Bun primitive | Replaces | Deps killed (approx) |
|---|---|---|
| `Bun.sql` | `pg`, `pg-pool`, `pg-connection-string`, `postgres`, connection-pool wrappers | ~8 |
| `Bun.redis` | `ioredis` / `redis` + its command/parser packages | ~5 |
| `Bun.s3` | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` + the AWS SDK core chain | ~25 |
| `Bun.serve` WebSockets | `ws`, `socket.io`, `engine.io`, `uWebSockets.js` | ~10 |
| `bun test` | `vitest` / `jest`, `@types/jest`, coverage + mock + snapshot plugins | ~30 |
| `Bun.build` | `esbuild`/`rollup`/`vite` + framework plugin + postcss chain | ~40 |
| `Bun.Transpiler` / macros | `ts-node`, `tsx`, `swc`, babel presets | ~15 |
| `@ultimat3/core` image (PNG/JPEG decode, resize, encode) | `sharp` + libvips native binary + `imagemin` plugins | ~12 |
| `Bun.password` | `bcrypt` / `argon2` native addons | ~4 |
| `Bun.file` / `Bun.write` | `fs-extra`, `graceful-fs`, `globby` | ~6 |
| `bun --hot` | `nodemon`, `concurrently`, HMR middleware | ~5 |

Order of magnitude: a conventional equivalent stack is ~1,200 transitive packages; Ultimate's target is **under 40 direct dependencies for the whole framework**. Fewer packages is not vanity — it is fewer install failures, fewer CVE pages, and a smaller surface for an agent to misread.

Costs, stated plainly: no native-addon packages, and long-running-process maturity is less proven than Node's. See [`15-risks.md`](./15-risks.md).

## Excluded

| Excluded | Instead |
|---|---|
| GraphQL | typed `action` + `query`; OpenAPI is generated |
| Multi-runtime (Node/Deno/workerd) | Bun only |
| Multi-ORM | Drizzle only |
| Tailwind / CSS-in-JS / a second CSS system | SCSS modules + tokens |
| React Server Components | Solid `stream` render mode + `<Suspense>` |
| A plugin API before v1 | fork the blessed path; extension points earn their way in |
| Vendor edge functions, KV, image loaders | containers + our cache tiers + standard CDN headers |
| ESLint + Prettier | Biome (one binary, one config) |
| A separate migration tool | `x db gen` / `x db apply`, drift is a `x verify` failure |

## Versions

`As of 2026-07`: Bun 1.3 is the floor, Bun 2.0 the target. SolidJS 2 is in beta — the router and UI kit are ours precisely because the ecosystem around Solid 2 is thin. ArkType and Drizzle are both pre-1.0-stable in places; pin exactly and treat their upgrades as framework work, not app work.
