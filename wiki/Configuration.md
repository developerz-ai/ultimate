# Configuration

One file: `app.config.ts` at the repo root. There is no per-environment config directory, no `config/production.ts`, no `.env.local` cascade. Environment differences are **env vars**, validated once at boot.

v1.0.0 `As of 2026-08`. Stable API — semver from here ([Upgrading](Upgrading)). Field names are covered by semver: renaming or removing one needs a major, and `x upgrade` codemods it.

```ts
import { defineConfig, defineEnv } from '@ultimat3/core';

// Module scope, in `app.config.ts` itself: the file is imported at boot, so the env gate runs
// before any listener binds. There is no separate `env.ts` — one config file means one.
export const env = defineEnv({
  APP_URL: { type: 'url' },
  DATABASE_URL: { type: 'url' },
  SESSION_SECRET: { type: 'string', secret: true },
});

export const config = defineConfig({
  name: 'postly',
  locales: ['en'],
  defaultLocale: 'en',
  defaultTimeZone: 'UTC',
  defaultCurrency: 'USD',
  // Env KEYS, never the value: the same image deploys to every environment.
  database: { urlEnv: 'DATABASE_URL', poolSize: 10 },
  jobs: { driver: 'postgres', queues: ['postly-default'], concurrency: 8 },
  pwa: { enabled: true, offline: 'runtime' },
});
```

Everything derivable from code is **not** in this file — routes, actions, policies, jobs, tags all live in the generated `x.manifest.json`. Inspect the resolved config with `x config show --json`.

