// Single responsibility: every environment variable name the framework itself reads, and which
// package reads it — the one list `x doctor` judges an app's own names against. Held complete by
// `scripts/framework-env.ts`: a literal env read in `packages/*/src` that is not here is red.

/**
 * What reading the name means for an app that also uses it.
 * - `contract`: the deploy contract — an app sets it, and may declare it in its `envSchema`: every
 *   adapter setting and credential (object storage, mail, a CDN, replication) is one, because
 *   declaring it IS how an app configures that adapter, and renaming it switches the adapter off.
 * - `switch`: present, it turns a framework behaviour on that no app configures by that name (the
 *   OpenTelemetry signal family). An app holding it for its own purpose turns that on by accident.
 * - `internal`: the framework sets it for itself, or reads it only in a gate or a test harness.
 * - `host`: the platform's (`HOME`, `CI`); read, never owned.
 */
export type FrameworkEnvUse = 'contract' | 'switch' | 'internal' | 'host';

export interface FrameworkEnvName {
  /** The exact name, or — with `prefix` — the head every name the framework reads under it shares. */
  readonly name: string;
  readonly prefix?: true;
  /** The package that reads it, unscoped (`cache` is `@ultimat3/cache`). */
  readonly owner: string;
  readonly use: FrameworkEnvUse;
}

const contract = (owner: string, ...names: string[]): FrameworkEnvName[] =>
  names.map((name) => ({ name, owner, use: 'contract' }));
const toggles = (owner: string, ...names: string[]): FrameworkEnvName[] =>
  names.map((name) => ({ name, owner, use: 'switch' }));
const internal = (owner: string, ...names: string[]): FrameworkEnvName[] =>
  names.map((name) => ({ name, owner, use: 'internal' }));
const host = (owner: string, ...names: string[]): FrameworkEnvName[] =>
  names.map((name) => ({ name, owner, use: 'host' }));
const prefix = (name: string, owner: string, use: FrameworkEnvUse): FrameworkEnvName => ({
  name,
  prefix: true,
  owner,
  use,
});

/**
 * Grouped by owner. Built from a grep of `packages/*\/src` (2026-11-12) plus the names the
 * framework reads through a constant (`CURSOR_SECRET_KEY`), which no literal scan can see.
 */
