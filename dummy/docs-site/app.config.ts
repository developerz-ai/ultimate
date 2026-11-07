// The one config file. Everything the app needs to boot is here, typed and validated at startup —
// a missing value fails the boot with the exact command that fixes it, never at the first request.
// A named export, never a default: the CLI and the runtime both import `config` by name.
import type { EnvSchema } from '@ultimat3/core';
import { defineConfig, defineEnv, defineMeasurementActor, userActor } from '@ultimat3/core';

export const envSchema = {
  DATABASE_URL: {
    type: 'url',
    required: false,
    description: 'Postgres URL. Empty means embedded: x dev runs PGlite in-process.',
  },
  PORT: {
    type: 'port',
    default: 3000,
    description: 'HTTP port this role binds. Every PaaS injects it.',
  },
  NATS_URL: {
    type: 'url',
    required: false,
    role: 'sync',
    description: 'Realtime fan-out cluster. Only the sync role is asked for it.',
  },
  APP_URL: {
    type: 'url',
    required: false,
    role: ['web', 'sync'],
    description: 'Public origin of the pages. Sync admits sockets from it.',
  },
  SYNC_URL: {
    type: 'string',
    required: false,
    role: 'web',
    description: 'Where a page dials the sync socket. Compose: ws://<host>:3001/_x/sync',
  },
  SESSION_SECRET: {
    type: 'string',
    required: false,
    secret: true,
    description: 'Session cookie signing key. Generate: openssl rand -hex 32',
  },
} satisfies EnvSchema;

/**
 * Validated once, at module scope, before anything listens: a missing or malformed key fails the
 * boot in ~40ms naming every offender at once, never as a 500 an hour later.
 */
export const env = defineEnv(envSchema);

export const config = defineConfig({
  name: 'docs-site',
  // Locales are declared by the catalogs (`defineCatalogs` in `packages/i18n/src/index.ts`); no
  // zone or currency default exists — every format call names its zone, every `Money` its currency.
  // Env KEYS, never the value: the same image deploys to every environment. The database is
  // configured from the environment — `DATABASE_URL` and `DATABASE_POOL_MAX`. Off by default,
  // `database: { rowSecurity: true }` adds the database's own tenant guard under the repository's.
  // The tiers ARE the cache selection: add 'redis' to build the shared rung, which reads
  // `REDIS_URL` and refuses the boot when it is unset.
  cache: { tiers: ['request-memo', 'lru'] },
  jobs: { queues: ['docs-site-default'], concurrency: 4 },
  // In-process transport by default; set urlEnv and transport: 'nats' to scale past one node.
  realtime: { enabled: true, transport: 'memory' },
  // `name` and `colors` are what an install prompt shows and what a browser paints the splash
  // with before any stylesheet has loaded — the four values the framework cannot derive, so
  // `defineConfig` refuses `pwa.enabled: true` without them. Raw hex is legal here and nowhere
  // else in an app.
  pwa: {
    enabled: true,
    // The document an offline navigation gets when the cache has no answer, and the path
    // `apps/web/site/offline/page.tsx` serves. Required once `enabled` is true: an installable
    // app that shows the browser error page offline is the failure the block exists to prevent.
    offline: { fallback: '/offline' },
    name: 'Docs Site',
    colors: {
      light: { themeColor: '#1b1f3b', backgroundColor: '#ffffff' },
      dark: { themeColor: '#1b1f3b', backgroundColor: '#0b0d1a' },
    },
  },
  // The theme a first visit opens in; the framework inlines the no-flash boot script that reads
  // it, and a choice stored by the theme toggle wins over it on every later visit; 'system' follows
  // the OS.
  theme: { defaultMode: 'dark' },
  ai: { mcp: { expose: true } },
});

/**
 * Who `x build`'s budget pass renders `app/` as. A page that reads rows reads its actor's org
 * through the typed handle, which refuses an actor with none (X_TENANCY_ACTOR_ORG_REQUIRED) — and
 * the framework's default measurement actor is a `service` with no org, so such a route is never
 * weighed (X_BUDGET_UNMEASURED). A member of the demo org is a declared viewer: no row has to
 * exist. Loaded lazily, so this file's import graph stays the config's own.
 */
defineMeasurementActor(async () => {
  const { DEMO_ORG_ID } = await import('./apps/web/shared/demo-org');
  return userActor({ id: 'x-build-measure', orgId: DEMO_ORG_ID, roles: ['member'] });
});
