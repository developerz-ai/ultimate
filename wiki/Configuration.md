# Configuration

One file: `app.config.ts` at the repo root. There is no per-environment config directory, no `config/production.ts`, no `.env.local` cascade. Environment differences are **env vars**, validated once at boot.

Pre-v1. Field names may change until v1; `x upgrade` codemods them ([Upgrading](Upgrading)).

```ts
import { defineConfig, env } from '@ultimat3/core';
import { t } from '@ultimat3/schema';

export const config = defineConfig({
  name: 'postly',
  url: env.APP_URL,
  db: { url: env.DATABASE_URL },
  pwa: { offline: { fallback: '/offline' } },
  env: t.object({
    APP_URL: t.string.url,
    DATABASE_URL: t.string.url,
    SESSION_SECRET: t.string.atLeastLength(32),
  }),
});
```

Everything derivable from code is **not** in this file — routes, actions, policies, jobs, tags all live in the generated `x.manifest.json`. Inspect the resolved config with `x config show --json`.

## Top level

| field | type | default | notes |
|---|---|---|---|
| `name` | `string` | required | `^[a-z][a-z0-9-]{1,63}$`. Names the dev DB, the image, the queue prefix |
| `url` | `string` (URL) | required | canonical origin. Drives absolute SEO URLs, OAuth callbacks, `start_url` |
| `locales` | `string[]` | `['en']` | BCP-47. Every locale needs a complete catalog or `X_CATALOG_MISSING_KEYS` |
| `defaultLocale` | `string` | `'en'` | must appear in `locales` |
| `timeZone` | IANA zone | `'UTC'` | display default only; a user's own `tz` column always wins |
| `currency` | ISO 4217 | `'USD'` | default for `Money` formatting. Never a conversion rate |
| `env` | schema | required | typed env schema, see [Env vars](#env-vars) |

## `db`

| field | type | default | notes |
|---|---|---|---|
| `db.url` | `string` | required | always `env.DATABASE_URL`, never a literal |
| `db.pool` | `number` | `10` | per process. `web`×replicas + `worker`×concurrency must stay under Postgres `max_connections` |
| `db.ssl` | `boolean \| 'require'` | `false` | `'require'` on managed Postgres |
| `db.statementTimeout` | duration | `'10s'` | server-side cap; a longer query aborts with `X_TIMEOUT` |
| `db.entities` | module id | `'@app/db'` | where `entity()` declarations live; `db.schema` defaults to `'public'` |

## `auth`

Better Auth, wrapped. Sessions live in Postgres. Authorization is **not** here — it is [Policies and authz](Policies-And-Authz).

| field | type | default | notes |
|---|---|---|---|
| `auth.providers` | `Provider[]` | `['password']` | `password`, `google`, `github`, `apple`, `microsoft`. Each needs its env pair or boot fails |
| `auth.session.ttl` | duration | `'30d'` | absolute lifetime |
| `auth.session.renew` | duration | `'7d'` | rolling renewal window |
| `auth.session.cookie` | `string` | `'x_session'` | `HttpOnly`, `SameSite=Lax`, `Secure` outside dev |
| `auth.passkeys.enabled` | `boolean` | `false` | WebAuthn; `passkeys.rpName` defaults to `name` |
| `auth.trustedOrigins` | `string[]` | `[url]` | extra origins allowed to complete a flow |

## `jobs`

| field | type | default | notes |
|---|---|---|---|
| `jobs.driver` | `'pg' \| 'redis' \| 'nats'` | `'pg'` | `pg` needs no extra infra. Redis/NATS still use the outbox ([Jobs and workflows](Jobs-And-Workflows)) |
| `jobs.url` | `string` | — | required for `redis` / `nats` |
| `jobs.queues` | `string[]` | `['default']` | a `worker` runs one pool per queue in `WORKER_QUEUES` |
| `jobs.concurrency` | `number` | `8` | per pool, per process |
| `jobs.retry.attempts` | `number` | `5` | per-job `retry` overrides |
| `jobs.retry.backoff` | `'exponential' \| 'linear' \| 'fixed'` | `'exponential'` | always jittered |
| `jobs.visibilityTimeout` | duration | `'30s'` | lease length. Expiry is how a killed worker's job resumes |
| `jobs.retention.completed` | duration | `'24h'` | |
| `jobs.retention.failed` | duration | `'30d'` | dead-letter rows keep the full step trace |
| `jobs.retention.idempotencyKey` | duration | `'24h'` | dedupe window after terminal state |

## `realtime`

| field | type | default | notes |
|---|---|---|---|
| `realtime.tier` | `1 \| 2 \| 3` | `1` | tiers 1–2 in v1; tier 3 in v2 ([Realtime](Realtime)) |
| `realtime.transport` | `'memory' \| 'nats' \| 'redis'` | `'memory'` | `memory` = in-process, single node, dev and small deploys |
| `realtime.url` | `string` | — | required unless `memory`; missing → `X_CONFIG_INVALID` |
| `realtime.limits.perSocket` | `number` | `50` | subscriptions per socket. Exceeded → `X_SUBSCRIPTION_LIMIT` |
| `realtime.limits.perTenant` | `number` | `5000` | subscriptions per tenant |
| `realtime.limits.perTenantQueries` | `number` | `200` | distinct live queries per tenant. Exceeded → `X_LIVE_QUERY_LIMIT` |
| `realtime.changeBuffer.perQuery` | `number` | `512` | ring-buffer entries per query hash; a reconnect inside it is a delta, not a snapshot |
| `realtime.changeBuffer.window` | duration | `'60s'` | outside it the client re-snapshots (`X_CURSOR_STALE` if no snapshot path) |
| `realtime.drain.window` | duration \| `'auto'` | `'auto'` | `auto` derives the jitter window from live connection count |
| `realtime.drain.maxDelay` | duration | `'120s'` | ceiling on a server-directed `afterMs`; `realtime.heartbeat` defaults to `'15s'` |

## `cache`

Tiers are read in fixed order `memo → lru → redis → cdn → origin`. See [Caching and invalidation](Caching-And-Invalidation).

| field | type | default | notes |
|---|---|---|---|
| `cache.tiers` | `CacheTier[]` | `['memo', 'lru']` | subset of `memo`, `lru`, `redis`, `cdn`; order is fixed regardless of listing |
| `cache.memo.maxBytes` | size | `'8mb'` | per request, AsyncLocalStorage |
| `cache.lru.maxBytes` | size | `'64mb'` | per process. Treat hits as probabilistic |
| `cache.redis.url` | `string` | — | required if `redis` is in `tiers` |
| `cache.redis.maxBytes` | size | `'2gb'` | advisory; drives eviction warnings in `x doctor` |
| `cache.ttl.lru` | duration | `'60s'` | |
| `cache.ttl.redis` | duration | `'15m'` | |
| `cache.ttl.cdn` | duration | `'1h'` | emitted as `Cache-Control` + `stale-while-revalidate` |
| `cache.cdn.purge.webhook` | `string` | — | the only CDN coupling. Tag-driven purge-by-URL |
| `cache.cdn.purge.secretEnv` | `string` | — | env key holding the signing secret |

## `pwa`

`offline.fallback` is **required by the type — omitting it is a compile error.** A PWA without one shows the browser's dinosaur.

```ts
pwa: {
  offline: { fallback: '/offline' },   // required
}
```

| field | type | default | notes |
|---|---|---|---|
| `pwa.offline.fallback` | route path | **required** | scaffolded in `site/` at 0kb JS by `x new` |
| `pwa.icon` | file path | — | one SVG or >=1024px PNG. All icons, splashes, favicons generated from it |
| `pwa.precache.maxBytes` | size | `'3mb'` | a budget; exceeding it fails `x verify` |
| `pwa.retention.deploys` | `number` | `10` | asset retention, whichever is longer with `retention.window` |
| `pwa.retention.window` | duration | `'7d'` | |
| `pwa.push` | `{ enabled, vapid }` | `{ enabled: false }` | generates SW handler + subscription action + send job |
| `pwa.backgroundSync` | `{ enabled, queues }` | `{ enabled: false }` | wires the SW sync event to the mutator queue |
| `pwa.badging` | `{ enabled, count }` | `{ enabled: false }` | Chromium-only |
| `pwa.shareTarget` | `{ enabled, accept }` | `{ enabled: false }` | the target route gets a required policy |
| `pwa.fileHandlers` | `FileHandler[]` | `[]` | `{ action, accept }` — OS file association |
| `pwa.periodicSync` | `{ enabled }` | `{ enabled: false }` | rarely granted; always have a fallback path |

## `seo`

| field | type | default | notes |
|---|---|---|---|
| `seo.siteUrl` | `string` | `url` | absolute-URL base for sitemap, feeds, canonical, OG |
| `seo.sitemap` | `boolean` | `true` | generated from the route table |
| `seo.robots.allow` | `string[]` | `['/']` | |
| `seo.robots.disallow` | `string[]` | `['/app', '/admin', '/_x']` | |
| `seo.rss` | `{ title, route }` | — | one feed per declared route subtree |
| `seo.lighthouse.seo` | `number` | `100` | below → `x verify` fails |
| `seo.lighthouse.accessibility` | `number` | `95` | below → `x verify` fails |
| `seo.ogImage` | `{ template, size }` | `{ size: '1200x630' }` | rendered at build for static/ISR, on demand for SSR |

## `budgets`

Per surface, overridable per route via `budget` on `defineRoute`.

| field | type | default | notes |
|---|---|---|---|
| `budgets.site.js` | size | `'0kb'` | the 0kb baseline is structural, not aspirational |
| `budgets.site.lcp` | ms | `2000` | |
| `budgets.site.cls` | number | `0` | |
| `budgets.app.js` | size | `'150kb'` | |
| `budgets.app.lcp` | ms | `2500` | |
| `budgets.app.cls` | number | `0.1` | |
| `budgets.precache` | size | `'3mb'` | mirrors `pwa.precache.maxBytes` |

## `mail`, `storage`, `otel`

| field | type | default | notes |
|---|---|---|---|
| `mail.from` | `string` | required if mail is used | `Name <addr>` |
| `mail.driver` | `'smtp' \| 'log'` | `'log'` in dev, `'smtp'` otherwise | sends are always a `job` |
| `mail.url` | `string` | — | SMTP URL from env |
| `storage.driver` | `'s3' \| 'local'` | `'local'` in dev, `'s3'` otherwise | `s3` is `Bun.s3`; `local` is a directory |
| `storage.bucket` | `string` | — | required for `s3`; `local` uses `storage.dir`, default `'.x/storage'` |
| `otel.endpoint` | `string` | — | OTLP collector. Absent = spans still recorded, exported nowhere |
| `otel.sampling` | `number` | `0.1` | head sampling ratio; errors are always sampled. Tracing is **always on, not a flag** |

## `ai`, `i18n`, `mcp`

| field | type | default | notes |
|---|---|---|---|
| `ai.models` | `string[]` | `[]` | ordered; index 0 is primary |
| `ai.fallback` | `'ordered' \| 'none'` | `'ordered'` | a fallback is recorded in the OTel span, never silent |
| `ai.cache.semantic.threshold` | number | `0.97` | cosine similarity; never below `0.9` |
| `ai.cache.semantic.ttl` | duration | `'7d'` | |
| `ai.budget.perCall` | `Money` | — | `{ minor, currency }`. Exceeding throws before spending |
| `ai.budget.perTenantMonthly` | `Money` | — | |
| `i18n.catalogs` | module id | `'@app/i18n'` | flat key catalog; a miss renders `⟦key⟧` and fails `x verify` |
| `i18n.fallbackChain` | `boolean` | `false` | off by design — a silent English fallback hides a missing key |
| `mcp.expose` | `boolean` | `true` | the app's own MCP surface. Actions still opt in per `mcp.expose` |
| `mcp.server` | module id | — | the app's hand-written tools, on top of the generated ones |
| `mcp.devSocket` | `string` | `'ws://localhost:9229'` | `x dev` only. Never bound in `ROLE=web` |

## Env vars

One typed schema, in `app.config.ts`, validated at boot. A missing key fails in **~40ms** with `X_ENV_MISSING` — never a 500 an hour later.

| var | roles | required | notes |
|---|---|---|---|
| `ROLE` | all | no — default `web` | `web \| sync \| worker \| scheduler \| migrate \| replicator \| all`. Invalid → `X_ROLE_INVALID` |
| `DATABASE_URL` | all | yes | |
| `APP_URL` | `web`, `sync` | yes | must match `config.url`'s shape |
| `SESSION_SECRET` | `web`, `sync` | yes | >=32 chars |
| `WORKER_QUEUES` | `worker` | no — default `default` | comma-separated; one pool per name |
| `REALTIME_TRANSPORT_URL` | `sync`, `replicator` | if transport ≠ `memory` | missing → `X_TRANSPORT_UNAVAILABLE` at readiness |
| `REDIS_URL` | any tier-3 cache user | if `redis` in `cache.tiers` | |
| `BUILD_ID` | all | set by `x build` | content hash. Never a timestamp, never `latest` |
| `DRAIN_TIMEOUT` | all | no — default `30s` | must be <= the orchestrator's `stop_grace_period` |
| `LOG_LEVEL` | all | no — default `info` | `debug \| info \| warn \| error` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | all | no | overrides `otel.endpoint` |

Rules:

| Rule | Detail |
|---|---|
| Secrets are env or a mounted file | the framework never talks to a vendor secret API ([axiom 7](Home)) |
| `env.X` in `app.config.ts` reads through the schema | an unschema'd key is a `X_CONFIG_INVALID` at load |
| No runtime mutation | config is frozen after `defineConfig`; there is no `setConfig` |
| Same image, all environments | only env differs. That is what makes staging a real rehearsal ([Deployment](Deployment)) |

```
x config show --json      # resolved config, defaults applied
x doctor --json           # env + connectivity + version checks
x verify --json           # the gate
```

Error shapes: [Error codes](Error-Codes). Symptom-first fixes: [Troubleshooting](Troubleshooting).
