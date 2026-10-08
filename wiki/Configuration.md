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
  // No connection string and no pool size: both are env (`DATABASE_URL`, `DATABASE_POOL_MAX`),
  // read where the client is built, so the same image deploys to every environment.
  database: { ssl: true },
  // The tiers ARE the selection: naming `redis` is what builds the shared rung, and it reads
  // `REDIS_URL` — there is no second `driver` field to agree with, and no env key to name.
  cache: { tiers: ['request-memo', 'lru', 'redis'] },
  jobs: { queues: ['postly-default'], concurrency: 8 },
  pwa: { enabled: true, offline: { fallback: '/offline' } },
});
```

**This example compiles.** It did not until 2026-08-22 — it passed `database: { urlEnv, poolSize }`, two keys deleted from `DatabaseConfig`, so the first thing an agent copied off this page was `TS2353`. Every table below is now derived from the interfaces in [`packages/core/src/config.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/core/src/config.ts) rather than curated beside them.

Everything derivable from code is **not** in this file — routes, actions, policies, jobs, tags all live in the generated `x.manifest.json`. Inspect the resolved config with `x config show --json`.

`AppConfigInput` ([`packages/core/src/config.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/core/src/config.ts)) carries exactly these keys `As of 2026-10-06`: `name`, `theme`, `auth`, `pwa`, `roles`, `database`, `cache`, `jobs`, `realtime`, `notify`, `ai`, `drain`, `health`, `site`, `seo`, `navigation`, `islands`, `mail`. That type is the contract, and **every table below names only its members** — a block with no key here (`http`, `seo`, `budgets`, `mail`, `storage`, `otel`) is not an `app.config.ts` field and its section says where the real knob is instead.

**The shape is closed**, `As of 25.0.0`: a key `defineConfig` does not declare — at any depth, in `app.config.ts` or any `config/*.ts` overlay — is refused at boot with `X_CONFIG_INVALID`, naming the full path and the nearest real key (`drian is not an app.config.ts key — did you mean drain?`, fix `rename drian to drain in app.config.ts`). Before 25.0.0 `section()` copied an unknown key through and nothing read it, so a typo or a JS config that skipped the compiler was a switch with no wire. A key an earlier major **deleted** gets its own refusal first, naming the major and the replacement (`REMOVED_CONFIG_KEYS` in [`packages/core/src/config-removed.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/core/src/config-removed.ts)). The known keys are the defaults' own plus `SECTION_KEYS` in [`packages/core/src/config-keys.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/core/src/config-keys.ts) — the members with no default (`pwa.id`, `pwa.shortcuts[]`, `pwa.colors`, `mail.retainMime`, `navigation`), each row checked against its interface by `tsc`. The only positions whose keys an app chooses are `OPEN_CONFIG_PATHS`: the locale-keyed manifest texts (`pwa.description`, a shortcut's `name`/`shortName`/`description`, a screenshot's `src`/`label`). A key written as `undefined` is a layer not saying, and is never refused.

## Top level

| field | type | default | notes |
|---|---|---|---|
| `name` | `string` | required | `^[a-z][a-z0-9-]{1,63}$`. Names the dev DB, the image, the queue prefix |
| ~~`locales`~~ · ~~`defaultLocale`~~ | — | — | **Deleted in 25.0.0** — a second declaration of the app's locales. The one source is `defineCatalogs({ default: 'en', locales: { en, es } })` from `@ultimat3/i18n`: the keys are the locales, `default` the fallback. A config still writing either is refused at boot, `X_CONFIG_INVALID` naming the key and the replacement |
| ~~`defaultTimeZone`~~ | — | — | **Deleted in 25.0.0** — read by nothing but its own validator, and an ambient zone is what the framework forbids. Pass the zone at the call: `formatDate(at, { locale, zone })`, `task({ tz })`, the actor's `tz` (`userActor({ id, locale, tz })`). Refused at boot like the two above |
| ~~`defaultCurrency`~~ | — | — | **Deleted in 25.0.0** — read by nothing; every `Money` carries its own `currency`. An app that wants a default declares its own constant. Refused at boot like the three above |
| `theme.defaultMode` | `'light' \| 'dark' \| 'system'` | `'system'` | what a visitor with no stored choice gets. The boot inlines the no-flash theme script into every document with this as its fallback and admits it to the CSP — `As of 20.2.0`; before that the key was read by nothing. ~~`theme.tokens`~~ was **deleted in 25.0.0** (read by nothing; the theme is `export const brand = defineTheme(…)` from `@ultimat3/ui` in `apps/web/shared/theme.ts`) and is refused at boot |
| `roles` | `Role[]` | every `ROLE` | which runtime roles this app runs. Empty is `X_CONFIG_INVALID` |

There is no `url` field. The canonical origin is an env key the app reads at its point of use (`APP_URL`), so the same image deploys to every environment.

## `database`

`DatabaseConfig` is **two fields**, deliberately — the connection itself is env, not config.

| field | type | default | notes |
|---|---|---|---|
| `database.driver` | `'postgres'` | `'postgres'` | one driver; `postgresDriver()` from `@ultimat3/entity` is its only implementation |
| `database.ssl` | `boolean` | `false` | `true` on managed Postgres |
| ~~`database.urlEnv`~~ | — | — | **Deleted 2026-08.** Refused at boot since 25.0.0 (`X_CONFIG_INVALID`, naming the replacement). `@ultimat3/db`'s `client.ts` reads `process.env['DATABASE_URL']` as a hardcoded literal, so a different key here could never be honoured. Migration: delete the key; the connection string is `DATABASE_URL` |
| ~~`database.poolSize`~~ | — | — | **Deleted 2026-08.** Refused at boot since 25.0.0 (`X_CONFIG_INVALID`, naming the replacement). A second, non-functioning spelling of `DATABASE_POOL_MAX`, which `baseClient()` layers over the role profile and which works. Migration: delete the key; set `DATABASE_POOL_MAX`. The sizing rule is unchanged — the pool is per PROCESS, so keep `replicas × poolMax` under Postgres `max_connections` |
| ~~`database.schema`~~ | — | — | **Deleted 2026-08.** Refused at boot since 25.0.0 (`X_CONFIG_INVALID`, naming the replacement). Nothing emits `SET search_path`. Migration: delete the key; there is no replacement, and `entity()` tables live in `public` |

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
| ~~`auth.afterSignInPath`~~ | — | — | **Deleted in 8.0.0.** Refused at boot since 25.0.0 (`X_CONFIG_INVALID`, naming the replacement). Declared, defaulted and merged, and read by no file — an app that set `/dashboard` got whatever its own sign-in route already did. Migration: delete the key, and send the visitor where you mean from the sign-in route itself, which is the only code that can honour it |

**The rest of authentication is `defineAuth()`, not `app.config.ts`** ([`packages/auth/src/auth.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/auth/src/auth.ts)). It takes an adapter and the policies, because each of them needs a value — a session store, a limiter, a clock — that a serialisable config field cannot carry:

| `defineAuth` key | shape | notes |
|---|---|---|
| `adapter` | `AuthAdapter` | required; where users and sessions are read and written |
| `session` | `Partial<SessionPolicy>` | `absoluteTtlMs` 30d, `idleTtlMs` 7d, `cookieName` **`'__Host-x_session'`**, `rotateOnPrivilegeChange` true. The `__Host-` prefix is a browser-enforced contract — Secure, `Path=/`, no `Domain` — so a subdomain (or an XSS on one) cannot overwrite it |
| `password` | `Partial<PasswordPolicy>` | |
| `rateLimit` | `Partial<AuthRateLimitPolicy>` | `scope: 'shared'` must be matched by a `limiter` that says the same, or `defineAuth` refuses at boot rather than at 3am on the first spray |
| `limiter` / `orgLimiter` | `AuthLimiter` | omitted means one process' worth of state, i.e. `maxAttempts × N` for N replicas. An attempt is reserved before the KDF (`reserve` / `refund`), never checked and recorded after it |
| `mfa` | `Partial<AuthMfaPolicy>` | `required` is typed `false` and cannot be set true: both credential paths branch on `user.mfaSecret`, so a user who never enrolled would be locked out for good |
| `totpReplay` | `TotpReplayGuard` | which TOTP steps are spent, read by `completeMfa`. Omitted means `memoryTotpReplayGuard()`: in-process, so a code is single-use per replica |
| `providers` | `OAuthProviderId[]` | **defaults to `[]`**, `As of 2026-08-23` — an empty list is "no OAuth", and every `/auth/oauth/<id>` answers `X_OAUTH_PROVIDER_UNKNOWN`. Never the live registry: that would let any dependency that calls `registerOAuthProvider` turn on a login route this app never enabled |
| `link` | `OAuthLinkPolicy` | defaults to `'verified-email'` |

There is no `auth.passkeys` and no `auth.trustedOrigins` in either place `As of 2026-08-22`.

## `jobs`

| field | type | default | notes |
|---|---|---|---|
| ~~`jobs.driver`~~ | — | — | **Deleted in 5.0.0.** It accepted `'postgres' \| 'redis' \| 'nats'` and was read by nothing: boot always built the Postgres driver, so `jobs: { driver: 'redis' }` did not throw, did not warn, and silently gave you Postgres. Which driver runs is `setJobDriver(driver)` and only that — `setJobDriver(postgresJobDriver({ executor }))`, or `setJobDriver(memoryJobDriver())` in a test ([Jobs and workflows](Jobs-And-Workflows)). Since 25.0.0 a config still writing it is refused at boot, `X_CONFIG_INVALID` naming that call |
| `jobs.queues` | `string[]` | `['<name>-default']` | derived from `name`, not the literal `['default']`. A `worker` serves these **and** every queue a registered `job()` is enqueued on (the union, so a job naming no queue is never stranded on `default`). A Deployment that sets [`WORKER_QUEUES`](#env-vars) serves exactly that list instead. Empty is `X_CONFIG_INVALID` |
| `jobs.concurrency` | `number \| Record<queue, number>` | `8` (`JOBS_CONCURRENCY_DEFAULT`) | slots per queue, per worker process. A number applies to every queue served; a table gives each its own (`{ banks: 4, 'banks-long': 2 }`), and a served queue the table does not name runs at `8`. `As of 25.0.0`. A count below 1 or not whole, an empty table or a blank queue name is `X_CONFIG_INVALID` naming the entry (`jobs.concurrency.banks`). An overlay's table replaces the base's whole |
| `jobs.maxAttempts` | `number` | `5` | per-job `retry` overrides it |
| `jobs.backoff` | `'exponential' \| 'fixed'` | `'exponential'` | **two values, not three** — there is no `'linear'` |
| `jobs.visibilityTimeoutMs` | `number` | `30000` | milliseconds, not a duration string. Lease length; expiry is how a killed worker's job resumes |

There is no `jobs.retry` object, no `jobs.visibilityTimeout` and no `jobs.retention` block `As of 2026-08-22` — `JobsConfig` is `{ queues, concurrency, maxAttempts, backoff, visibilityTimeoutMs }` and the flat spellings above are the whole surface.

**Splitting queues across Deployments** (`As of 25.0.0`). Every Deployment runs the same image and the same `app.config.ts`, so which queues a Deployment claims is env, never config:

```yaml
# worker-short: 15 min grace          # worker-long: 2 h grace
ROLE: worker                          ROLE: worker
WORKER_QUEUES: banks                  WORKER_QUEUES: banks-long
```

Each worker then claims its list and nothing else. At boot it logs `jobs.worker.queue-unserved` (a warning, not a refusal) naming every queue a registered job is enqueued on that it will not claim, so a queue no Deployment serves is visible in the first log line rather than as a backlog. `x jobs list --json` shows each queue's workers.

## `realtime`

`RealtimeConfig` is five fields and no more `As of 2026-10-05` ([`packages/core/src/config.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/core/src/config.ts)):

| field | type | default | notes |
|---|---|---|---|
| `realtime.enabled` | `boolean` | `true` | **on by default since 22.0.0**, when the boot began obeying the key: an app with no `realtime` section keeps the `sync` node it always got. `enabled: false` is the opt-out — for an app that declares no `channel()` topic and no `live: true` query |
| `realtime.transport` | `'memory' \| 'nats' \| 'redis'` | `'memory'` | `memory` = in-process, single node, dev and small deploys. `redis` type-checks and is never built — `selectTransport` resolves in-process or NATS only |
| `realtime.urlEnv` | `string` | — | the **env key name**, never a URL. Required unless `memory`; missing → `X_CONFIG_INVALID` |
| `realtime.maxSubscriptionsPerActor` | `number` | unset = `1000` | live-query subscriptions one actor may hold on one `sync` node, **across all its sockets**. An anonymous socket counts against the client NETWORK resolved at the upgrade — an IPv4 address exactly, an IPv6 address by its /64, an IPv4-mapped IPv6 as its IPv4 (`TRUSTED_PROXY_HOPS` honoured, as `ctx.ip` is). Exceeded → `X_SUBSCRIPTION_LIMIT`, scope `actor`. A whole number ≥ 1, else `X_CONFIG_INVALID` |
| `realtime.maxSocketsPerActor` | `number` | unset = `16` | sockets one signed-in actor may hold on one `sync` node. An anonymous NETWORK (keyed exactly as above) gets **8 ×** this — 128 at the default — because it is often many people: one office behind a corporate NAT viewing a public live page. The next upgrade is refused before a socket exists: `429 X_SOCKET_LIMIT`. Closing a socket frees its slot. 16 × the per-socket 128 subscriptions passes the 1,000 above, so normal tabs hit neither. A whole number ≥ 1, else `X_CONFIG_INVALID` |

**Behind a proxy, set `TRUSTED_PROXY_HOPS`.** An anonymous socket is keyed by the client network the upgrade resolved (IPv6 grouped by /64, so one host cannot rotate through its block for fresh budgets). With nothing trusted, that address is the proxy's own, so every anonymous visitor shares ONE 1,000-subscription and 128-socket budget — the same failure as the anonymous rate-limit bucket. A socket that names no actor and no address at all shares one `address:unknown` budget. That fails closed: those sockets are still bounded, just together.

**Why 1,000.** A node holds at most 10,000 live windows (`maxEntries`) and a socket 128 subscriptions, so before this cap one actor with 79 sockets filled the node and every other user's next subscribe was refused. A tenth of the node keeps any one principal out of reach of the node cap, and still fits eight tabs at the per-socket 128. Raise it for an app whose single users legitimately watch more; lower it for a public, anonymous surface:

```ts
// app.config.ts
export const config = defineConfig({ name: 'shop', realtime: { maxSubscriptionsPerActor: 200 } });
```

Since 22.0.0 the transport is chosen by `realtime.transport`, never by `NATS_URL` alone — the config decides, the env supplies the URL `realtime.urlEnv` names. `'memory'` with `NATS_URL` set, and `'nats'` with the named variable unset, are both `X_CONFIG_INVALID` at boot ([`17-scale-ladder.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/17-scale-ladder.md)).

**`realtime.tier` is gone**, `As of 2026-08-23` — the same shape as `jobs.driver` and
`realtime.heartbeatMs` before it. It accepted
`'channels' | 'live-queries' | 'local-first'`, defaulted to `'channels'` — and **nothing
read it**: no comparison, no branch, no dereference anywhere in `packages/*/src`. The only code
that touches `config.realtime` reads `.transport` and `.urlEnv`. So an app declaring
`tier: 'local-first'` got exactly what an app declaring `tier: 'channels'` got, and this page
documented per-value semantics the framework never had. Which realtime tier you are on is decided
by what you **declare** — a `channel()` topic, a `live: true` query, a local store — never by a
config key → [Realtime](Realtime). **Delete `tier:` from the `realtime` block in `app.config.ts`**;
that is the whole migration. Since 25.0.0 a stale `tier:` is also refused at boot
(`realtime.tier was removed in 10.0.0`), where before it was a typecheck error only. `bun run scripts/config-readers.ts` is the ratchet that
now refuses the next one.

**`realtime.heartbeatMs` is gone**, `As of 2026-08-19`. It was declared here with a default of
15 000 and read by nothing; the socket beat is the page socket's own 10 s,
fixed in browser code, which cannot read server config, and the presence beat is derived
(`PresenceRegistry.heartbeatMs` is `max(1000, floor(ttlMs / 3))`). **A config still writing the key
is refused at boot since 25.0.0** (`realtime.heartbeatMs was removed in 4.0.0`,
`X_CONFIG_INVALID`). Before 25.0.0 `section()` copied every own key of the patch, so a leftover
`heartbeatMs` was silently kept at runtime and only `TS2353` caught it — never for an app that built
its config into a variable first.

**`realtime.limits.*`, `realtime.changeBuffer.*` and `realtime.drain.*` are not `app.config.ts` fields** `As of 2026-08-19`, and never were — `RealtimeConfig` is `{ enabled, transport, urlEnv, maxSubscriptionsPerActor, maxSocketsPerActor }` ([`packages/core/src/config.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/core/src/config.ts)). Writing one is a typecheck failure (`TS2353`, excess property on `Input<RealtimeConfig>`) and, since 25.0.0, a boot refusal (`X_CONFIG_INVALID`, the closed shape above) for a config the compiler never saw. The caps and the ring are **constructor options**, passed where the node is built:

