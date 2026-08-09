/**
 * The one config file. Holds only what cannot be derived from code — everything else
 * (routes, actions, policies, jobs, tags) is generated into `x.manifest.json`.
 *
 * A named export, never a default: the CLI and the runtime both import `config` by name.
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
  database: { urlEnv: 'DATABASE_URL', poolSize: 10 },

  cache: { driver: 'redis', urlEnv: 'REDIS_URL', tiers: ['memo', 'lru', 'shared', 'isr'] },

  jobs: { driver: 'postgres', queues: ['default', 'mail', 'digest'], concurrency: 8 },

  /** Tier 3: live queries plus a durable client store, because the feed must work offline. */
  realtime: { enabled: true, tier: 'local-first', transport: 'nats', urlEnv: 'NATS_URL' },

  pwa: { enabled: true, offline: 'runtime', installPrompt: true, backgroundSync: true },

  ai: { mcp: { expose: true, path: '/mcp' }, modelEnv: 'ANTHROPIC_MODEL' },
});