export const FRAMEWORK_ENV: readonly FrameworkEnvName[] = [
  ...contract('ai', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'EMBEDDINGS_API_KEY'),
  ...internal('ai', 'ULTIMATE_EVAL_RECORD'),
  ...contract('auth', 'SESSION_SECRET'),
  ...contract('auth', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'),
  ...contract('auth', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'),
  ...contract('cache', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ZONE_ID'),
  ...contract('cache', 'FASTLY_API_TOKEN', 'FASTLY_SERVICE_ID'),
  ...contract('cli', 'APP_URL', 'SITE_ORIGIN', 'SYNC_URL', 'HOST', 'PORT', 'METRICS_PORT'),
  ...contract('cli', 'NODE_ENV', 'TRUSTED_PROXY_HOPS', 'WORKER_QUEUES', 'SENTRY_DSN'),
  ...contract('cli', 'S3_ENDPOINT', 'S3_BUCKET', 'S3_REGION', 'S3_FORCE_PATH_STYLE'),
  ...contract('cli', 'SCRAPE_CDP_URL'),
  ...toggles('cli', 'OTEL_SDK_DISABLED'),
  ...internal('cli', 'ULTIMATE_SEED_TIER', 'ULTIMATE_STATE_DIR', 'ULTIMATE_BUILD_CAPTURE'),
  ...internal('cli', 'ULTIMATE_DEV_CHILD', 'ULTIMATE_DEV_SUPERVISOR_PID', 'X_ENV'),
  ...internal('cli', 'ULTIMATE_KEEP_GLOBAL_CLI', 'ULTIMATE_VERIFY_STEP', 'CI_RUNNER'),
  ...host('cli', 'CI', 'GITHUB_SHA', 'GITHUB_BASE_REF', 'EDITOR', 'VISUAL'),
  ...contract('core', 'ULTIMATE_ENV', 'ROLE', 'BUILD_ID', 'APP_VERSION', 'LOG_LEVEL'),
  ...contract('core', 'ULTIMATE_CURSOR_SECRET', 'ULTIMATE_SECRETS_KEY'),
  ...contract('core', 'ULTIMATE_SECRETS_RETIRED_KEYS', 'METRICS_INTERVAL_MS'),
  ...contract('core', 'REDIS_URL', 'VALKEY_URL'),
  ...contract('core', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS'),
  ...contract('core', 'OTEL_EXPORTER_OTLP_PROTOCOL', 'OTEL_TRACES_SAMPLER'),
  ...contract('core', 'OTEL_TRACES_SAMPLER_ARG'),
  // The signal-specific family (`OTEL_TRACES_EXPORTER`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`).
  prefix('OTEL_', 'core', 'switch'),
  ...host('core', 'USERNAME', 'USERDOMAIN'),
  ...contract('db', 'DATABASE_URL', 'DATABASE_POOL_MAX', 'DATABASE_POOLER'),
  ...contract('db', 'DATABASE_REPLICA_URL', 'DB_RETRY'),
  ...internal('db', 'ROLLBACK_ALLOW_DESTRUCTIVE'),
  ...host('jobs', 'HOSTNAME'),
  ...contract('mail', 'MAIL_FROM', 'MAIL_POOL_SIZE'),
  ...contract('mail', 'RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET', 'SMTP_URL'),
  ...contract('mail', 'SES_ACCESS_KEY_ID', 'SES_SECRET_ACCESS_KEY', 'SES_SESSION_TOKEN'),
  ...contract('mail', 'SES_REGION', 'SES_ENDPOINT', 'SES_CONFIGURATION_SET'),
  ...contract('notify', 'ULTIMATE_APNS_PRIVATE_KEY', 'ULTIMATE_FCM_PRIVATE_KEY'),
  ...contract('pwa', 'ULTIMATE_VAPID_PUBLIC_KEY', 'ULTIMATE_VAPID_PRIVATE_KEY'),
  ...contract('realtime', 'NATS_URL', 'NATS_KV_BUCKET'),
  ...contract('realtime', 'REPLICATION_URL', 'REPLICATION_SLOT', 'REPLICATION_PUBLICATION'),
  ...contract('scraping', 'CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH'),
  ...host('scraping', 'HOME', 'TMPDIR', 'LOCALAPPDATA'),
  ...contract('storage', 'STORAGE_SIGNING_SECRET'),
  ...contract('storage', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_SESSION_TOKEN'),
  ...contract('storage', 'AWS_ENDPOINT', 'AWS_REGION', 'AWS_SESSION_TOKEN'),
  ...internal('testing', 'TEST_DATABASE_URL', 'TEST_NATS_URL', 'TEST_REDIS_URL', 'TZ'),
  ...internal('testing', 'ULTIMATE_TEST_ALLOW_NET', 'ULTIMATE_TEST_NOW', 'ULTIMATE_TEST_SEED'),
  ...internal('testing', 'ULTIMATE_TEST_SLOT_HELD', 'ULTIMATE_TEST_ISOLATED'),
  ...internal('testing', 'ULTIMATE_CASSETTE', 'ULTIMATE_JOB_SIM_SEED'),
  // Every `ULTIMATE_*` is the framework's: a name under it an app invents may be read tomorrow.
  prefix('ULTIMATE_', 'core', 'internal'),
];

const EXACT = new Map<string, FrameworkEnvName>();
for (const entry of FRAMEWORK_ENV) if (entry.prefix !== true) EXACT.set(entry.name, entry);
const PREFIXES = FRAMEWORK_ENV.filter((entry) => entry.prefix === true).sort(
  (a, b) => b.name.length - a.name.length,
);

/** The framework's entry for `name` — the exact name first, else the longest prefix it falls under. */
export const frameworkEnvEntry = (name: string): FrameworkEnvName | undefined =>
  EXACT.get(name) ?? PREFIXES.find((entry) => name.startsWith(entry.name));