| Option | Where | Default | Effect |
|---|---|---|---|
| `maxPerSocket` | `new LiveQueryRegistry({ … })` | `128` | subscriptions per socket. Exceeded → `X_SUBSCRIPTION_LIMIT`, scope `socket`. **Always applies** |
| `maxPerTenant` | same | none | subscriptions per tenant. Exceeded → `X_SUBSCRIPTION_LIMIT`, scope `tenant` |
| `tenantOf` | same | none | `(actor) => tenantId \| null`. **Required for `maxPerTenant` to do anything** — `assertCapacity` returns early when either is absent |
| `maxPerActor` | same | `1000` | subscriptions per actor (anonymous: per resolved client address) across its sockets. Exceeded → `X_SUBSCRIPTION_LIMIT`, scope `actor`. **Always applies**; the boot passes `realtime.maxSubscriptionsPerActor` |
| `maxEntries` | same | `10000` | distinct `(query, input)` pairs this node will hold — a `qid` derives from client-chosen input, so each one is a matcher and a row window. Exceeded → `X_SUBSCRIPTION_LIMIT`, scope `node` |
| `maxTopicsPerSocket` | `new ChannelHub({ … })` | `64` | channel topics one socket may join. Exceeded → `X_SUBSCRIPTION_LIMIT`, scope `socket` |
| `maxTopicsPerNode` | same | `10000` | distinct topics this node bridges, one transport subscription each. Exceeded → `X_SUBSCRIPTION_LIMIT`, scope `node` |
| `maxSocketsPerActor` | `syncNode({ … })` | `16` | sockets per actor at the upgrade; an anonymous network gets 8 × it (`ANONYMOUS_SOCKET_MULTIPLIER`). Exceeded → `429 X_SOCKET_LIMIT`. **Always applies**; the boot passes `realtime.maxSocketsPerActor` |
| `maxBufferedBytes` | `syncNode({ … })` | `1 MiB`, exported as `DEFAULT_MAX_BUFFERED_BYTES` | outbound bytes queued on one socket before this node starts **dropping** its frames. A live-query patch is re-snapshotted; a channel frame is lost → [Realtime](Realtime) |
| `maxDroppedFrames` | same | `32` | drops one socket may take before it is closed with `1013` (`overloaded`), reason `backpressure` |
| `capacity` | `new RingChangeBuffer({ … })` | `1024` | retained patches per query hash; a reconnect inside the window is a delta, not a snapshot |
| `maxQueries` | same | `4096` | retained query hashes, least-recently-written dropped first |

