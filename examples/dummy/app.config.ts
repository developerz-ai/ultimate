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

import { defineConfig } from '@ultimat3/core';

export const config = defineConfig({
  name: 'postly',

  /** Two locales, both complete. `x verify` fails on a key present in one and missing in the other. */
  locales: ['en', 'es'],
  defaultLocale: 'en',

  /** Display default only — a signed-in member's own `tz` column always wins. */
  defaultTimeZone: 'UTC',

  /** Prices are stored per currency; nothing is converted at runtime. */
  defaultCurrency: 'USD',

  // Env KEYS, never the value: the same image deploys to every environment.
  //
  // `poolSize` is per PROCESS and one image runs one ROLE per process, so a web replica and a
  // worker never share a pool in production. The binding case is `x dev`, which runs every role
  // in ONE process: 12 = jobs.concurrency (8) + the queue poller + 3 left for HTTP, where 10
  // would leave requests queueing behind a full digest run. Keep `replicas x 12` under the
  // server's `max_connections`.
  database: { urlEnv: 'DATABASE_URL', poolSize: 12 },

  cache: { driver: 'redis', urlEnv: 'REDIS_URL', tiers: ['memo', 'lru', 'shared', 'isr'] },

  jobs: { driver: 'postgres', queues: ['default', 'mail', 'digest'], concurrency: 8 },

  /** Tier 3: live queries plus a durable client store, because the feed must work offline. */
  realtime: { enabled: true, tier: 'local-first', transport: 'nats', urlEnv: 'NATS_URL' },

  pwa: { enabled: true, offline: 'runtime', installPrompt: true, backgroundSync: true },

  ai: { mcp: { expose: true, path: '/mcp' }, modelEnv: 'ANTHROPIC_MODEL' },
});
