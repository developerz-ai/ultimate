// The one config file. Everything the app needs to boot is here, typed and validated at startup —
// a missing value fails the boot with the exact command that fixes it, never at the first request.
// A named export, never a default: the CLI and the runtime both import `config` by name.
import { defineConfig, defineEnv } from '@ultimat3/core';

/**
 * Every environment variable this app reads, declared once. Parsed at module scope, so *importing
 * the config* is what validates the environment — before any listener binds. Every offending key is
 * reported in one throw, not one restart per key.
 *
 * `.env.example` is a projection of this declaration, never a hand-maintained twin.
 *
 * `required: false` on almost everything is deliberate and not laziness: unset means **embedded**.
 * `x dev` runs Postgres in-process, events in-process and storage on local disk, so a clone boots
 * with no credentials and no Docker. Production supplies the real values; the same image reads both.
 */
export const env = defineEnv({
  // --- Core ---
  DATABASE_URL: { type: 'url', required: false, description: 'unset = embedded PGlite' },
  NATS_URL: { type: 'url', required: false, role: ['sync', 'worker'] },
  PORT: { type: 'port', default: 3000 },
  // Its own port, because a worker serves no HTTP and must still be scrapable.
  METRICS_PORT: { type: 'port', default: 9090 },
  // Stamped by CI from the git sha. Namespaces every service-worker cache, drives version-skew
  // detection, and tags reported errors with the commit that caused them.
  BUILD_ID: { type: 'string', required: false },
  APP_URL: {
    type: 'url',
    default: 'http://localhost:3000',
    description: 'absolute origin; the typed client has no origin without it',
  },

  // --- Object storage (S3 API; R2 in production) ---
  S3_ENDPOINT: { type: 'url', required: false, description: 'unset = local disk under .x/storage' },
  S3_BUCKET: { type: 'string', required: false },
  S3_ACCESS_KEY_ID: { type: 'string', required: false, secret: true },
  S3_SECRET_ACCESS_KEY: { type: 'string', required: false, secret: true },
  MEDIA_PUBLIC_BASE_URL: { type: 'url', required: false },

  // --- Anti-bot ---
  // The site key is public and ships to the browser. The secret is server-only and never bundled;
  // unset selects the null verifier so signup and login work locally with no keys.
  HCAPTCHA_SITE_KEY: { type: 'string', required: false },
  HCAPTCHA_SECRET: { type: 'string', required: false, secret: true },

  // --- Error monitoring ---
  // A DSN is a public ingest key, not a credential — but it is still not something to log, and an
  // unset value must read as "reporting off", never as "on but broken".
  SENTRY_DSN: { type: 'string', required: false },
});

export const config = defineConfig({
  name: 'social-media-clone',
  locales: ['en'],
  defaultLocale: 'en',
  defaultTimeZone: 'UTC',
  defaultCurrency: 'USD',
  // Without `signInPath` a browser that opens /dashboard with no session is answered with the
  // problem+json document — correct for an agent, and rendered as raw JSON text to a person.
  // Naming the page turns that into a 303 carrying `?next=`, and the page sends them back.
  auth: { signInPath: '/signin', afterSignInPath: '/dashboard' },
  // Env KEYS, never the value: the same image deploys to every environment. The database URL is
  // `DATABASE_URL` and the pool is sized by `DATABASE_POOL_MAX` — both read from the environment,
  // because `config.database`'s `urlEnv`/`poolSize` were read by nothing and were deleted
  // `As of 2026-08`.
  cache: { driver: 'memory', tiers: ['memo', 'lru'] },
  jobs: { queues: ['social-media-clone-default'], concurrency: 4 },
  // In-process transport by default; set urlEnv and transport: 'nats' to scale past one node.
  realtime: { enabled: true, tier: 'live-queries', transport: 'memory' },
  pwa: { enabled: true, offline: 'runtime', installPrompt: true },
  ai: { mcp: { expose: true, path: '/mcp' } },
});