**The per-socket and per-actor caps are enforced by every boot; the per-tenant cap is opt-in** `As of 2026-10-04`. The `sync` role ([`role-sync.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/cli/src/role-sync.ts)) passes `realtime.maxSubscriptionsPerActor` into the registry, or leaves the registry's 1,000. It sets **no tenant cap**: one tenant is one person and the next is five thousand seats, so no default is defensible — set `maxPerTenant` **and** `tenantOf` on the registry yourself if you need one (either alone arms nothing).

## `cache`

`CacheConfig` is **two flat fields**. See [Caching and invalidation](Caching-And-Invalidation).

| field | type | default | notes |
|---|---|---|---|
| `cache.defaultTtlMs` | `number` | `60000` | milliseconds, not a duration string |
| `cache.tiers` | `CacheTierName[]` | `['request-memo', 'lru']` | `'request-memo' \| 'lru' \| 'redis' \| 'cdn'`; order is fixed regardless of listing order, an EMPTY list is refused (`X_CONFIG_INVALID`), and a rung the environment cannot supply refuses the boot |
| ~~`cache.driver`~~ | — | — | **Deleted in 9.0.0.** Refused at boot since 25.0.0 (`X_CONFIG_INVALID`, naming the replacement). It was the second way to ask for Redis and the losing one: the ladder is built from `cache.tiers`, so `driver: 'redis'` beside `tiers: ['request-memo', 'lru']` asked for a rung nothing built. Name `redis` in `tiers` |
| ~~`cache.urlEnv`~~ | — | — | **Deleted in 9.0.0** and refused at boot since 25.0.0, `database.urlEnv`'s defect verbatim: the Redis tier reads the literal `REDIS_URL`, so `urlEnv: 'MY_REDIS'` made nothing read `MY_REDIS` |

**The per-tier byte caps and TTLs are constructor options, not config** — the same shape as the realtime caps above. `cache.memo.maxBytes`, `cache.lru.maxBytes`, `cache.redis.*` and `cache.ttl.*` are not fields and never were; writing one is `TS2353`, excess property on `Input<CacheConfig>`, and `X_CONFIG_INVALID` at boot.

| Option | Where | Default | Effect |
|---|---|---|---|
| `maxBytes` | `lruTier({ … })` | 64 MiB | byte budget for the whole tier; a single value over it is `X_CACHE_TOO_LARGE` rather than a silent drop |
| `defaultTtlMs` | same | `60_000` | applied when a `set` omits `ttlMs` |
| `jitterFraction` | same | `DEFAULT_TTL_JITTER_FRACTION` | TTL spread in `[0, 1)`; `0` disables it, which is how a stampede is reproduced in a test |
| `clock` / `rng` | same | system | injected so a jittered expiry is deterministic |
| `loadDeadlineMs` | `cacheStack(tiers, { … })` | `30_000` | how long one `load()` may hold its key before a later reader starts its own. Frees the KEY, never the load — the wedged call runs on. Anchored to `http`'s own request timeout: a load still running at 30 s has no reader left to serve |
| `schedule` | same | `setTimeout` | injected so the deadline above is provable without a test waiting one out |

**One vocabulary names the tiers, `As of 2026-08-23`.** `CACHE_TIERS` in [`packages/core/src/cache-vocabulary.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/core/src/cache-vocabulary.ts) is `request-memo | lru | redis | cdn`, in ladder order — it is what `@ultimat3/cache`'s `sortTiers` orders a stack by, imported, not a second list that agrees with it (the `TIER_ORDER` alias was deleted in 25.0.0). Until 9.0.0 there were two: the config accepted `memo | lru | shared | isr | cdn` while the ladder built `request-memo | lru | redis | cdn`, so `memo`/`request-memo` and `shared`/`redis` were one rung spelled twice and **`isr` named a rung that did not exist** — it is a `RenderMode`, not a cache tier. `bun run render-modes` refuses a second declaration on the member set, so the two cannot re-diverge.

### CDN purge

The purge driver is selected from the **environment**, not from a config field — the same law the
mail transports follow, and for the same reason: nothing loads `app.config.ts`'s contents at
runtime, so one image deploys to every environment.

| Key | Selects | Notes |
|---|---|---|
| `FASTLY_API_TOKEN` + `FASTLY_SERVICE_ID` | Fastly | batch surrogate-key purge, 256 keys per call |
| `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID` | Cloudflare | cache-tag purge, 30 tags per call, Enterprise zones |

The surrogate keys are built from the tags by `@ultimat3/cache`'s `surrogateKeys()` — `post`, `post:1`, plus one `e:<entity>` index key per entity ([Caching](Caching-And-Invalidation#the-cdn-leg)). They are sent on an `isr` document whose route declares `revalidate.tags` **while the response is shared-cacheable** — the same document answered to a signed-in visitor is rewritten to `private` and carries neither header — as `Surrogate-Key` (space-separated, what Fastly reads) and `Cache-Tag` (comma-separated, what Cloudflare reads), so the edge purges what `invalidates: [tag.post]` busts. `As of 2026-10-02` — before it no shipped response carried either header; `x-cache-tags`, which neither edge reads, is gone.

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

## `site` and `seo`

`As of 22.3.0`. The public origin every absolute URL is built against, and what a production `robots.txt` keeps crawlers out of.

```ts
site: { origin: 'https://www.example.com' },
seo: {
  robots: { disallow: ['/panel', '/api'] },
  sitemap: { extra: ['/verificar', '/estado'], lastmod: 'git' },
},
```

| field | type | default | notes |
|---|---|---|---|
| `site.origin` | `string \| null` | `null` | scheme + host (+ port) only; a path, query or fragment is `X_CONFIG_INVALID`. Canonical, `og:url`, hreflang and the sitemap are absolute against the first of `APP_URL`, `SITE_ORIGIN`, `site.origin`; with none, the request's own origin (served) or `https://localhost` (static build, which warns on stderr when `ULTIMATE_ENV=production`) |
| `seo.robots.disallow` | `string[]` | `[]` | each starts with `/`. Added to **every** production group — a crawler obeys only the group that names it — with a `User-agent: *` group emitted when none is declared. Any other environment still emits `Disallow: /` alone |
| `seo.sitemap.extra` | `string[]` | `[]` | public pages outside `site/` to list — a path (`/verificar`) answered by an `app/` route with no `policy`; listed per routed locale with hreflang alternates like a `site/` page. No origin, query or fragment (`X_CONFIG_INVALID`); a path no ungated `app/` route answers is `X_SITEMAP_EXTRA_INVALID` when the sitemap is built. `As of 22.10` |
| `seo.sitemap.lastmod` | `'none' \| 'git' \| 'mtime' \| 'build'` | `'none'` | each `<lastmod>`: `'git'` the last commit touching the route's source file (its mtime where there is no work tree — a container image), `'mtime'` the file's mtime, `'build'` one timestamp for every URL. Read once per file per process. `As of 22.10` |

## `pwa`

`offline` is a **block**, not a string, `As of 2026-08` — see [Upgrading](Upgrading). Three booleans, two blocks; every field is optional except `pwa.name`, `pwa.colors` and `pwa.offline.fallback`, which `enabled: true` makes required, and `pwa.vapid.subject`, which a `pwa.vapid` block does.

```ts
pwa: {
  enabled: true,
  offline: { fallback: '/offline' },
  name: 'My App',
  colors: {
    light: { themeColor: '#1b1f3b', backgroundColor: '#ffffff' },
    dark: { themeColor: '#1b1f3b', backgroundColor: '#0b0d1a' },
  },
  // Web Push — the key pair is env (`x vapid create`), never here.
  push: true,
  vapid: { subject: 'mailto:ops@example.com' },
},
```

| field | type | default | notes |
|---|---|---|---|
| `pwa.enabled` | `boolean` | `false` | **read** — `true` makes `x dev`, the container and `x build --target static` emit `manifest.webmanifest`, `sw.js`, `x-sw-register.js` and the `<head>` that names all three, and requires `pwa.name`, `pwa.colors` and `pwa.offline.fallback` beside it. It generated no service worker until 2026-08-27 ([#390](https://github.com/developerz-ai/ultimate/issues/390)) |
| `pwa.name` | `string` | `''` | The install title a browser shows a person. **Required when `pwa.enabled` is `true`** — `app.name` is a slug (`^[a-z][a-z0-9-]{1,63}$`), so it is the wrong answer rather than a rough one |
| `pwa.colors` | `{ light, dark }` of `{ themeColor, backgroundColor }` | `undefined` | `theme_color` and `background_color`, per colour scheme. **Required when `pwa.enabled` is `true`**: a browser paints the install splash and the address bar from these before a stylesheet has loaded, so there is nothing to derive them from and no defensible default. The one place in `app.config.ts` a raw colour is legal (`theme.tokens`, the other, was deleted in 25.0.0) |
| `pwa.offline.fallback` | `string \| null` | `null` | **read** — the absolute route path of the document an offline navigation gets when the cache has no answer. **Required when `pwa.enabled` is `true`**, and it must start with `/`: a relative path resolves against whatever document registered the worker, so `offline` under `/posts/1` is `/posts/offline` — a 404 cached as the answer to every offline navigation |
| `pwa.offline.image` | `string \| null` | `null` | **read** — the URL of the placeholder served for an image request neither the network nor the cache can answer. It must be a path on this origin (`/…`, never `https://…`, `//host` or `/\host` — the build refuses with `X_PWA_NO_OFFLINE_FALLBACK`). The build precaches it beside the offline document and on the same terms: its existence is not checked (a URL that does not exist costs that one precache entry, and the request gets the worker's 503), revisioned by the build id unless it is a content-hashed `/assets/…` URL |
| `pwa.offline.font` | `string \| null` | `null` | **read** — the same, for a font request |
| `pwa.offline.neverCache` | `string[]` | `[]` | **read** — path prefixes the worker passes straight through. Auth and payments belong here: a stale 200 is worse than a failure |
| ~~`pwa.offline` as a string~~ | — | — | **Changed in the release that closed [#390](https://github.com/developerz-ai/ultimate/issues/390).** It was `'precache' \| 'runtime' \| 'network-only'`, an app-wide default for a field `defineRoute` makes **required** on every route — so it defaulted nothing and was read by nobody. Migration: `offline: 'runtime'` → `offline: { fallback: '/offline' }`, plus a route at that path ([Upgrading](Upgrading)) |
| `pwa.backgroundSync` | `boolean` | `false` | **read**. The emitted worker's `sync` event posts `OUTBOX_DRAIN_MESSAGE` to every open tab, which drains realtime's outbox (21.0.0) |
| `pwa.push` | `boolean` | `false` | **read** `As of 26.1.0` — Web Push, end to end: every role's boot resolves the VAPID pair and installs the push runtime (refused with `X_PWA_VAPID_KEY_MISSING` in a deployed environment with no keys), `sw.js` carries the `push` and `notificationclick` handlers, every document carries `<meta name="x-push-key">`, and `pushSubscribe()` / `pushUnsubscribe()` / `webPush()` work. **Wired only with `pwa.vapid`:** `push: true` alone boots as it did on 26.0.0, where the key wired nothing — push stays off and the boot logs `pwa.push unwired` with the fix; 27.0.0 refuses it. A static export has no runtime behind it, so it emits no handler and says so in `serviceWorkerWarnings`. [Notify](Notify#push) |
| `pwa.vapid.subject` | `string` | — | **read** — `mailto:` or an `https:` URL: who a push service writes to about this server (RFC 8292). **What wires `pwa.push`; refused when `pwa.push` is false** (a key with no reader), and a block with no valid subject is refused. The KEYS are never config: `ULTIMATE_VAPID_PUBLIC_KEY` and `ULTIMATE_VAPID_PRIVATE_KEY` are environment variables, sealed together by `x vapid create`, because a public key in committed config and a private key per deploy are two places that can disagree. A development or test process with neither set signs with a published development pair |
| ~~`pwa.installPrompt`~~ | — | — | **Deleted in 8.0.0.** Refused at boot since 25.0.0 (`X_CONFIG_INVALID`, naming the replacement). Declared, defaulted and merged, and read by nothing — `@ultimat3/pwa`'s `installController` is real and complete and no code ever threaded this flag into it, so both tracked apps and every scaffolded app carried a switch with no wire. Migration: delete the key and call `installController` from your own affordance ([PWA and offline](PWA-And-Offline)) |

## `navigation`

Which surfaces move between their pages by client-side navigation over server-rendered documents, and what the browser may prefetch on the rest — [Client navigation](Client-Navigation).

```ts
navigation: { client: ['app'], speculation: { prefetch: 'moderate', exclude: [] } },
```

| field | type | default | notes |
|---|---|---|---|
| `navigation.client` | `('site' \| 'app')[]` | `[]` | **read** by `x dev`, the container and `x build --target static`: a listed surface's documents carry the router (`/_x/assets/navigation/<hash>.js`, charged to each route's `budget.js`). `api`, `shared`, a duplicate or a non-list → `X_CONFIG_INVALID`. The last layer that lists surfaces wins |
| `navigation.speculation.prefetch` | `'moderate' \| 'conservative' \| false` | `'moderate'` | **read** by the same three: every document WITHOUT the router carries `<script type="speculationrules">` (prefetch only, admitted to the CSP by hash, 0 bytes against `budget.js`). `false` emits nothing. Any other value → `X_CONFIG_INVALID` |
| `navigation.speculation.exclude` | `string[]` | `[]` | **read** — URL patterns subtracted from the candidates the route table yields. Each must start with `/`, else `X_CONFIG_INVALID`. The last layer that lists any wins |

## `islands`

How the build bundles the app's `*.island.tsx` client entries.

```ts
islands: { sharedChunks: true },
```

| field | type | default | notes |
|---|---|---|---|
| `islands.sharedChunks` | `boolean` | `false` | **read** by `x dev`, the container and `x build`: `true` builds every island in one split bundle, so a module two islands import is one `/islands/chunk-<hash>.js` a page fetches once and a browser caches across pages; each route's `budget.js` counts it once. `false` builds each island alone, self-contained. Off by default because tree shaking across one split build keeps what ANY importer uses: a small island importing a helper from a module other islands use heavily pays for all of it (`examples/dummy`'s update banner 712 → 16,288 B). Turn it on where pages render several islands over one graph, then weigh the routes with `x verify`. A non-boolean → `X_CONFIG_INVALID` |

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
| `requestTimeoutMs` | `30_000` | `0` disables. At most `2_147_483_647` (the longest a timer holds, ~24.8 days) — more is `X_CONFIG_INVALID`, where it used to arm a 1 ms timer and 504 every request. A caller may only **shorten** it, with `x-request-timeout-ms`; an ask above that ceiling is ignored. The framework's own typed clients send what is LEFT of the current request's budget |
| `maxInflight` | `1_000` | `0` disables. Past it a request is shed `X_OVERLOADED` **before** any work — no route match, no auth, no body |
| ~~`drainTimeoutMs`~~ | — | **Deleted in 25.0.0.** A second drain budget for the `web` role alone; `drain.deadlineMs` is the one budget for every role. Passing the key to `configureHttp` or `defineHttpConfig` is `X_CONFIG_INVALID` naming `drain.deadlineMs` |
| `cors` | `origins: []`, `credentials: true` | `origins: ['*']` with `credentials: true` is `X_CORS_CONFIG_INVALID` at boot — no browser accepts the pair |
| `csrf` | `mode: 'origin'` | `'origin' \| 'off'`. `mode: 'token'` is deliberately not shipped. `'origin'` judges every unsafe request that carries browser evidence (`Origin` or `sec-fetch-site`), signed in or not — a forged sign-in is a forged write. Exempt: an `Authorization` header, and an anonymous request carrying neither header (a webhook, a server-to-server call) |
| `trustClientCertHeader` | `false` | read Envoy's `x-forwarded-client-cert` into `ctx.peer`. Its own declaration: `TRUSTED_PROXY_HOPS` says the proxy appends to `x-forwarded-for`, not that it strips a certificate header the client sent. Read at the same hop index, so it does nothing while no proxy is trusted |
| `healthDetailPeers` | `['loopback']` | who `/healthz` and `/readyz` tell more than `{ state, ready, role }`. Each entry is an address class (`loopback`, `private`, `link-local`, `ula`, `cgnat`, `unspecified`, `reserved`, `public`) or one IP literal; anything else is `X_CONFIG_INVALID`. `[]` tells nobody. Behind a trusted proxy the forwarded caller must be listed as well as the socket. The `sync` role's own listener reads the same list; it trusts no proxy, so a request carrying `Forwarded` or `X-Forwarded-For` gets the verdict only |
| `security` | HSTS off until https is affirmed, CSP report-only in dev | `security.csp.extend` merges **per directive** with the boot's own hashes, so admitting a CDN source does not evict the hydration runtime's and lock every island out. `connect-src` is `'self' blob:` — no bare `ws:`/`wss:` (a socket to any host); a sync node on another origin (`SYNC_URL`) is added by that origin alone (`As of 22.6.0`). `security.hsts` merges key by key: `{ preload: true }` alone opts into preload over the two-year default, `null` sends none |
| `locale` / `tz` | header + cookie names | it decides WHERE the request's locale and zone are read from; `@ultimat3/i18n` and `@ultimat3/time` decide what they mean |
| `rateLimit` | `enabled`, `buckets`, `defaultBucket`, `tenantBucket: null` | `scope` is boot-owned (below). `tenantBucket` names a bucket a whole tenant spends **beside** the caller's own; a name `buckets` does not declare is `X_RATE_LIMIT_TENANT_BUCKET_UNKNOWN` at boot. A request that fails `auth: 'required'` spends `defaultBucket` under one key per client address, across every route — the 401 leaves before the `rate-limit` stage, so it is metered there or nowhere. Once that allowance is spent, the address is refused `X_RATE_LIMITED` on every required route **before** `authenticate` runs — a valid credential included, so a right guess cannot be told from a wrong one — until it refills (`As of 2026-10`) |

**Seven keys plus `rateLimit.scope` are boot-owned, and writing one is a compile error** — `AppHttpConfig` is `Omit<HttpConfigInput, BootOwnedHttpKey | 'rateLimit'>` with `rateLimit` re-added minus `scope`, so the refusal is `TS2353` at the call and never a value silently discarded at every boot:

| boot-owned key | what decides it |
|---|---|
| `port` / `hostname` | `PORT` and the role's binding |
| `dev` | `x dev`, or `ULTIMATE_ENV` |
| `buildId` | `BUILD_ID`, stamped by `x build` |
| `signInPath` | `auth.signInPath` in `app.config.ts` |
| `trustProxy` / `trustedProxyHops` | `TRUSTED_PROXY_HOPS` in the environment — one image runs behind an ingress in one cluster and behind nothing on a laptop, so an app that hardcoded it would be wrong in one of the two |
| `rateLimit.scope` | the store the boot installed. A literal here would be a second declaration quietly contradicting it, and `assertRateLimitScope` compares exactly those two halves |

An **embedder** that builds its own server — `httpServer({ routes, config: defineHttpConfig({ … }) })` — passes the whole `HttpConfigInput`, boot-owned keys included, and owns every consequence: that is the one path on which `X_RATE_LIMIT_SCOPE_UNSET` and `X_TRUST_PROXY_UNSET` are reachable.

## `seo`

**Not an `app.config.ts` block.** There is no `seo` key on `AppConfigInput`. `@ultimat3/seo`'s builders take their options at the call site, from the route that renders them:

| Call | Options | Notes |
|---|---|---|
| `buildRobots(config)` | `baseUrl`, `environment?`, `groups?`, `disallow?`, `sitemaps?`, `extra?` | **fail-closed**: only the exact string `production` opts a deploy into indexing, so staging, a laptop, a typo and an unset `ULTIMATE_ENV` all emit `Disallow: /` — a branch deploy that gets indexed outranks and cannibalises the real site. `environment` omitted resolves from `ULTIMATE_ENV`, and an unreadable one falls back to core's default rather than 500ing a `robots.txt` |
| `buildSitemap(routes, options)` | `baseUrl`, `locales?`, `localizePath?`, `defaultLocale?`, `maxUrls?`, `lastmod?` | splits past `SITEMAP_MAX_URLS` (50,000) into the index `/sitemap.xml` and parts `/sitemaps/<n>.xml` (`SITEMAP_PARTS_DIR`), which the web role serves from `GET /sitemaps/:file`. `maxUrls` must be a positive integer — `0` never advances the chunk cursor and used to allocate empty slices until the box ran out of memory |

`baseUrl` is the argument every one of them takes, so the canonical origin stays an env key the app reads (`APP_URL`) and never a config field. There is no `seo.lighthouse` gate and no `seo.ogImage` renderer `As of 2026-08-22`.

## `budgets`

**Not an `app.config.ts` block.** There is no `budgets` key on `AppConfigInput` and no per-surface default table. A budget is declared **per route**, as `budget` on `defineRoute` — `RouteBudget` in [`packages/render/src/route.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/render/src/route.ts):

**Two keys, `As of 2026-08-24`**, and both are optional:

| field | type | notes |
|---|---|---|
| `budget.js` | `string` | `'40kb'` — measured from the real bundle graph, not the source size. The one budget the framework weighs: `x build --target static` writes a `jsBytes` per prerendered route into `.x/build-stats.json`, counted off the emitted document's own `<script>` tags, and the `budgets` step compares against that |
| ~~`budget.lcp`~~ | — | **Deleted**, with `budgetLcp` on the route descriptor, the `lcp` in `x routes --json` and `x.manifest.json`, and `lcpMs` in `.x/build-stats.json`. Nothing in the framework observes a paint — the build emits static HTML — so it was published and never weighed. A route still declaring it is a type error, and `registerRoute` refuses one that arrives by a cast (`X_ROUTE_MODE_INVALID`). Migration: delete the key |
| ~~`budget.css`~~ | — | **Deleted in 12.0.0**, with `budget.cls` and `budget.tbt`. All three were declared on the route contract for four majors, flattened away by `registerRoute` — which projects a budget to `budgetJs` and nothing else — and read by no consumer anywhere, so `budget: { cls: 0.1 }` was accepted, normalised, stored and ignored while `x verify`'s `budgets` step, the one thing that exists to enforce a budget, reported green. Deleted rather than wired, for `pwa.installPrompt`'s reason: the measuring half does not exist either. Migration: delete the key |
| ~~`budget.cls`~~ | — | as above |
| ~~`budget.tbt`~~ | — | as above. A new budget key is now a **build error** until the descriptor projects it: `_EveryBudgetKeyIsProjected` in [`packages/render/src/type-pins.tsx`](https://github.com/developerz-ai/ultimate/blob/main/packages/render/src/type-pins.tsx) derives `'js'` from `RouteDescriptor`'s own `budgetJs`, so neither side can move alone |

A declared budget with no measurement is itself a failure (`X_BUDGET_UNMEASURED`), never a pass — a route that clears the gate without being weighed is the false green axiom 5 exists to prevent — and the finding names the import chain that blew it, because "your bundle got bigger" is not actionable for a human or an agent. Only `render: 'static'` routes are weighed today; every other mode needs a running process. The **0 kb JS baseline on `site/`** is not a default in a table: a `site/` route off `hydrate: 'never'` with no `budget.js` is refused at registration, which is structural rather than aspirational.

The precache warning is its own number and not a budget: `DEFAULT_PRECACHE_WARN_BYTES` is 5 MiB, overridable per build as `warnBytes` ([`packages/pwa/src/precache.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/pwa/src/precache.ts)).

## `mail`

The transport is selected by **environment**, like every other external service — an unset
variable means the embedded default, so the same image deploys everywhere and no credential is ever
committed. The `app.config.ts` block says only what the chosen transport keeps:

```ts
mail: { retainMime: { maxBytes: 262_144 } },
```

| field | type | default | notes |
|---|---|---|---|
| `mail.retainMime` | `boolean \| { maxBytes?: number }` | `false` | **read** by `x dev` and the container at boot, handed to `selectMailDriver`: the SMTP and SES transports keep the exact MIME bytes they sent, on `SendResult.mime`. `true` is mail's default cap (`DEFAULT_RETAIN_MIME_MAX_BYTES`, 256 KiB); a message over the cap keeps its digest and length only. `maxBytes` must be a whole number above 0 (`X_CONFIG_INVALID` at `defineConfig`) and at most `RETAIN_MIME_CEILING_BYTES` (`X_CONFIG_INVALID` at boot). With `RESEND_API_KEY` selected, any retention refuses the boot: Resend builds the MIME on its own side. The durable `onRetained` callback is code, not config: build it with `selectMailDriver(env, { retainMime: { onRetained } })` — a `MailSelection` — and hand its `.driver` over as the `mail` override in `apps/<app>/runtime.ts` (Runtime overrides, below) |

| env key | selects | notes |
|---|---|---|
| *(none set)* | memory | caught, never sent; the `/_x` mail panel reads this outbox |
| `SMTP_URL` | SMTP | `smtps://user:pass@host:465`, or `smtp://host:587` for STARTTLS |
| `RESEND_API_KEY` | Resend | one `POST /emails` per message, with an `Idempotency-Key` |
| `SES_REGION` | Amazon SES | one SES v2 `SendEmail` with the raw MIME, SigV4-signed, no SDK |
| `SES_ACCESS_KEY_ID` | — | SES only, required with `SES_REGION` |
| `SES_SECRET_ACCESS_KEY` | — | SES only, required with `SES_REGION` |
| `SES_SESSION_TOKEN` | — | SES only, optional: temporary credentials |
| `SES_ENDPOINT` | — | SES only, optional: a VPC endpoint or a local stand-in. Default `https://email.<region>.amazonaws.com` |
| `SES_CONFIGURATION_SET` | — | SES only, optional: the configuration set that publishes delivery events |
| `MAIL_FROM` | — | required by SMTP, Resend and SES; the memory and unconfigured drivers do not read it. `Name <addr>`; also the envelope sender and the `Message-ID` domain |
| `MAIL_POOL_SIZE` | — | SMTP connections open at once. Default `4`, whole number ≥ 1 |

The list is `MAIL_ENV_KEYS` in `packages/mail/src/driver-env.ts`, `As of 2026-10`. More than one of
`SMTP_URL`, `RESEND_API_KEY` and `SES_REGION` is `X_CONFIG_INVALID`: a process delivers through
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
| `OTEL_EXPORTER_OTLP_HEADERS` | `OTEL_EXPORTER_OTLP_TRACES_HEADERS` / `..._METRICS_HEADERS` REPLACES it for that signal. Percent-decoded, so `%zz` is `X_OTLP_HEADERS_INVALID` rather than a bare `URIError` at exporter construction. The header **key** appears in the cause and the fix; the **value** never does — it is the collector's credential |
| `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` | read at the **first span**, never at module scope. `parentbased_always_on` takes no arg and ignores one. `configureTelemetry({ sampler })` is the programmatic form |

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

**The sweep only runs against the Postgres inbox.** `postgresInboxStore` carries `purgeBefore`; the
memory inbox does not, and a boot that installed the memory one — or no inbox at all — sweeps
nothing and logs nothing. Installing the store is `setNotifyStores`, your app's boot line; the
framework applies the DDL either way.

**`x_notify_deliveries` has no config key**, deliberately. Its window is
`postgresDeliveryLedger({ executor, windowMs })`, stated beside the statement that reads it, and it
must **never be shorter than your idempotency window**: a job replayed inside the idempotency window
against a claim that has already been purged claims cleanly and sends the notification a second
time. Pass `idempotency.windowMs` and the two cannot disagree.

**`x_notify_digests` has no config key either.** A digest window is deleted by its own flush; the
sweep takes only a window CLOSED longer than `postgresDigestStore({ executor, retentionMs })` ago —
a week by default, longer than any flush's retries — which is a window whose flush dead-lettered on
a slot that never digests again. Up to 50 batches of 1,000 rows per hourly pass.

## `ai`

One live field, and `ai.mcp` is where the app's own MCP surface is configured — there is no top-level `mcp` block.

| field | type | default | notes |
|---|---|---|---|
| `ai.mcp.expose` | `boolean` | `true` | the app's own MCP surface. Actions still opt in per action `mcp.expose` |
| ~~`ai.mcp.path`~~ | — | — | **Deleted in 25.0.0**, refused with `X_CONFIG_INVALID`. Endpoint #0 mounted here while every other endpoint mounted at its own `defineAppMcp({ path })`, so the two could disagree. Now every endpoint, #0 included, mounts at its own `defineAppMcp({ path })` (default `/mcp`). Migration: delete the key; if it wasn't `/mcp`, move it to the first `defineAppMcp({ path })` in `apps/<app>/mcp.ts` |
| ~~`ai.modelEnv`~~ | — | — | **Deleted in 8.0.0.** It named the env key holding the model id "so no model string is baked into the image", and its only reader was `defineConfig`'s own merge: `@ultimat3/ai` reads env for API keys only, and the model was a compile-time default (`DEFAULT_MODEL`, itself deleted in 25.0.0 — an app names its model on the prompt or on `llm({ model })`). The one thing the key existed to prevent is what it delivered. Refused at boot since 25.0.0 (`ai.modelEnv was removed in 8.0.0`). Migration: delete the key and pass `model`, reading your own env key if you want one |

`ai.models`, `ai.fallback`, `ai.cache` and `ai.budget` are per-`llm()` declarations, not config ([MCP and AI](MCP-And-AI)). i18n has no config block either: `defineCatalogs({ default, locales })` is the whole surface.

## `drain`

How a SIGTERM'd process leaves: `DrainConfig` in [`packages/core/src/config-health.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/core/src/config-health.ts). The production boot applies it to **every role** (`lifecycleForRole`, `packages/cli/src/serve-boot.ts`), not only to the web server.

| field | type | default | notes |
|---|---|---|---|
| `drain.readinessGraceMs` | whole ms, `0`–`60000` | `0` in `development`/`test`, `5000` everywhere else (a process naming no environment included) | `/readyz` answers 503 for this long with the listener still open, so endpoints stop routing here before it closes. `web` and `sync` only: every other role drains with no grace |
| `drain.deadlineMs` | whole ms, `1`–`3600000` | `25000` | the drain budget, after the grace: the time in-flight requests and a **running job** have to finish on a deploy before the lifecycle abandons the rest (`X_SHUTDOWN_TIMEOUT`). Raise it for long jobs. `NaN`, `Infinity`, a fraction, `0` or more than an hour is `X_CONFIG_INVALID` naming the key — past an hour, the job belongs in more steps. `As of 2026-10-05` |
| `drain.workerDeadlineMs` | whole ms, `1`–`86400000`, or unset | unset | `ROLE=worker`'s budget **in place of** `drain.deadlineMs`, for a job that must finish rather than be cut off and replayed and may run past the hour — a bank login, a payment. Also what bounds a retire (SIGUSR2) that a SIGTERM lands in. Unset: the worker drains on `drain.deadlineMs` like every role. More than a day is `X_CONFIG_INVALID` naming the key. `As of 2026-10` |

```ts
export const config = defineConfig({
  name: 'postly',
  // A report job runs up to 8 minutes; a deploy lets it finish.
  drain: { deadlineMs: 600_000 },
});
```

The platform's own kill timer must outlast the sum, or SIGKILL truncates the drain:

| Rung | Who sizes it | Rule |
|---|---|---|
| Helm | `x deploy --method helm` passes `drain.deadlineSeconds`, `drain.workerDeadlineSeconds` and `drain.readinessGraceSeconds` from this section; the chart derives each role's `terminationGracePeriodSeconds` | preStop (web/sync, 1.30+) + grace (web/sync) + deadline (the worker's: `workerDeadlineSeconds` when > 0) + retire (worker, `roles.worker.retireSeconds`) + 10 s margin |
| Compose | you: `stop_grace_period` in `docker-compose.prod.yml` | ≥ grace + deadline + 10 s (`40s` ships, for the defaults); the worker service's ≥ `workerDeadlineMs` + 10 s when declared — the worker drains with no grace |

```ts
import { defineConfig } from '@ultimat3/core';

export const config = defineConfig({
  name: 'banks',
  // A bank run takes up to 2 h and must never re-login: the worker waits it out on a deploy.
  drain: { deadlineMs: 25_000, workerDeadlineMs: 7_500_000 },
});
```

**The boot applies this section after the app's modules load** (`bootRoles`, `packages/cli/src/serve-boot.ts`), so a `configureLifecycle({ deadlineMs })` an app makes at import time or before `serveApp` is overwritten by it — `drain.deadlineMs` always has a value (its default). Declare the budget here, never in code.

**`drain.deadlineMs` is the only drain budget, on every role, `web` included** — the worker's alone may be `drain.workerDeadlineMs`. `http.drainTimeoutMs` re-set it on the `web` role after this section was applied; 25.0.0 deleted it, and a `configureHttp({ drainTimeoutMs })` is refused `X_CONFIG_INVALID` with the `drain: { deadlineMs }` edit.

## Runtime overrides — `apps/<app>/runtime.ts`

The one place a deployment hands the framework a driver, a middleware or a plain route. Not a
config key: an object, exported as `runtime` from `apps/<app>/runtime.ts`. `x dev` reads it, and so
does `runRole` (the container boot) when its caller passed none — one chain in development and in
production, never two.

```ts
// apps/web/runtime.ts
import type { ServeOptions } from '@ultimat3/cli/serve';
import type { Middleware } from '@ultimat3/http';

// `ctx.headers` is merged into whatever response the route produces.
const servedBy: Middleware = (request, ctx, next) => {
  ctx.headers.set('x-served-by', 'web');
  return next(request, ctx);
};

export const runtime: NonNullable<ServeOptions['runtime']> = { middleware: [servedBy] };
```

Every field is optional, and every field **replaces** the default the environment would have
picked — it never sits beside it. The type is `RuntimeOverrides` (`packages/cli/src/runtime-overrides.ts`).

| Field | Replaces |
|---|---|
| `jobs` | the queue driver every enqueue and every claim uses; installed as the ambient driver too, so the boot refuses a process where the two disagree |
| `storage` | the `S3_ENDPOINT` / embedded-disk decision, whole: disks, default disk and all |
| `mail` | the `SMTP_URL` / `RESEND_API_KEY` / `SES_REGION` selection |
| `transport` | the `NATS_URL` selection. Arrives connected and is **not** closed on stop — whoever built it owns its socket |
| `purge` | the `CLOUDFLARE_*` / `FASTLY_*` selection behind the `cdn` cache tier |
| `rateLimitStore` | the Postgres store the boot installs over its own pool. The store's scope decides `rateLimit.scope`; a `'process'` store is legal and warned about — every limit then applies once per replica |
| `isrStore` | the per-process memory store for regenerated ISR pages (one per replica, so a purge tag reaches one of them) |
| `middleware` | nothing — prepended to the request pipeline, outermost first |
| `routes` | nothing — plain HTTP routes at paths no primitive projects to (an OAuth token endpoint, a feed with its own content type), mounted after the framework's routes and before the pages, through the whole pipeline |
| `images` | `builtinImageDriver`, the `/media/*` transform |
| `syncAuthenticate` | the adapter over the app's own `configureAuthenticator()` that authenticates a `sync` socket |

### What middleware can and cannot see

| Rule | Why |
|---|---|
| middleware wraps a **matched** route only | the router runs first (`packages/http/src/stages.ts`). An unmatched path is answered `404` (or `405` with `allow`) before any middleware runs, so middleware cannot rewrite, redirect or serve a URL that no route declares |
| a redirect from a path nothing serves needs a route | declare a page at the old path that answers the redirect, or add one to `runtime.routes`. `api/` holds no route file: it is actions and queries only ([Project layout](Project-Layout#surfaces)) |
| `/healthz` and `/readyz` never reach it | they are answered by the listener before the pipeline, so a draining or rate-limited process can still say what it is doing |
| a `/<locale>/` prefix is stripped before the match | middleware sees the route the stripped path matched, never the prefix as a route of its own |

Routes, their files and their render modes → [Routes and render modes](Routes-And-Render-Modes).

## Env vars

One typed schema, declared with `defineEnv` at module scope **in `app.config.ts`**, validated at boot. There is no `env.ts` — the one config file is also the one env gate. A missing or malformed key fails in **~40ms** with `X_ENV_MISSING`, every offender named in one error — never a 500 an hour later.

| var | roles | required | notes |
|---|---|---|---|
| `ROLE` | all | no — default `web`, as is empty or blank | exactly `web \| sync \| worker \| scheduler \| migrate \| replicator`. There is no `all`. Invalid → `X_ROLE_UNKNOWN` from the production boot path, `X_ROLE_INVALID` from `assertRole()` inside the framework |
| `PORT` | `web`, `sync` | no — default `3000` | the TCP port the role binds. Non-decimal (`0x1F90`, `8e3`, `+80`) or outside 0–65535 → `X_PORT_INVALID`, refused rather than defaulted past, because a web role that quietly bound 3000 fails the platform's health probe with nothing in the log that names the cause |
| `HOST` | `web`, `sync` | no — default `0.0.0.0` | the interface the role binds, and its metrics endpoint with it. Empty or whitespace is the default. `127.0.0.1` inside a container is unreachable through a port mapping and reachable only where the container shares the host's network namespace (`--network host`, a sidecar, `ssh -L`) — what an app that admits one implicit actor without a login wants. `runRole({ hostname })` overrides it, as `port` overrides `PORT` |
| `ULTIMATE_ENV` | all | no — default `development` | `development \| test \| staging \| production`, read by `resolveEnvironment()`. `NODE_ENV` is a fallback only, and is never policed |
| `DATABASE_URL` | all | yes | |
| `DATABASE_REPLICA_URL` | all | no — unset is one pool | `As of 2026-08-24`: a read-only standby. Set it and `baseClient()` builds a primary + replica client; unset and the client is byte-identical to the single-pool one. Routing is still opt-in per scope (`withReplicaReads`), so setting it alone changes nothing — see [Read replicas](#read-replicas) |
| `APP_URL` | `web`, `sync` | yes | the canonical origin. An app-read key, not a config field — declare it in `defineEnv`. On `sync` it is also the page origin the node admits a socket from: the node compares the handshake's `Origin` exactly (scheme, host, port), and a declared `APP_URL` is the WHOLE list — the origin the node was reached on is admitted only when none is declared. So it must be RIGHT wherever it is set, and set wherever host or port differ — the Compose rung (page on `:3000`, socket on `:3001`, where the shipped compose file requires it), a `SYNC_URL` on another host. The Helm chart sets it on the sync role from `ingress.host`. Undeclared behind a TLS proxy on the same host and port, a node reached over plain http admits that host's `https` spelling too. `x dev` adds its own web role's origin (and its `localhost`, `127.0.0.1`, `[::1]` spellings) to a declared one, and keeps admitting the origin it was reached on, so `x dev --port 4000` and a forwarded host (a Codespace, a tunnel) beside `APP_URL=http://localhost:3000` connect; a container adds nothing. A socket refused: `X_SOCKET_ORIGIN_REFUSED`, not `APP_URL`'s origin when one is declared; with none declared, not the origin the node was reached on |
| `SESSION_SECRET` | `web`, `sync` | yes | >=32 chars |
| `ULTIMATE_STATE_DIR` | all, under `x dev` | no — default `<app>/.x` | relocates the whole of `.x/` (the embedded database, the local disk, the dev lock) for one process tree. The e2e step uses it to boot the app on a throwaway database beside a running `x dev` (`packages/cli/src/runtime-bindings.ts`). 21.0.0 |
| `SYNC_URL` | `web` | no — unset dials `/_x/sync` on the page's own origin | where the page's one socket dials, rendered into every document as `<meta name="ultimate-sync">`. Must be `ws://` or `wss://`; anything else is `X_CONFIG_INVALID` at boot. **Required on the Compose rung**, where `sync` is published on its own port with no proxy in front: `SYNC_URL=ws://<host>:3001/_x/sync`. The shipped compose file refuses to start `web` without it. `x dev`, a combined-role container and the Helm chart's ingress all serve `/_x/sync` on the page origin, so they need nothing. `As of 2026-09-22` (21.0.0) |
| `WORKER_QUEUES` | `worker` | no — unset or blank serves `jobs.queues` plus every registered job's queue | comma-separated, trimmed, deduplicated. Set, it is the EXACT list this worker claims — `jobs.queues` and the registered queues are not added (`As of 25.0.0`; documented here before then and read by nothing). An empty entry (`banks,,long`) is `X_CONFIG_INVALID` at boot. See [Splitting queues across Deployments](#jobs) |
| `NATS_URL` | `sync`, `replicator` | no — unset is in-process fanout | one node only; a second replica shares nothing. Unreachable → `X_TRANSPORT_UNAVAILABLE` at boot, not at readiness |
| `NATS_KV_BUCKET` | `sync` | no — default `x_presence` | the JetStream KV bucket presence lives in. `[a-zA-Z0-9_-]+`; anything else is `X_TRANSPORT_PROTOCOL` at boot |
| `REPLICATION_URL` | `replicator` | no — defaults to `DATABASE_URL` | the connection the WAL is read from; this role must have `REPLICATION` privilege |
| `REPLICATION_SLOT` | `replicator` | no — default `x_replicator` | logical replication slot name |
| `REPLICATION_PUBLICATION` | `replicator` | no — default `x_changes` | the `pgoutput` publication the slot decodes |
| `REDIS_URL` | any tier-3 cache user | if `redis` in `cache.tiers` | |
| `BUILD_ID` | all | set by `x build` | content hash. Never a timestamp, never `latest` |
| `LOG_LEVEL` | all | no — unset or empty is `info` | `trace \| debug \| info \| warn \| error \| fatal \| silent`, lowercase. Any other value — `DEBUG`, `verbose` — is REFUSED at import (`X_INVARIANT`), never read as `info` |
| `TRUSTED_PROXY_HOPS` | `web`, `sync` | no — unset trusts no proxy header | how many proxies **append** to `x-forwarded-for` between the client and this process: 1 for a single ingress or ALB, 2 for a CDN in front of one. Decimal digits, 1–64 (`@ultimat3/http`'s `MAX_PROXY_HOPS`); anything else is `X_TRUSTED_PROXY_HOPS_INVALID`, refused rather than defaulted, because reading the header at the wrong index is trusting a value the client typed. Unset means `ctx.ip` is the socket address, `ctx.peer` is `null` and no inbound `x-request-id` is echoed |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | all | no | the OTLP collector. There is no `otel` config block for it to override — see [`otel`](#otel) |

Rules:

| Rule | Detail |
|---|---|
| Secrets are env or a mounted file | the framework never talks to a vendor secret API ([axiom 7](Home)) |
| `env.X` reads through `defineEnv`'s schema | a declared key that is missing or malformed is `X_ENV_MISSING` at boot, every offender in one error. A `process.env` read outside the schema is a lint error, never a runtime one |
| `X_CONFIG_INVALID` is env **and** `app.config.ts` | one code for a configuration that cannot boot: what `defineConfig`'s own validation throws — a bad locale or two spellings of one, an unknown time zone, a section or list of the wrong shape (`jobs: null`), a value outside its closed set (`roles`, `jobs.backoff`, `theme.defaultMode`), a switch that is not a boolean (`database.ssl: 'false'`), `jobs.concurrency < 1`, a `realtime.transport` other than `memory` with no `realtime.urlEnv`, a `cache.tiers` entry the environment cannot supply — and any env **combination** no boot can resolve, thrown by the selector that reads it. Both CDN pairs or half a pair (`selectPurgeDriver`), more than one of `SMTP_URL` / `RESEND_API_KEY` / `SES_REGION`, or a transport with no `MAIL_FROM` (`selectMailDriver`), or `REPLICATION_URL` naming a different host, port or database than `DATABASE_URL` (`selectChangeFeed`) |
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

```sh
x env example        # writes .env.example from the app's envSchema
```

```ts
import { renderEnvExample, ENV_EXAMPLE_PATH } from '@ultimat3/core';

await Bun.write(ENV_EXAMPLE_PATH, renderEnvExample(schema));      // '.env.example'
```

`renderEnvExample(schema, { extras })` returns the whole file, deterministic in declaration order. Per key it writes the description, then an annotation line — `required|optional · <type or enum values> · secret · role a/b` — then `KEY=<example>`. **A `secret: true` key's example is always empty**, even when the declaration has a default. `extras` are appended as commented `# NAME=` lines.

**`x env example` writes more than the schema.** After the app's own keys it appends a `# --- Framework` section: the secrets the framework refuses to boot without outside `development`/`test`, whatever `envSchema` declares — `ULTIMATE_CURSOR_SECRET` (cursor signing, `X_CURSOR_SECRET_DEV`) and `STORAGE_SIGNING_SECRET` (the embedded disk's upload grants, `X_ENV_MISSING`; not read when `S3_ENDPOINT`/`S3_BUCKET` select object storage), always; and, once `pwa.push` is wired (`As of 26.1.0`), `ULTIMATE_VAPID_PUBLIC_KEY` and `ULTIMATE_VAPID_PRIVATE_KEY` (`X_PWA_VAPID_KEY_MISSING`), minted together by `x vapid create` — never by `openssl`, and the section header then says which generator mints which. Each is annotated `required when deployed · string` (and `· secret`, all but the public key) with its reason and an empty value, so the file is the whole deploy contract an infra repo builds its Secret from. A key the app declares itself is rendered once, as the app declared it. The list is `FRAMEWORK_SECRETS` in [`packages/cli/src/framework-env.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/cli/src/framework-env.ts) — `x env check` and `x doctor` read the same one. `renderEnvExample` itself is the app's projection alone.

| Command | Framework secrets |
|---|---|
| `x env example` | rendered, blank, after the app's keys |
| `x env check` | checked against the environment it runs in, by the boot's own rule (core's `devSecretsRefused`, `deployed` in `framework-env.ts`): anything but `development`/`test`, **and an environment naming none** — the boot fails closed. `ULTIMATE_ENV=production x env check` answers what the first deployed boot would (`X_CURSOR_SECRET_DEV`, `X_STORAGE_SECRET_DEV`, and `X_PWA_VAPID_KEY_MISSING` for a push app; exit 1); the published development keys count as unset |
| `x doctor` | the same findings, cause and fix — except the VAPID pair, which needs the app's config and doctor reads none — but about **this machine**: only where `ULTIMATE_ENV` (else `NODE_ENV`) names `staging` or `production` (`namedDeployed`). A developer shell naming no environment gets none; ask `x env check` what a deployed boot would do with it |

**`x verify` holds the committed file to it**, on the `manifest` step: `.env.example` must be byte-for-byte the projection of `envSchema` in `app.config.ts`, so a moved description, default or required flag fails the gate as well as a missing key — and so does a file missing the framework section (an example written by 24.x). A miss is `X_ENV_EXAMPLE_DRIFT`, missing keys named first; the fix is `x env example`. An app that exports no `envSchema` has nothing to project and the check is silent.

`assertEnvExample(schema, text)`, the older, weaker check (key presence only, called by nothing), was **deleted in 25.0.0** with `EnvExampleDriftError`; the gate above is the one check, and `checkEnvExample(schema, text)` returns the same report as data.

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
