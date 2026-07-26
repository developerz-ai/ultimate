/**
 * The one config file. Holds only what cannot be derived from code — everything else
 * (routes, actions, policies, jobs, tags) is generated into `x.manifest.json`.
 */

import { defineConfig, env } from '@ultimat3/core';
import { t } from '@ultimat3/schema';

export const config = defineConfig({
  name: 'postly',
  url: env.APP_URL,

  /** Two locales, both complete. `x verify` fails on a key present in one and missing in the other. */
  i18n: {
    default: 'en',
    supported: ['en', 'es'],
    catalogs: '@postly/i18n',
  },

  /** Prices are stored per currency; nothing is converted at runtime. */
  money: {
    default: 'USD',
    supported: ['USD', 'EUR'],
  },

  /** Display default only — a signed-in member's own `tz` column always wins. */
  time: {
    defaultZone: 'UTC',
  },

  db: {
    url: env.DATABASE_URL,
    entities: '@postly/db',
  },

  jobs: {
    driver: 'pg',
    queues: ['default', 'mail', 'digest'],
  },

  /** Tier 3: live queries plus a durable client store, because the feed must work offline. */
  realtime: {
    tier: 3,
    transport: 'nats',
    url: env.NATS_URL,
  },

  cache: {
    redis: env.REDIS_URL,
  },

  mail: {
    from: 'Postly <hello@postly.example>',
  },

  pwa: {
    offline: { fallback: '/offline' },
    backgroundSync: { enabled: true, queues: ['mutations'] },
    icon: './apps/web/public/icon.svg',
  },

  seo: {
    sitemap: true,
    rss: { title: 'Postly', route: '/blog' },
    lighthouse: { seo: 100, accessibility: 95 },
  },

  admin: {
    app: '@postly/admin',
    path: '/admin',
    mcp: true,
  },

  mcp: {
    server: '@postly/mcp',
  },

  /** Validated once at boot. A missing or malformed var is a startup failure, never a 500 later. */
  env: t.object({
    APP_URL: t.string.url,
    DATABASE_URL: t.string.url,
    NATS_URL: t.string.url,
    REDIS_URL: t.string.url,
    SESSION_SECRET: t.string.atLeastLength(32),
    MAIL_API_KEY: t.string,
    ANTHROPIC_API_KEY: t.string,
    ROLE: t
      .enumerated('web', 'sync', 'worker', 'scheduler', 'migrate', 'replicator')
      .default('web'),
    LOG_LEVEL: t.enumerated('debug', 'info', 'warn', 'error').default('info'),
  }),
});