`AppConfigInput` ([`packages/core/src/config.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/core/src/config.ts)) carries exactly thirteen keys `As of 2026-08`: `name`, `locales`, `defaultLocale`, `defaultTimeZone`, `defaultCurrency`, `theme`, `pwa`, `roles`, `database`, `cache`, `jobs`, `realtime`, `ai`. That type is the contract — a section below naming anything outside it describes a design-spec surface, not a field `defineConfig` accepts today.

## Top level

| field | type | default | notes |
|---|---|---|---|
| `name` | `string` | required | `^[a-z][a-z0-9-]{1,63}$`. Names the dev DB, the image, the queue prefix |
| `locales` | `string[]` | `['en']` | BCP-47. Every locale needs a complete catalog or `X_CATALOG_MISSING_KEYS` |
| `defaultLocale` | `string` | `'en'` | must appear in `locales` |
| `defaultTimeZone` | IANA zone | `'UTC'` | display default only; a user's own `tz` column always wins |
| `defaultCurrency` | ISO 4217 | `'USD'` | default for `Money` formatting. Never a conversion rate |
| `theme.defaultMode` | `'light' \| 'dark' \| 'system'` | `'system'` | `theme.tokens` is the semantic token map; raw hex is a lint error in components |
| `roles` | `Role[]` | every `ROLE` | which runtime roles this app runs. Empty is `X_CONFIG_INVALID` |

There is no `url` field. The canonical origin is an env key the app reads at its point of use (`APP_URL`), so the same image deploys to every environment.

## `database`

| field | type | default | notes |
|---|---|---|---|
| `database.urlEnv` | `string` | `'DATABASE_URL'` | the env **key** holding the connection string, never the string itself |
| `database.driver` | `'postgres'` | `'postgres'` | one driver; `postgresDriver()` from `@ultimat3/entity` is its only implementation |
| `database.poolSize` | `number` | `10` | per process. `web`×replicas + `worker`×concurrency must stay under Postgres `max_connections` |
| `database.ssl` | `boolean` | `false` | `true` on managed Postgres |
| `database.schema` | `string` | `'public'` | the Postgres schema `entity()` tables live in |

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
| `jobs.driver` | `'postgres' \| 'redis' \| 'nats'` | `'postgres'` | `postgres` needs no extra infra and is the only shipped production driver. **`redis` and `nats` are v2** — the stubs throw `X_NOT_IMPLEMENTED` ([Jobs and workflows](Jobs-And-Workflows)) |
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

### CDN purge

The purge driver is selected from the **environment**, not from a config field — the same law the
mail transports follow, and for the same reason: nothing loads `app.config.ts`'s contents at
runtime, so one image deploys to every environment.

| Key | Selects | Notes |
|---|---|---|
| `FASTLY_API_TOKEN` + `FASTLY_SERVICE_ID` | Fastly | batch surrogate-key purge, 256 keys per call |
| `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID` | Cloudflare | cache-tag purge, 30 tags per call, Enterprise zones |

The surrogate keys are the tags — `post`, `post:1` — so the edge purges exactly what
`invalidates: [tag.post]` busts.

| Failure | Code | Raised by | Lands |
|---|---|---|---|
| both pairs set — two CDNs claim one purge | `X_CONFIG_INVALID` | `selectPurgeDriver` | boot |
| half a pair — a token with no id, or an id with no token | `X_CONFIG_INVALID` | `selectPurgeDriver` | boot |
| the provider refused — 401, 429, `success: false` | `X_CACHE_PURGE_FAILED` | the purge driver | `report.errors`, never the write |

Half a pair is refused because "no CDN" is the one wrong reading — a deployment then ships
believing it purges. Both refusals name the keys that are actually set, never their values.

`X_CONFIG_INVALID` covers a configuration that cannot boot, env **or** `app.config.ts`
([Env vars](#env-vars)). `X_CACHE_PURGE_FAILED` is provider refusal only — never a configuration
problem, and never fatal to the write that triggered the bust.

`x dev` prints which one it installed — `cdn=none`, or `cdn=external(fastly via
FASTLY_API_TOKEN)`. The env **key** is reported, never its value.

## `pwa`

`offline` is an `OfflineStrategy` **string**, not an object. Five booleans, one strategy — every field is optional and every default is off.

```ts
pwa: { enabled: true, offline: 'runtime' },
```

| field | type | default | notes |
|---|---|---|---|
| `pwa.enabled` | `boolean` | `false` | off means no service worker is generated at all |
| `pwa.offline` | `'precache' \| 'runtime' \| 'network-only'` | `'network-only'` | the app-wide strategy; a `route` may narrow its own |
| `pwa.installPrompt` | `boolean` | `false` | render your own install affordance from the deferred event |
| `pwa.backgroundSync` | `boolean` | `false` | wires the SW sync event to the mutator queue |
| `pwa.push` | `boolean` | `false` | generates the SW handler, the subscription action and the send job |

## `seo`

| field | type | default | notes |
|---|---|---|---|
| `seo.siteUrl` | `string` | `env.APP_URL` | absolute-URL base for sitemap, feeds, canonical, OG |
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

## `mail`

Not an `app.config.ts` block. The transport is selected by **environment**, like every other
external service — an unset variable means the embedded default, so the same image deploys
everywhere and no credential is ever committed.

| env key | selects | notes |
|---|---|---|
| *(none set)* | memory | caught, never sent; the `/_x` mail panel reads this outbox |
| `SMTP_URL` | SMTP | `smtps://user:pass@host:465`, or `smtp://host:587` for STARTTLS |
| `RESEND_API_KEY` | Resend | one `POST /emails` per message, with an `Idempotency-Key` |
| `MAIL_FROM` | — | required by both transports. `Name <addr>`; also the envelope sender and the `Message-ID` domain |
| `MAIL_POOL_SIZE` | — | SMTP connections open at once. Default `4`, whole number ≥ 1 |

Setting `SMTP_URL` **and** `RESEND_API_KEY` is `X_CONFIG_INVALID`: a process delivers through
exactly one transport, and picking a winner would send half of an operator's mail the wrong way.
A transport without `MAIL_FROM` is refused at boot rather than on the first send.

`x dev` prints which one it installed — `mail=embedded`, or `mail=external(smtp via SMTP_URL)`.
The env **key** is reported, never its value, because `SMTP_URL` carries a password.

## `storage`, `otel`

| field | type | default | notes |
|---|---|---|---|
| `storage.driver` | `'s3' \| 'local'` | `'local'` in dev, `'s3'` otherwise | `s3` is `Bun.s3`; `local` is a directory |
| `storage.bucket` | `string` | — | required for `s3`; `local` uses `storage.dir`, default `'.x/storage'` |
| `otel.endpoint` | `string` | — | OTLP collector. Absent = spans still recorded, exported nowhere |
| `otel.sampling` | `number` | `0.1` | head sampling ratio; errors are always sampled. Tracing is **always on, not a flag** |

## `ai`

Three fields, and `ai.mcp` is where the app's own MCP surface is configured — there is no top-level `mcp` block.

| field | type | default | notes |
|---|---|---|---|
| `ai.modelEnv` | `string` | — | the env **key** for the model id, so no model string is baked into the image |
| `ai.mcp.expose` | `boolean` | `true` | the app's own MCP surface. Actions still opt in per action `mcp.expose` |
| `ai.mcp.path` | `string` | `'/mcp'` | where the HTTP transport mounts. Never bound in `ROLE=web` |

`ai.models`, `ai.fallback`, `ai.cache` and `ai.budget` are per-`llm()` declarations, not config ([MCP and AI](MCP-And-AI)). i18n has no config block either: top-level `locales` and `defaultLocale` are the whole surface.

## Env vars

One typed schema, declared with `defineEnv` at module scope **in `app.config.ts`**, validated at boot. There is no `env.ts` — the one config file is also the one env gate. A missing or malformed key fails in **~40ms** with `X_ENV_MISSING`, every offender named in one error — never a 500 an hour later.

| var | roles | required | notes |
|---|---|---|---|
| `ROLE` | all | no — default `web` | `web \| sync \| worker \| scheduler \| migrate \| replicator \| all`. Invalid → `X_ROLE_INVALID` |
| `DATABASE_URL` | all | yes | |
| `APP_URL` | `web`, `sync` | yes | the canonical origin. An app-read key, not a config field — declare it in `defineEnv` |
| `SESSION_SECRET` | `web`, `sync` | yes | >=32 chars |
| `WORKER_QUEUES` | `worker` | no — default `default` | comma-separated; one pool per name |
| `NATS_URL` | `sync`, `replicator` | no — unset is in-process fanout | one node only; a second replica shares nothing. Unreachable → `X_TRANSPORT_UNAVAILABLE` at boot, not at readiness |
| `NATS_KV_BUCKET` | `sync` | no — default `x_presence` | the JetStream KV bucket presence lives in. `[a-zA-Z0-9_-]+`; anything else is `X_TRANSPORT_PROTOCOL` at boot |
| `REPLICATION_URL` | `replicator` | no — defaults to `DATABASE_URL` | the connection the WAL is read from; this role must have `REPLICATION` privilege |
| `REPLICATION_SLOT` | `replicator` | no — default `x_replicator` | logical replication slot name |
| `REPLICATION_PUBLICATION` | `replicator` | no — default `x_changes` | the `pgoutput` publication the slot decodes |
| `REDIS_URL` | any tier-3 cache user | if `redis` in `cache.tiers` | |
| `BUILD_ID` | all | set by `x build` | content hash. Never a timestamp, never `latest` |
| `DRAIN_TIMEOUT` | all | no — default `30s` | must be <= the orchestrator's `stop_grace_period` |
| `LOG_LEVEL` | all | no — default `info` | `debug \| info \| warn \| error` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | all | no | overrides `otel.endpoint` |

Rules:

| Rule | Detail |
|---|---|
| Secrets are env or a mounted file | the framework never talks to a vendor secret API ([axiom 7](Home)) |
| `env.X` reads through `defineEnv`'s schema | a declared key that is missing or malformed is `X_ENV_MISSING` at boot, every offender in one error. A `process.env` read outside the schema is a lint error, never a runtime one |
| `X_CONFIG_INVALID` is env **and** `app.config.ts` | one code for a configuration that cannot boot: what `defineConfig`'s own validation throws — a bad locale, an unknown time zone, `poolSize < 1` — and any env **combination** no boot can resolve, thrown by the selector that reads it. Both CDN pairs or half a pair (`selectPurgeDriver`), `SMTP_URL` + `RESEND_API_KEY` or a transport with no `MAIL_FROM` (`selectMailDriver`), or `REPLICATION_URL` naming a different host, port or database than `DATABASE_URL` (`selectChangeFeed`) |
| `X_ENV_MISSING` is one key, `X_CONFIG_INVALID` is the shape | absent or malformed key → `X_ENV_MISSING` at the `defineEnv` gate. Keys that each parse but contradict each other → `X_CONFIG_INVALID`. The two never overlap |
| No runtime mutation | config is frozen after `defineConfig`; there is no `setConfig` |
| Same image, all environments | only env differs. That is what makes staging a real rehearsal ([Deployment](Deployment)) |

```
x config show --json      # resolved config, defaults applied
x doctor --json           # env + connectivity + version checks
x verify --json           # the gate
```

Error shapes: [Error codes](Error-Codes). Symptom-first fixes: [Troubleshooting](Troubleshooting).
