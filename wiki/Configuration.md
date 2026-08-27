# Configuration

One file: `app.config.ts` at the repo root. There is no per-environment config directory, no `config/production.ts`, no `.env.local` cascade. Environment differences are **env vars**, validated once at boot.

`As of 2026-08-22`. Stable API — semver from here ([Upgrading](Upgrading)). Field names are covered by semver: renaming or removing one needs a major, and the entry in [Upgrading](Upgrading) names the edit. **There is no codemod** — `x upgrade` is a `PLANNED_COMMANDS` entry ([`packages/cli/src/cmd-planned.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/cli/src/cmd-planned.ts)), so every migration below is a hand edit.

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
  // No connection string and no pool size: both are env (`DATABASE_URL`, `DATABASE_POOL_MAX`),
  // read where the client is built, so the same image deploys to every environment.
  database: { ssl: true },
  // The tiers ARE the selection: naming `redis` is what builds the shared rung, and it reads
  // `REDIS_URL` — there is no second `driver` field to agree with, and no env key to name.
  cache: { tiers: ['request-memo', 'lru', 'redis'] },
  jobs: { queues: ['postly-default'], concurrency: 8 },
  pwa: { enabled: true, offline: 'runtime' },
});
```

**This example compiles.** It did not until 2026-08-22 — it passed `database: { urlEnv, poolSize }`, two keys deleted from `DatabaseConfig`, so the first thing an agent copied off this page was `TS2353`. Every table below is now derived from the interfaces in [`packages/core/src/config.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/core/src/config.ts) rather than curated beside them.

Everything derivable from code is **not** in this file — routes, actions, policies, jobs, tags all live in the generated `x.manifest.json`. Inspect the resolved config with `x config show --json`.

`AppConfigInput` ([`packages/core/src/config.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/core/src/config.ts)) carries exactly fourteen keys `As of 2026-08-22`: `name`, `locales`, `defaultLocale`, `defaultTimeZone`, `defaultCurrency`, `theme`, `auth`, `pwa`, `roles`, `database`, `cache`, `jobs`, `realtime`, `ai`. That type is the contract, and **every table below names only its members** — a block with no key here (`http`, `seo`, `budgets`, `mail`, `storage`, `otel`) is not an `app.config.ts` field and its section says where the real knob is instead.

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

`DatabaseConfig` is **two fields**, deliberately — the connection itself is env, not config.

| field | type | default | notes |
|---|---|---|---|
| `database.driver` | `'postgres'` | `'postgres'` | one driver; `postgresDriver()` from `@ultimat3/entity` is its only implementation |
| `database.ssl` | `boolean` | `false` | `true` on managed Postgres |
| ~~`database.urlEnv`~~ | — | — | **Deleted 2026-08.** `@ultimat3/db`'s `client.ts` reads `process.env['DATABASE_URL']` as a hardcoded literal, so a different key here could never be honoured. Migration: delete the key; the connection string is `DATABASE_URL` |
| ~~`database.poolSize`~~ | — | — | **Deleted 2026-08.** A second, non-functioning spelling of `DATABASE_POOL_MAX`, which `baseClient()` layers over the role profile and which works. Migration: delete the key; set `DATABASE_POOL_MAX`. The sizing rule is unchanged — the pool is per PROCESS, so keep `replicas × poolMax` under Postgres `max_connections` |
| ~~`database.schema`~~ | — | — | **Deleted 2026-08.** Nothing emits `SET search_path`. Migration: delete the key; there is no replacement, and `entity()` tables live in `public` |

Wiring the three instead would have needed a tier-0 → tier-1 read the tier table forbids. Deleting is axiom 3 applied to configuration: a value that produces neither a build error nor a runtime effect is worse than no field, because an SRE sets `poolSize: 3`, redeploys, and nothing changes.

### Read replicas

`As of 2026-08-24`. **Opt in twice**, and the second opt-in is the safety argument rather than an ergonomic one.

| Step | What it is | Without it |
|---|---|---|
| 1. the pool | `DATABASE_REPLICA_URL` names a read-only standby. `defaultClient()` reads it once and builds a primary + replica client; the replica inherits the role's pool profile and `DATABASE_POOL_MAX`, so a fleet sized against `max_connections` sizes against **two** servers | one pool, statement for statement what it always was |
| 2. the scope | `withReplicaReads(fn)` from `@ultimat3/db` — inside it, a statement that is provably a plain read may be answered by the standby | nothing routes, whatever is configured |

```ts
import { db, sql, withReplicaReads } from '@ultimat3/db';

declare const id: string;

await withReplicaReads(async () => {
  await db().query(sql`select id from posts limit 20`); // -> replica
  await db().execute(sql`insert into posts (id) values (${id})`);
  await db().query(sql`select id from posts limit 20`); // -> primary, for the rest of the scope
});
```

| Rule | Detail |
|---|---|
| read-your-writes | one write anywhere in the scope, at any depth, across any `await`, and every later read in it is the **primary's** for the rest of the scope. The flag is a mutable value on the async context, not a per-statement computation, which is what lets a write ten frames down be seen by the read after it |
| a transaction | always the primary. `reserve()` is delegated there, so `BEGIN`, the body and `COMMIT` are one connection on one server — a `BEGIN` that landed on a standby is not a transaction, it is `25006` on the first write inside it. A `readOnly: true` transaction leaves the scope unmarked |
| what is eligible | `select` / `table` / `values` / a read-only `with`, minus locking reads, `select … into` and the functions a standby answers instead of refusing. **Everything the classifier cannot vouch for is the primary's**, including `begin` and `set` |
| a replica that fails | the statement is re-run on the primary — exactly-once, because only plain reads are sent there and a `25006` refusal never executed. **Three consecutive failures park it for 10 seconds**, so an outage costs 3 doubled reads rather than every read |
| observability | `client.stats` (`replica`, `primary`, `fallbacks`, `parked`) and a `db.replica_fallback` warning per fallback |

**The URL must name a read-only standby.** The server's own `25006` is the safety net under a classifier that cannot be complete; pointed at a writable node, a misroute becomes a write on the wrong server, silently.

**Nothing opens the scope for you yet.** `withReplicaReads` ships first and wrapping a request in it is the app's call, so until that lands no production traffic is routed.


## `auth`

`AuthConfig` on `app.config.ts` is **one field**. Authorization is **not** here — it is [Policies and authz](Policies-And-Authz), and the authentication policy is `defineAuth()`, below.

| field | type | default | notes |
|---|---|---|---|
| `auth.signInPath` | `string \| null` | `null` | where a browser that failed `auth: 'required'` is sent. **`null` keeps the redirect off**, and that is the default on purpose: the framework may not invent one of its app's routes, and guessing `/login` would send every unauthenticated visitor to a 404. Null means the visitor gets the problem document — right for an agent, and what a browser got in production until this existed |
| ~~`auth.afterSignInPath`~~ | — | — | **Deleted in 8.0.0.** Declared, defaulted and merged, and read by no file — an app that set `/dashboard` got whatever its own sign-in route already did. Migration: delete the key, and send the visitor where you mean from the sign-in route itself, which is the only code that can honour it |

**The rest of authentication is `defineAuth()`, not `app.config.ts`** ([`packages/auth/src/auth.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/auth/src/auth.ts)). It takes an adapter and the policies, because each of them needs a value — a session store, a limiter, a clock — that a serialisable config field cannot carry:

| `defineAuth` key | shape | notes |
|---|---|---|
| `adapter` | `AuthAdapter` | required; where users and sessions are read and written |
| `session` | `Partial<SessionPolicy>` | `absoluteTtlMs` 30d, `idleTtlMs` 7d, `cookieName` **`'__Host-x_session'`**, `rotateOnPrivilegeChange` true. The `__Host-` prefix is a browser-enforced contract — Secure, `Path=/`, no `Domain` — so a subdomain (or an XSS on one) cannot overwrite it |
| `password` | `Partial<PasswordPolicy>` | |
| `rateLimit` | `Partial<AuthRateLimitPolicy>` | `scope: 'shared'` must be matched by a `limiter` that says the same, or `defineAuth` refuses at boot rather than at 3am on the first spray |
| `limiter` / `orgLimiter` | `AuthLimiter` | omitted means one process' worth of state, i.e. `maxAttempts × N` for N replicas |
| `mfa` | `Partial<AuthMfaPolicy>` | `required` is typed `false` and cannot be set true: both credential paths branch on `user.mfaSecret`, so a user who never enrolled would be locked out for good |
| `providers` | `OAuthProviderId[]` | **defaults to `[]`**, `As of 2026-08-23` — an empty list is "no OAuth", and every `/auth/oauth/<id>` answers `X_OAUTH_PROVIDER_UNKNOWN`. Never the live registry: that would let any dependency that calls `registerOAuthProvider` turn on a login route this app never enabled |
| `link` | `OAuthLinkPolicy` | defaults to `'verified-email'` |

There is no `auth.passkeys` and no `auth.trustedOrigins` in either place `As of 2026-08-22`.

## `jobs`

| field | type | default | notes |
|---|---|---|---|
| ~~`jobs.driver`~~ | — | — | **Deleted in 5.0.0.** It accepted `'postgres' \| 'redis' \| 'nats'` and was read by nothing: boot always built `createPgDriver`, so `jobs: { driver: 'redis' }` did not throw, did not warn, and silently gave you Postgres. Which driver runs is `setJobDriver(driver)` and only that — `setJobDriver(createPgDriver({ executor }))`, or `setJobDriver(createMemoryDriver())` in a test ([Jobs and workflows](Jobs-And-Workflows)) |
| `jobs.queues` | `string[]` | `['<name>-default']` | derived from `name`, not the literal `['default']`. A `worker` runs one pool per queue in `WORKER_QUEUES`. Empty is `X_CONFIG_INVALID` |
| `jobs.concurrency` | `number` | `8` | per pool, per process. Below 1 is `X_CONFIG_INVALID` |
| `jobs.maxAttempts` | `number` | `5` | per-job `retry` overrides it |
| `jobs.backoff` | `'exponential' \| 'fixed'` | `'exponential'` | **two values, not three** — there is no `'linear'` |
| `jobs.visibilityTimeoutMs` | `number` | `30000` | milliseconds, not a duration string. Lease length; expiry is how a killed worker's job resumes |

There is no `jobs.retry` object, no `jobs.visibilityTimeout` and no `jobs.retention` block `As of 2026-08-22` — `JobsConfig` is `{ queues, concurrency, maxAttempts, backoff, visibilityTimeoutMs }` and the flat spellings above are the whole surface.

## `realtime`

`RealtimeConfig` is three fields and no more `As of 2026-08-23` ([`packages/core/src/config.ts:123`](https://github.com/developerz-ai/ultimate/blob/main/packages/core/src/config.ts)):

| field | type | default | notes |
|---|---|---|---|
| `realtime.enabled` | `boolean` | `false` | off unless the app turns it on |
| `realtime.transport` | `'memory' \| 'nats' \| 'redis'` | `'memory'` | `memory` = in-process, single node, dev and small deploys. `redis` type-checks and is never built — `selectTransport` resolves in-process or NATS only |
| `realtime.urlEnv` | `string` | — | the **env key name**, never a URL. Required unless `memory`; missing → `X_CONFIG_INVALID` |

At runtime the transport is chosen by `NATS_URL` rather than by this field — the config documents intent, the env decides ([`17-scale-ladder.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/17-scale-ladder.md)).

**`realtime.tier` is gone**, `As of 2026-08-23` — the same shape as `jobs.driver` and
`realtime.heartbeatMs` before it. It accepted
`'channels' | 'live-queries' | 'local-first'`, defaulted to `'channels'` — and **nothing
read it**: no comparison, no branch, no dereference anywhere in `packages/*/src`. The only code
that touches `config.realtime` reads `.transport` and `.urlEnv`. So an app declaring
`tier: 'local-first'` got exactly what an app declaring `tier: 'channels'` got, and this page
documented per-value semantics the framework never had. Which realtime tier you are on is decided
by what you **declare** — a `channel()` topic, a `live: true` query, a local store — never by a
config key → [Realtime](Realtime). **Delete `tier:` from the `realtime` block in `app.config.ts`**;
that is the whole migration, and it is a typecheck fix rather than a runtime one, for the reason
the `heartbeatMs` paragraph below gives. `bun run scripts/config-readers.ts` is the ratchet that
now refuses the next one.

**`realtime.heartbeatMs` is gone**, `As of 2026-08-19`. It was declared here with a default of
15 000 and read by nothing; the socket beat is the client's `new LiveClient({ heartbeatMs })` —
browser code, which cannot read server config — and the presence beat is derived
(`PresenceRegistry.heartbeatMs` is `max(1000, floor(ttlMs / 3))`). **Removing the key from your
config is a typecheck fix, not a runtime one**: `section()` copies every own key of the patch and
`validate()` checks only the fields it names, so a leftover `heartbeatMs` is silently kept at
runtime. It fails at `x verify`'s `typecheck` step as `TS2353`, excess property on
`Input<RealtimeConfig>` — and an app that builds its config into a variable before passing it loses
excess-property checking and gets **no error at all** → [Known gaps](Known-Gaps).

**`realtime.limits.*`, `realtime.changeBuffer.*` and `realtime.drain.*` are not `app.config.ts` fields** `As of 2026-08-19`, and never were — `RealtimeConfig` is `{ enabled, transport, urlEnv }` ([`packages/core/src/config.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/core/src/config.ts)). Writing one is a typecheck failure, not a silent no-op, because the input type is `Input<RealtimeConfig>` and an unknown key is an excess property. The caps and the ring are **constructor options**, passed where the node is built:

| Option | Where | Default | Effect |
|---|---|---|---|
| `maxPerSocket` | `new LiveQueryRegistry({ … })` | `128` | subscriptions per socket. Exceeded → `X_SUBSCRIPTION_LIMIT`, scope `socket`. **Always applies** |
| `maxPerTenant` | same | none | subscriptions per tenant. Exceeded → `X_SUBSCRIPTION_LIMIT`, scope `tenant` |
| `tenantOf` | same | none | `(actor) => tenantId \| null`. **Required for `maxPerTenant` to do anything** — `assertCapacity` returns early when either is absent |
| `maxEntries` | same | `10000` | distinct `(query, input)` pairs this node will hold — a `qid` derives from client-chosen input, so each one is a matcher and a row window. Exceeded → `X_SUBSCRIPTION_LIMIT`, scope `node` |
| `maxTopicsPerSocket` | `new ChannelHub({ … })` | `64` | channel topics one socket may join. Exceeded → `X_SUBSCRIPTION_LIMIT`, scope `socket` |
| `maxTopicsPerNode` | same | `10000` | distinct topics this node bridges, one transport subscription each. Exceeded → `X_SUBSCRIPTION_LIMIT`, scope `node` |
| `maxBufferedBytes` | `createSyncNode({ … })` | `1 MiB`, exported as `DEFAULT_MAX_BUFFERED_BYTES` | outbound bytes queued on one socket before this node starts **dropping** its frames. A live-query patch is re-snapshotted; a channel frame is lost → [Realtime](Realtime) |
| `maxDroppedFrames` | same | `32` | drops one socket may take before it is closed with `1013` (`overloaded`), reason `backpressure` |
| `capacity` | `new RingChangeBuffer({ … })` | `1024` | retained patches per query hash; a reconnect inside the window is a delta, not a snapshot |
| `maxQueries` | same | `4096` | retained query hashes, least-recently-written dropped first |

**The per-tenant cap is reachable but not wired** `As of 2026-08`. It reads `socket.actor`, which was hardcoded `null` until WebSocket authentication landed, so it could not fire at all; and the boot ([`dev-roles.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/cli/src/dev-roles.ts)) passes `source: new RingChangeBuffer()` and **no caps**. So a per-tenant limit is not protecting you today whatever you configure — set `maxPerTenant` **and** `tenantOf` on the registry yourself if you need one. The per-socket cap needs nothing and is enforced at its default.

## `cache`

`CacheConfig` is **two flat fields**. See [Caching and invalidation](Caching-And-Invalidation).

| field | type | default | notes |
|---|---|---|---|
| `cache.defaultTtlMs` | `number` | `60000` | milliseconds, not a duration string |
| `cache.tiers` | `CacheTierName[]` | `['request-memo', 'lru']` | `'request-memo' \| 'lru' \| 'redis' \| 'cdn'`; order is fixed regardless of listing order, and a rung the environment cannot supply refuses the boot |
| ~~`cache.driver`~~ | — | — | **Deleted in 9.0.0.** It was the second way to ask for Redis and the losing one: the ladder is built from `cache.tiers`, so `driver: 'redis'` beside `tiers: ['request-memo', 'lru']` asked for a rung nothing built. Name `redis` in `tiers` |
| ~~`cache.urlEnv`~~ | — | — | **Deleted in 9.0.0**, `database.urlEnv`'s defect verbatim: the Redis tier reads the literal `REDIS_URL`, so `urlEnv: 'MY_REDIS'` made nothing read `MY_REDIS` |

**The per-tier byte caps and TTLs are constructor options, not config** — the same shape as the realtime caps above. `cache.memo.maxBytes`, `cache.lru.maxBytes`, `cache.redis.*` and `cache.ttl.*` are not fields and never were; writing one is `TS2353`, excess property on `Input<CacheConfig>`.

| Option | Where | Default | Effect |
|---|---|---|---|
| `maxBytes` | `createLruTier({ … })` | 64 MiB | byte budget for the whole tier; a single value over it is `X_CACHE_TOO_LARGE` rather than a silent drop |
| `defaultTtlMs` | same | `60_000` | applied when a `set` omits `ttlMs` |
| `jitterFraction` | same | `DEFAULT_TTL_JITTER_FRACTION` | TTL spread in `[0, 1)`; `0` disables it, which is how a stampede is reproduced in a test |
| `clock` / `rng` | same | system | injected so a jittered expiry is deterministic |
| `loadDeadlineMs` | `createCacheStack(tiers, { … })` | `30_000` | how long one `load()` may hold its key before a later reader starts its own. Frees the KEY, never the load — the wedged call runs on. Anchored to `http`'s own request timeout: a load still running at 30 s has no reader left to serve |
| `schedule` | same | `setTimeout` | injected so the deadline above is provable without a test waiting one out |

**One vocabulary names the tiers, `As of 2026-08-23`.** `CACHE_TIERS` in [`packages/core/src/cache-vocabulary.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/core/src/cache-vocabulary.ts) is `request-memo | lru | redis | cdn`, in ladder order — it **is** `TIER_ORDER`, which is what `sortTiers` orders a stack by, not a second list that agrees with it. Until 9.0.0 there were two: the config accepted `memo | lru | shared | isr | cdn` while the ladder built `request-memo | lru | redis | cdn`, so `memo`/`request-memo` and `shared`/`redis` were one rung spelled twice and **`isr` named a rung that did not exist** — it is a `RenderMode`, not a cache tier. `bun run render-modes` refuses a second declaration on the member set, so the two cannot re-diverge.

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

`offline` is an `OfflineStrategy` **string**, not an object. Three booleans, one strategy — every field is optional and every default is off.

```ts
pwa: { enabled: true, offline: 'runtime' },
```

| field | type | default | notes |
|---|---|---|---|
| `pwa.enabled` | `boolean` | `false` | **read by nothing, `As of 2026-08-27`** — on and off produce the identical build, because no target generates a service worker at all ([#362](https://github.com/developerz-ai/ultimate/issues/362)). Pinned as suspect by `bun run scripts/config-readers.ts` |
| `pwa.offline` | `'precache' \| 'runtime' \| 'network-only'` | `'network-only'` | the app-wide strategy; a `route` may narrow its own |
| `pwa.backgroundSync` | `boolean` | `false` | wires the SW sync event to the mutator queue |
| `pwa.push` | `boolean` | `false` | generates the SW handler, the subscription action and the send job |
| ~~`pwa.installPrompt`~~ | — | — | **Deleted in 8.0.0.** Declared, defaulted and merged, and read by nothing — `@ultimat3/pwa`'s `createInstallController` is real and complete and no code ever threaded this flag into it, so both tracked apps and every scaffolded app carried a switch with no wire. Migration: delete the key and call `createInstallController` from your own affordance ([PWA and offline](PWA-And-Offline)) |

## `http`

**Not an `app.config.ts` block, and never was.** `AppConfigInput` has no `http` key. `@ultimat3/core` is tier 0 and cannot hold `@ultimat3/http`'s types, so an `http` block here would be a **second declaration** of `HttpConfigInput` in a package that can never check it against the real one. An app declares its half with `configureHttp()`, at module scope in a file under `apps/*/` — the same seam `configureAuthenticator()` and `defineStorage()` are, and for the same reason.

Until 12.0.0 the whole tuning surface was **unreachable from a shipped app**: the only `HttpConfig` any framework-booted process built was one fixed literal inside the CLI, so `cors.origins` was `[]` in every deployment, `bodyLimitBytes` was 1 MiB for a 4 MB CSV endpoint and `rateLimit.buckets` was 120 burst / 2 rps for a bank and a blog alike. Shipped `fix:` lines across `@ultimat3/http` told the reader to edit `http.<key>` in `app.config.ts`, which has never held one — `bun run scripts/doc-config-keys.ts` is what now refuses that sentence in a doc.

```ts
// apps/web/http.ts — module scope. The app load imports every `apps/*/*.ts`, so this runs
// before any listener binds; `apps/web/server.ts` and `prerender.ts` are entry points and
// are deliberately NOT imported, so the call may not live in either.
import { configureHttp, DEFAULT_RATE_LIMIT } from '@ultimat3/http';

configureHttp({
  requestTimeoutMs: 120_000,
  bodyLimitBytes: 8 * 1_048_576,
  maxInflight: 2_000,
  cors: { origins: ['https://app.example.com'], credentials: true },
  csrf: { mode: 'origin' },
  rateLimit: {
    // The WHOLE table, never a patch: `buckets` replaces the default one rather than merging
    // into it, and a name nothing declares falls through to a built-in 120 / 2.
    buckets: {
      ...DEFAULT_RATE_LIMIT.buckets,
      login: { capacity: 5, refillPerSecond: 0.01 },
      tenant: { capacity: 5_000, refillPerSecond: 100 },
    },
    tenantBucket: 'tenant',
  },
});
```

| field | default | notes |
|---|---|---|
| `basePath` | `'/'` | stripped before matching, on a segment boundary — a mount at `/api` owns `/api` and `/api/…`, never `/apix` |
| `bodyLimitBytes` | `1_048_576` | enforced **while** the body streams, so a `transfer-encoding: chunked` payload is cancelled the instant the running total passes it |
| `requestTimeoutMs` | `30_000` | `0` disables. A caller may only **shorten** it, with `x-request-timeout-ms`; the framework's own typed clients send what is LEFT of the current request's budget |
| `maxInflight` | `1_000` | `0` disables. Past it a request is shed `X_OVERLOADED` **before** any work — no route match, no auth, no body |
| `drainTimeoutMs` | `null` | `null` means "this app has not said" and core's own deadline stands. Declaring it IS declaring the process-wide drain budget, so it overrides `configureLifecycle({ deadlineMs })` |
| `cors` | `origins: []`, `credentials: true` | `origins: ['*']` with `credentials: true` is `X_CORS_CONFIG_INVALID` at boot — no browser accepts the pair |
| `csrf` | `mode: 'origin'` | `'origin' \| 'off'`. `mode: 'token'` is deliberately not shipped |
| `security` | HSTS off until https is affirmed, CSP report-only in dev | `security.csp.extend` merges **per directive** with the boot's own hashes, so admitting a CDN source does not evict the hydration runtime's and lock every island out |
| `locale` / `tz` | header + cookie names | it decides WHERE the request's locale and zone are read from; `@ultimat3/i18n` and `@ultimat3/time` decide what they mean |
| `rateLimit` | `enabled`, `buckets`, `defaultBucket`, `tenantBucket: null` | `scope` is boot-owned (below). `tenantBucket` names a bucket a whole tenant spends **beside** the caller's own; a name `buckets` does not declare is `X_RATE_LIMIT_TENANT_BUCKET_UNKNOWN` at boot |

**Seven keys plus `rateLimit.scope` are boot-owned, and writing one is a compile error** — `AppHttpConfig` is `Omit<HttpConfigInput, BootOwnedHttpKey | 'rateLimit'>` with `rateLimit` re-added minus `scope`, so the refusal is `TS2353` at the call and never a value silently discarded at every boot:

| boot-owned key | what decides it |
|---|---|
| `port` / `hostname` | `PORT` and the role's binding |
| `dev` | `x dev`, or `ULTIMATE_ENV` |
| `buildId` | `BUILD_ID`, stamped by `x build` |
| `signInPath` | `auth.signInPath` in `app.config.ts` |
| `trustProxy` / `trustedProxyHops` | `TRUSTED_PROXY_HOPS` in the environment — one image runs behind an ingress in one cluster and behind nothing on a laptop, so an app that hardcoded it would be wrong in one of the two |
| `rateLimit.scope` | the store the boot installed. A literal here would be a second declaration quietly contradicting it, and `assertRateLimitScope` compares exactly those two halves |

An **embedder** that builds its own server — `createServer({ routes, config: defineHttpConfig({ … }) })` — passes the whole `HttpConfigInput`, boot-owned keys included, and owns every consequence: that is the one path on which `X_RATE_LIMIT_SCOPE_UNSET` and `X_TRUST_PROXY_UNSET` are reachable.

## `seo`

**Not an `app.config.ts` block.** There is no `seo` key on `AppConfigInput`. `@ultimat3/seo`'s builders take their options at the call site, from the route that renders them:

| Call | Options | Notes |
|---|---|---|
| `buildRobots(config)` | `baseUrl`, `environment?`, `groups?`, `sitemaps?`, `extra?` | **fail-closed**: only the exact string `production` opts a deploy into indexing, so staging, a laptop, a typo and an unset `ULTIMATE_ENV` all emit `Disallow: /` — a branch deploy that gets indexed outranks and cannibalises the real site. `environment` omitted resolves from `ULTIMATE_ENV`, and an unreadable one falls back to core's default rather than 500ing a `robots.txt` |
| `buildSitemap(routes, options)` | `baseUrl`, `locales?`, `localizePath?`, `defaultLocale?`, `maxUrls?`, `lastmod?` | splits into an index past `SITEMAP_MAX_URLS` (50,000). `maxUrls` must be a positive integer — `0` never advances the chunk cursor and used to allocate empty slices until the box ran out of memory |

`baseUrl` is the argument every one of them takes, so the canonical origin stays an env key the app reads (`APP_URL`) and never a config field. There is no `seo.lighthouse` gate and no `seo.ogImage` renderer `As of 2026-08-22`.

## `budgets`

**Not an `app.config.ts` block.** There is no `budgets` key on `AppConfigInput` and no per-surface default table. A budget is declared **per route**, as `budget` on `defineRoute` — `RouteBudget` in [`packages/render/src/route.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/render/src/route.ts):

**Two keys, `As of 2026-08-24`**, and both are optional:

| field | type | notes |
|---|---|---|
| `budget.js` | `string` | `'40kb'` — measured from the real bundle graph, not the source size. The one budget the framework weighs: `x build --target static` writes a `jsBytes` per prerendered route into `.x/build-stats.json`, counted off the emitted document's own `<script>` tags, and the `budgets` step compares against that |
| `budget.lcp` | `number` | milliseconds. **Published, not enforced** — it reaches `x.manifest.json` and `x routes`, and nothing in the framework produces an LCP measurement: `apps/web/prerender.ts` is the only writer of the stats file and it emits static HTML, so there is no browser in the build to observe a paint. The comparison is reachable only for an app that writes its own `lcpMs` rows, which is why `x new` no longer scaffolds an `lcp` budget |
| ~~`budget.css`~~ | — | **Deleted in 12.0.0**, with `budget.cls` and `budget.tbt`. All three were declared on the route contract for four majors, flattened away by `registerRoute` — which projects a budget to `budgetJs` + `budgetLcp` and nothing else — and read by no consumer anywhere, so `budget: { cls: 0.1 }` was accepted, normalised, stored and ignored while `x verify`'s `budgets` step, the one thing that exists to enforce a budget, reported green. Deleted rather than wired, for `pwa.installPrompt`'s reason: the measuring half does not exist either. Migration: delete the key |
| ~~`budget.cls`~~ | — | as above |
| ~~`budget.tbt`~~ | — | as above. A new budget key is now a **build error** until the descriptor projects it: `_EveryBudgetKeyIsProjected` in [`packages/render/src/type-pins.tsx`](https://github.com/developerz-ai/ultimate/blob/main/packages/render/src/type-pins.tsx) derives `'js' \| 'lcp'` from `RouteDescriptor`'s own `budgetJs`/`budgetLcp`, so neither side can move alone |

A declared budget with no measurement is itself a failure (`X_BUDGET_UNMEASURED`), never a pass — a route that clears the gate without being weighed is the false green axiom 5 exists to prevent — and the finding names the import chain that blew it, because "your bundle got bigger" is not actionable for a human or an agent. Only `render: 'static'` routes are weighed today; every other mode needs a running process. The **0 kb JS baseline on `site/`** is not a default in a table: a `site/` route off `hydrate: 'never'` with no `budget.js` is refused at registration, which is structural rather than aspirational.

The precache warning is its own number and not a budget: `DEFAULT_PRECACHE_WARN_BYTES` is 5 MiB, overridable per build as `warnBytes` ([`packages/pwa/src/precache.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/pwa/src/precache.ts)).

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

## `storage`

**Not an `app.config.ts` block.** There is no `storage` key on `AppConfigInput`. Storage is `defineStorage()`, called from `app.config.ts`, and it declares **named disks** (Laravel's model) rather than a driver and a bucket — so `disk('uploads').put(…)` never changes when `local` becomes `s3`:

```ts
defineStorage({ disks: { uploads: localDriver({ root: '.storage/uploads' }) } });
```

| `defineStorage` key | shape | notes |
|---|---|---|
| `disks` | `Record<string, StorageDriver>` | required and non-empty. Drivers are `localDriver({ root })` and `s3Driver({ … })` (`Bun.s3`) |
| `default` | `string` | the disk `disk()` resolves with no name. Defaults to the first declared disk; naming one that is not declared is `X_CONFIG_INVALID` |

Two disks may not share one driver **instance**: a driver learns its disk name at boot (`registerAs`) and mints signed URLs under it, so one instance told two names would 404 every URL it wrote under the first. Two disks over one root are two `localDriver()` calls. There is no `storage.dir` and no `storage.bucket` field.

## `otel`

**Not an `app.config.ts` block.** Tracing is **always on, not a flag**, and the wire is configured by the standard OpenTelemetry environment variables — which is what lets a collector be attached to a running image without a rebuild:

| var | notes |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP **JSON** only, port `:4318`. Absent = spans still recorded, exported nowhere. Invalid → `X_OTLP_ENDPOINT_INVALID` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `..._METRICS_ENDPOINT` | per-signal override |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | anything but `http/json` → `X_OTLP_PROTOCOL_UNSUPPORTED`, naming `:4318`. gRPC (`:4317`) needs HTTP/2 and protobuf and is out of scope |
| `OTEL_EXPORTER_OTLP_HEADERS` | percent-decoded, so `%zz` is `X_OTLP_HEADERS_INVALID` rather than a bare `URIError` at exporter construction. The header **key** appears in the cause and the fix; the **value** never does — it is the collector's credential |
| `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` | read at the **first span**, never at module scope. `configureTelemetry({ sampler })` is the programmatic form |

An empty `spanId` means "no inbound decision" and every reader honours it: a synthesised parent used to make the ratio sampler inherit a bit nobody sent, which exported **every HTTP root span at every ratio**.

## `notify`

Retention for `x_notify_inbox`, and **the only framework table whose window the framework refuses to
pick for you.** Every other one holds bookkeeping whose job ends — an idempotency key, a rate-limit
bucket, an auth challenge, a delivery claim — so a sweep is unambiguously right. An inbox row is a
message a person has not read yet, and when that disappears is a product decision (axiom 8).

| field | type | default | notes |
|---|---|---|---|
| `notify.inboxReadRetentionMs` | `number` | — | age of a row's `read_at`. A read row ages from when it was **read**, never from when it arrived |
| `notify.inboxUnreadRetentionMs` | `number` | — | age of an unread row's `created_at`. Setting this deletes messages nobody has read |

**Absent means never swept, and that is the default for both.** The failure mode of keeping rows is
a table that grows; the failure mode of guessing a number is a notification the recipient never got
to read. Two windows rather than one because the objection is specifically about *unread* messages —
an app that wants read notices gone in a month and unread ones kept forever writes exactly that:

```ts
notify: { inboxReadRetentionMs: 30 * 24 * 60 * 60 * 1000 }
```

Milliseconds and not a duration string: `DurationInput` lives in `@ultimat3/jobs` (tier 3) and
`AppConfig` is tier 0 — the same reason `cache.defaultTtlMs` and `jobs.visibilityTimeoutMs` are
spelled this way. A value that is not a positive finite number is `X_CONFIG_INVALID` at boot; zero
is refused rather than read as "immediately", because a sweep at age 0 is an inbox that silently
receives nothing.

**The sweep only runs against the Postgres inbox.** `createPgInboxStore` carries `purgeBefore`; the
memory inbox does not, and a boot that installed the memory one — or no inbox at all — sweeps
nothing and logs nothing. Installing the store is `setNotifyStores`, your app's boot line; the
framework applies the DDL either way.

**`x_notify_deliveries` has no config key**, deliberately. Its window is
`createPgDeliveryLedger({ executor, windowMs })`, stated beside the statement that reads it, and it
must **never be shorter than your idempotency window**: a job replayed inside the idempotency window
against a claim that has already been purged claims cleanly and sends the notification a second
time. Pass `idempotency.windowMs` and the two cannot disagree.

## `ai`

Two fields, and `ai.mcp` is where the app's own MCP surface is configured — there is no top-level `mcp` block.

| field | type | default | notes |
|---|---|---|---|
| `ai.mcp.expose` | `boolean` | `true` | the app's own MCP surface. Actions still opt in per action `mcp.expose` |
| `ai.mcp.path` | `string` | `'/mcp'` | where the HTTP transport mounts. Never bound in `ROLE=web` |
| ~~`ai.modelEnv`~~ | — | — | **Deleted in 8.0.0.** It named the env key holding the model id "so no model string is baked into the image", and its only reader was `defineConfig`'s own merge: `@ultimat3/ai` reads env for API keys only and the model is `request.model ?? DEFAULT_MODEL`, a compile-time constant. The one thing the key existed to prevent is what it delivered. Migration: delete the key and pass `model` on the request, reading your own env key if you want one |

`ai.models`, `ai.fallback`, `ai.cache` and `ai.budget` are per-`llm()` declarations, not config ([MCP and AI](MCP-And-AI)). i18n has no config block either: top-level `locales` and `defaultLocale` are the whole surface.

## Env vars

One typed schema, declared with `defineEnv` at module scope **in `app.config.ts`**, validated at boot. There is no `env.ts` — the one config file is also the one env gate. A missing or malformed key fails in **~40ms** with `X_ENV_MISSING`, every offender named in one error — never a 500 an hour later.

| var | roles | required | notes |
|---|---|---|---|
| `ROLE` | all | no — default `web` | exactly `web \| sync \| worker \| scheduler \| migrate \| replicator`. There is no `all`. Invalid → `X_ROLE_UNKNOWN` from the production boot path, `X_ROLE_INVALID` from `assertRole()` inside the framework |
| `PORT` | `web`, `sync` | no — default `3000` | the TCP port the role binds. Empty, non-numeric or outside 0–65535 → `X_PORT_INVALID`, refused rather than defaulted past, because a web role that quietly bound 3000 fails the platform's health probe with nothing in the log that names the cause |
| `ULTIMATE_ENV` | all | no — default `development` | `development \| test \| staging \| production`, read by `resolveEnvironment()`. `NODE_ENV` is a fallback only, and is never policed |
| `DATABASE_URL` | all | yes | |
| `DATABASE_REPLICA_URL` | all | no — unset is one pool | `As of 2026-08-24`: a read-only standby. Set it and `baseClient()` builds a primary + replica client; unset and the client is byte-identical to the single-pool one. Routing is still opt-in per scope (`withReplicaReads`), so setting it alone changes nothing — see [Read replicas](#read-replicas) |
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
| `TRUSTED_PROXY_HOPS` | `web`, `sync` | no — unset trusts no proxy header | how many proxies **append** to `x-forwarded-for` between the client and this process: 1 for a single ingress or ALB, 2 for a CDN in front of one. Integer 1–16; anything else is `X_PORT_INVALID`, refused rather than defaulted, because reading the header at the wrong index is trusting a value the client typed. Unset means `ctx.ip` is the socket address, `ctx.peer` is `null` and no inbound `x-request-id` is echoed |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | all | no | the OTLP collector. There is no `otel` config block for it to override — see [`otel`](#otel) |

Rules:

| Rule | Detail |
|---|---|
| Secrets are env or a mounted file | the framework never talks to a vendor secret API ([axiom 7](Home)) |
| `env.X` reads through `defineEnv`'s schema | a declared key that is missing or malformed is `X_ENV_MISSING` at boot, every offender in one error. A `process.env` read outside the schema is a lint error, never a runtime one |
| `X_CONFIG_INVALID` is env **and** `app.config.ts` | one code for a configuration that cannot boot: what `defineConfig`'s own validation throws — a bad locale, an unknown time zone, `jobs.concurrency < 1`, a `realtime.transport` other than `memory` with no `realtime.urlEnv`, a `cache.tiers` entry the environment cannot supply — and any env **combination** no boot can resolve, thrown by the selector that reads it. Both CDN pairs or half a pair (`selectPurgeDriver`), `SMTP_URL` + `RESEND_API_KEY` or a transport with no `MAIL_FROM` (`selectMailDriver`), or `REPLICATION_URL` naming a different host, port or database than `DATABASE_URL` (`selectChangeFeed`) |
| `X_ENV_MISSING` is one key, `X_CONFIG_INVALID` is the shape | absent or malformed key → `X_ENV_MISSING` at the `defineEnv` gate. Keys that each parse but contradict each other → `X_CONFIG_INVALID`. The two never overlap |
| No runtime mutation | config is frozen after `defineConfig`; there is no `setConfig` |
| Same image, all environments | only env differs. That is what makes staging a real rehearsal ([Deployment](Deployment)) |

## The environment — `resolveEnvironment()`

Four names, one env var, and a spelling the framework does not use is a refusal rather than a guess.

```ts
import { isLocal, isProduction, resolveEnvironment, tryResolveEnvironment } from '@ultimat3/core';

resolveEnvironment();                          // 'development' | 'test' | 'staging' | 'production'
resolveEnvironment({ fallback: 'production' });
resolveEnvironment({ env: someRecord });
tryResolveEnvironment() ?? 'development';      // the same, `undefined` instead of the throw
```

| Concern | Behaviour |
|---|---|
| Precedence | `ULTIMATE_ENV` if set and non-empty → `NODE_ENV` **only if it is one of the four** → `fallback` → `'development'` |
| Invalid `ULTIMATE_ENV` | throws `X_ENVIRONMENT_INVALID` — `prod`, `dev` and `preview` are all refusals |
| Invalid `NODE_ENV` | never throws. CI images legitimately set it to anything, so it is a fallback that is silently ignored, not a second gate |
| `isProduction()` | `=== 'production'` |
| `isLocal()` | `development` or `test`. **`staging` is deliberately excluded** — staging is a real rehearsal |
| `tryResolveEnvironment()` | the same resolution, `undefined` instead of the throw — and `undefined` means exactly one thing, an unrecognised `ULTIMATE_ENV`. For a caller that must **answer** rather than fail: `ULTIMATE_ENV` is not in the env schema, so nothing validates it at boot and a `robots.txt` render is routinely its first reader, where a typo would 500 the one response whose body was already going to be `Disallow: /`. It names no fallback of its own; the caller does |

`@ultimat3/core` is the **only** reader of `ULTIMATE_ENV` and `Environment` is the only spelling of a
deploy, `As of 2026-08`. `@ultimat3/seo` exported a second `resolveEnvironment` with its own union
through 1.2.0; as of 2.0.0 it exports neither that nor `SeoEnvironment`, and its `'preview'` is
`'staging'` → [Known gaps](Known-Gaps).

## `.env.example` — a projection, never a second list

```ts
import { renderEnvExample, assertEnvExample, ENV_EXAMPLE_PATH } from '@ultimat3/core';

await Bun.write(ENV_EXAMPLE_PATH, renderEnvExample(schema));      // '.env.example'
assertEnvExample(schema, await Bun.file(ENV_EXAMPLE_PATH).text()); // throws X_ENV_EXAMPLE_DRIFT
```

`renderEnvExample(schema, { extras })` returns the whole file, deterministic in declaration order. Per key it writes the description, then an annotation line — `required|optional · <type or enum values> · secret · role a/b` — then `KEY=<example>`. **A `secret: true` key's example is always empty**, even when the declaration has a default. `extras` are appended as commented `# NAME=` lines.

`assertEnvExample` throws `X_ENV_EXAMPLE_DRIFT` when the file is missing a declared key. Extra keys are reported but never fatal — an example may document more than the schema requires.

**Nothing calls it for you.** There is no verify step, CLI command or boot hook that checks the example; call it from a test of your own → [Known gaps](Known-Gaps).

Which files are read at boot: `.env` and `.env.<mode>` always, plus `.env.local` unless the mode is `test`. Mode is `production` or `test` verbatim, otherwise `development` — there is no `.env.staging`.

## Secrets in memory — `Secret`

A value that redacts **by value**, so it stays redacted under a key nobody thought to add to a deny-list.

```ts
import { secret, revealSecret, isSecret } from '@ultimat3/core';

const token = secret(process.env.API_TOKEN, 'API_TOKEN');

`${token}`;                    // '[redacted]'
JSON.stringify({ token });     // '{"token":"[redacted]"}'
logger.info('boot', { token }); // token=[redacted]
revealSecret(token);           // the real string — the one call that unwraps
```

| Surface | Redacted |
|---|---|
| `toString()` | ✅ |
| `toJSON()` | ✅ |
| `Symbol.toPrimitive` | ✅ — template literals and coercion |
| the Node inspect symbol | ✅ — `console.log`, `util.inspect` |
| the framework logger | ✅ — checked **before** every other branch, at any depth, under any key |
| spread / `Object.entries` / structured clone | ✅ — only `label` is enumerable, so the value cannot ride out |

Frozen and non-configurable. `revealSecret(value)` and `revealOptionalSecret(value)` are the only ways out; `isSecret(value)` is a structural brand check, so it survives two copies of `@ultimat3/core` in one tree.

Key-name redaction still exists and is separate: `defineEnv()` registers every `secret: true` key with the logger unless you pass `{ redact: false }`. And `checkEnv()` returns **real** values in `report.values` — anything that *prints* a report must pass them through `maskedEnvValues(schema, values)` first. That is the bug 1.1.0 fixed: `{ dsn: 'postgres://user:pw@host/db' }` printed the credential, because redaction was by key name and `dsn` was not on the list.

```
x doctor --json           # env + connectivity + version checks
x verify --json           # the gate
```

`x config show` is **planned**, not shipped — it throws `X_NOT_IMPLEMENTED` naming `x manifest --json` as the closest thing today → [CLI reference](CLI-Reference).

Error shapes: [Error codes](Error-Codes). Symptom-first fixes: [Troubleshooting](Troubleshooting). Metrics, spans and logs: [Observability](Observability).
