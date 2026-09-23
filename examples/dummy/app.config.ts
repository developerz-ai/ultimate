/**
 * The one config file. Holds only what cannot be derived from code — everything else
 * (routes, actions, policies, jobs, tags) is generated into `x.manifest.json`.
 *
 * A named export, never a default: the CLI and the runtime both import `config` by name.
 *
 * The env keys below are the ones the FRAMEWORK reads. `defineConfig` has no generic `env` block
 * yet, so a key only the app reads — `APP_URL`, `BUILD_ID` — is declared at its point of use
 * (`apps/web/shared/client.ts`) rather than being smuggled in here as a field nothing validates.
 */

import { defineConfig, defineMeasurementActor } from '@ultimat3/core';

export const config = defineConfig({
  name: 'postly',

  /** Two locales, both complete. `x verify` fails on a key present in one and missing in the other. */
  locales: ['en', 'es'],
  defaultLocale: 'en',

  /** Display default only — a signed-in member's own `tz` column always wins. */
  defaultTimeZone: 'UTC',

  /** Prices are stored per currency; nothing is converted at runtime. */
  defaultCurrency: 'USD',

  // The pool is sized by `DATABASE_POOL_MAX`, not here — `config.database.poolSize` was read by
  // nothing and was deleted `As of 2026-08`. The sizing argument still holds and still applies:
  // the pool is per PROCESS and one image runs one ROLE per process, so a web replica and a
  // worker never share one in production. The binding case is `x dev`, which runs every role in
  // ONE process: 12 = jobs.concurrency (8) + the queue poller + 3 left for HTTP, where 10 would
  // leave requests queueing behind a full digest run. Keep `replicas x 12` under the server's
  // `max_connections`.

  // The rung names are the ladder's own (`CACHE_TIERS`), and `isr` was never one of them: it is
  // a RenderMode, and the routes that want it declare `render: 'isr'`.
  //
  // No `redis` rung, deliberately, `As of 2026-08-23`. This app has never had a Redis — there is no
  // `.env` here, only `.env.example` — and since 9.0.0 the ladder IS this declaration: naming a rung
  // the environment cannot supply refuses the boot rather than quietly building a shorter ladder.
  // It used to name one and silently get two rungs, which is exactly the drift that made
  // `cache.tiers` worth reading in the first place. Add `redis` back the same commit you add a
  // `REDIS_URL`.
  cache: { tiers: ['request-memo', 'lru'] },

  jobs: { queues: ['default', 'mail', 'digest'], concurrency: 8 },

  // In-process, because this is what the app's own gate boots: `x dev` and `apps/web/server.ts`
  // under e2e, with no bus. Since 22.0.0 the boot BUILDS what this says — `'nats'` with NATS_URL
  // unset refuses (`X_CONFIG_INVALID`), where it used to fall back to in-process in silence. To run
  // more than one node: `{ enabled: true, transport: 'nats', urlEnv: 'NATS_URL' }` and the same
  // NATS_URL on web, sync and the replicator. There is no `tier:` key: nothing ever read it.
  realtime: { enabled: true, transport: 'memory' },

  pwa: {
    enabled: true,
    // The document an offline navigation gets when the cache has no answer. Required once
    // `enabled` is true: an installable app that shows the browser's error page offline is the
    // failure the block exists to prevent.
    offline: { fallback: '/offline' },
    backgroundSync: true,
    name: 'Ultimate Dummy',
    colors: {
      light: { themeColor: '#1b1f3b', backgroundColor: '#ffffff' },
      dark: { themeColor: '#1b1f3b', backgroundColor: '#0b0d1a' },
    },
  },

  ai: { mcp: { expose: true, path: '/mcp' } },
});

/**
 * Who `x build`'s budget pass renders `app/` as. Those routes read the request's member and org
 * (`useActor()`), and the framework's default measurement actor is a `service` with neither, so
 * /posts/new and /settings refused with X_ACTOR_UNRESOLVED and were never weighed. The demo owner
 * is a declared viewer — no row has to exist — and it is loaded lazily: `demo-actor.ts` imports
 * this file, and a static import back would be a cycle.
 */
defineMeasurementActor(async () => {
  const { DEFAULT_DEMO_MEMBER, demoActorFor } = await import('./apps/web/app/auth/demo-actor');
  return demoActorFor(DEFAULT_DEMO_MEMBER);
});
