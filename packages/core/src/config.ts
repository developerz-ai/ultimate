// Single responsibility: `app.config.ts` — the one config file. Deeply optional with real
// defaults, validated eagerly, and composable so a big app can split it across `config/*.ts`
// without inventing a second config mechanism.

import { CURRENCY_CODE_PATTERN } from '@ultimat3/schema';
// Same rule for the same reason: `app.config.ts` CONSUMES the cache tier names, it does not own
// them. Declaring them here is what let `cache.tiers` and the ladder `@ultimat3/cache` orders by
// drift into two vocabularies with no map between them (issue #293).
import { CACHE_TIERS, type CacheTierName } from './cache-vocabulary';
import { countIssue } from './config-count';
import { BASE_FIX, CACHE_TIER_FIX, TIMEZONE_FIX } from './config-fixes';
import { type Input, lastSaid, layered } from './config-merge';
import type { PwaConfig, PwaOfflineConfig } from './config-pwa';
import { PWA_FIX, pwaIssues } from './config-pwa';
import type { SeoConfig, SiteConfig, SiteSectionsInput } from './config-site';
import { mergeSite, siteIssues } from './config-site';
import { describeValue } from './error-render';
import { ConfigInvalidError } from './errors';
import { defaultReadinessGraceMs, readinessGraceIssue } from './lifecycle-grace';
import { ROLES, type Role } from './roles';
import { isIanaZoneName } from './time-zone-name';

export type ThemeMode = 'light' | 'dark' | 'system';
/**
 * The buses `@ultimat3/realtime`'s `selectTransport` builds, and nothing else. `'redis'` was in
 * this union until 22.0.0 with no Redis transport anywhere: it booted whatever `NATS_URL` chose.
 */
export const REALTIME_TRANSPORTS = ['memory', 'nats'] as const;
export type RealtimeTransport = (typeof REALTIME_TRANSPORTS)[number];

export interface ThemeConfig {
  readonly defaultMode: ThemeMode;
  /** Semantic design tokens. Raw hex is a lint error in components, never here. */
  readonly tokens: Readonly<Record<string, string>>;
}

/**
 * Where a browser that failed `auth: 'required'` is sent.
 *
 * `signInPath: null` is the default and the redirect stays off until an app names its page: the
 * framework may not invent one of its app's routes, and an app that spells it `/login` would send
 * every unauthenticated visitor to a 404. Null means the visitor gets the problem document — the
 * right answer for an agent, and what a browser got in production until this existed.
 *
 * `afterSignInPath` was removed 2026-08 for the reason `urlEnv`, `poolSize` and `schema` were
 * (below): accepted, defaulted and merged here, and read by NO file — `dummy/social-media-clone`
 * set `/dashboard` and got whatever its sign-in route did on its own. The landing path belongs to
 * the app's sign-in route, which is the only code that can honour it.
 */
export interface AuthConfig {
  readonly signInPath: string | null;
}

/**
 * Retention for `x_notify_inbox`, and the one framework table whose window the framework may not
 * pick. Every other one holds bookkeeping whose job ENDS — an idempotency key, a rate-limit
 * bucket, an auth challenge, a delivery claim — and a sweep is unambiguously right. An inbox row
 * is a message a person has not read yet, so when it disappears is a product decision, which is
 * axiom 8: Ultimate ships mechanism, your app ships convention.
 *
 * BOTH DEFAULT TO `undefined`, meaning never swept, and that is the only safe default here: the
 * failure mode of keeping rows is a table that grows, and the failure mode of guessing a number is
 * a notification the recipient never got to read.
 *
 * TWO WINDOWS RATHER THAN ONE, because the axiom-8 objection is only about UNREAD messages. An app
 * that wants read notices gone in a month and unread ones kept forever must be able to say exactly
 * that, and `SQL_NOTIFY_INBOX_MARK_READ` already stamps the time that makes it expressible.
 *
 * Milliseconds and not a `DurationInput`: that type lives in `@ultimat3/jobs` (tier 3) and this
 * package is tier 0, which is the same reason `cache.defaultTtlMs` and `jobs.visibilityTimeoutMs`
 * are spelled this way.
 */
export interface NotifyConfig {
  /** Age of a row's `read_at`, not its `created_at` — a row ages from when it was READ. */
  readonly inboxReadRetentionMs: number | undefined;
  /** Age of an unread row's `created_at`. Setting this deletes messages nobody has read. */
  readonly inboxUnreadRetentionMs: number | undefined;
}

/**
 * Every window `validate` screens, derived from nothing — a third one added to `NotifyConfig`
 * without a row here is a window an app can set to `-1`, and `config.test.ts` asserts the two
 * lists agree so the omission is a red test rather than a silent hole.
 */
export const INBOX_RETENTION_KEYS = ['inboxReadRetentionMs', 'inboxUnreadRetentionMs'] as const;
/**
 * Deliberately thin. `urlEnv`, `poolSize` and `schema` were removed 2026-08 because **nothing
 * read them** — the only reader of any `config.database.*` field in the repo was this file's own
 * validator, and each of the three was unfixable where it sat:
 *
 * - `poolSize` — `@ultimat3/db`'s `baseClient()` layers `DATABASE_POOL_MAX` over the role profile,
 *   so the knob works; this was a second, non-functioning spelling of it.
 * - `urlEnv` — `client.ts` reads `process.env['DATABASE_URL']` as a hardcoded literal, so a
 *   different key here could not be honoured.
 * - `schema` — nothing emits `SET search_path`.
 *
 * Wiring them instead would need a tier-0 → tier-1 read the tier table forbids. Deleting is axiom
 * 3 applied to configuration: a value that produces neither a build error nor a runtime effect is
 * worse than no field, because an SRE sets `poolSize: 3`, redeploys, and nothing changes.
 */
export interface DatabaseConfig {
  readonly driver: 'postgres';
  readonly ssl: boolean;
}

/**
 * No `CacheTier`. It was a SECOND spelling of the ladder — `memo | lru | shared | isr | cdn`
 * against `@ultimat3/cache`'s `request-memo | lru | redis | cdn` — with nothing mapping one onto
 * the other, so `cache: { tiers: ['isr'] }` typechecked and selected nothing. Deleted 2026-08-22
 * in favour of `CacheTierName`, which is the ladder's own names and the only ones `sortTiers` can
 * place. It was also the second exported type called `CacheTier` in the tree; the other is
 * `@ultimat3/cache`'s tier INTERFACE, which is the one every implementation names.
 *
 * No `driver` and no `urlEnv` either, deleted 2026-08-22 and for the same reason one rung further
 * up: `tiers` is what BUILDS the ladder (`packages/cli/src/dev-cache.ts`), so `driver: 'redis'`
 * beside `tiers: ['request-memo', 'lru']` was a second selector that selected nothing — the shape
 * `examples/dummy/app.config.ts` shipped. `urlEnv` was `database.urlEnv` verbatim: the Redis tier
 * reads the literal `REDIS_URL`, so `urlEnv: 'MY_REDIS'` made nothing read `MY_REDIS`. Which rungs
 * exist is `cache.tiers` and only that; a rung the environment cannot supply refuses the boot.
 */
export interface CacheConfig {
  readonly defaultTtlMs: number;
  /** Order is fixed by `TIER_ORDER`; listing order here selects rungs, it does not rank them. */
  readonly tiers: readonly CacheTierName[];
}

export interface JobsConfig {
  /**
   * No `driver`. It accepted `'postgres' | 'redis' | 'nats'`, was read by NOTHING, and boot always
   * built `createPgDriver` — so `jobs: { driver: 'redis' }` did not throw, did not warn, and
   * silently gave you Postgres. Deleted 2026-08-20, and it is the worse shape of the same defect
   * `realtime.heartbeatMs` was: a knob that fails SILENTLY in the dangerous direction.
   *
   * The seam that works is `setJobDriver(driver)` — `setJobDriver(createPgDriver({ executor }))`,
   * or `setJobDriver(createMemoryDriver())` in a test. Swap the driver, zero job-code change, which
   * is the whole of what the `JobDriver` interface buys. There is no config line, and one that
   * cannot be honoured is worse than none.
   */
  readonly queues: readonly string[];
  readonly concurrency: number;
  readonly maxAttempts: number;
  readonly backoff: 'exponential' | 'fixed';
  readonly visibilityTimeoutMs: number;
}

/**
 * No `heartbeatMs`. It was declared here, defaulted to 15_000, and read by NOTHING — deleted
 * 2026-08-19. The socket beat is `new LiveClient({ heartbeatMs })`, browser code that cannot read
 * server config, and the presence beat is DERIVED (`PresenceRegistry.heartbeatMs` is
 * `max(1000, floor(ttlMs / 3))`). A second knob is a second number that can disagree with the one
 * it is a fraction of, and a knob nothing reads is a knob nothing enforces — axioms 1 and 3.
 *
 * No `tier` either, and no `RealtimeTier` — deleted 2026-08-23, the thirteenth instance of the
 * same defect and the dangerous shape of it. It accepted
 * `'channels' | 'live-queries' | 'local-first'`, defaulted to `'channels'`, was documented with
 * per-value semantics, was set by both tracked apps — and no file anywhere compared it, branched
 * on it or dereferenced it. `transport` and `urlEnv` are the only two fields of this section any
 * code reads. So `tier: 'local-first'` bought the durable client store that does not exist
 * (`createOpfsLocalStore` still throws `X_NOT_IMPLEMENTED`), exactly as `jobs: { driver: 'redis' }`
 * bought Postgres. Which realtime tier an app is on is decided by what it DECLARES — a `channel()`
 * topic, a `live: true` query, a local store — never by a config key.
 */
export interface RealtimeConfig {
  readonly enabled: boolean;
  readonly transport: RealtimeTransport;
  readonly urlEnv: string | undefined;
}

export interface McpConfig {
  readonly expose: boolean;
  readonly path: string;
}

/**
 * No `modelEnv`. It named the env KEY holding the model id, "so no model string is baked into the
 * image" — and its only reader was this file's own merge, copying input to output. Nothing
 * consumed the merged value, so `modelEnv: 'ANTHROPIC_MODEL'` selected no model: `@ultimat3/ai`
 * reads env for API KEYS only, and the model is `request.model ?? DEFAULT_MODEL`, a compile-time
 * constant in `models.ts`. The exact thing the key existed to prevent is what it delivered.
 * Deleted 2026-08 — pass `model` on the request, or read your own env key and pass it.
 */
export interface AiConfig {
  readonly mcp: McpConfig;
}

/**
 * How a SIGTERM'd process leaves the load balancer. Read by `@ultimat3/http`'s `createServer`
 * (`ServerOptions.drain`), which hands it to core's `configureLifecycle`.
 */
export interface DrainConfig {
  /**
   * `/readyz` answers 503 for this long before the listener closes, so endpoints stop routing here
   * first. Default 0 in development/test and 5000 everywhere else — a process naming NO environment
   * included. A whole number, 0–60000. The chart's `terminationGracePeriodSeconds` must exceed it
   * plus the drain budget.
   */
  readonly readinessGraceMs: number;
}

export interface AppConfig {
  readonly name: string;
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  readonly defaultTimeZone: string;
  readonly defaultCurrency: string;
  readonly theme: ThemeConfig;
  readonly auth: AuthConfig;
  readonly pwa: PwaConfig;
  readonly roles: readonly Role[];
  readonly database: DatabaseConfig;
  readonly cache: CacheConfig;
  readonly jobs: JobsConfig;
  readonly realtime: RealtimeConfig;
  readonly notify: NotifyConfig;
  readonly ai: AiConfig;
  readonly drain: DrainConfig;
  readonly site: SiteConfig;
  readonly seo: SeoConfig;
}

/** `mcp` is the only member, and it is NESTED — `Input<AiConfig>` would make it all-or-nothing. */
export interface AiConfigInput {
  readonly mcp?: Input<McpConfig> | undefined;
}

/**
 * `offline` is NESTED for `AiConfigInput`'s reason, and here it is load-bearing rather than
 * ergonomic: `section` applies a patch ONE level deep, so an app writing
 * `offline: { fallback: '/offline' }` under a flat `Input<PwaConfig>` would replace the whole
 * default block — leaving `image`, `font` and `neverCache` absent at run time while the type says
 * they are there, which is the exact shape of defect this repo keeps re-shipping.
 */
export interface PwaConfigInput extends Omit<Input<PwaConfig>, 'offline'> {
  readonly offline?: Input<PwaOfflineConfig> | undefined;
}

export interface AppConfigInput extends SiteSectionsInput {
  readonly name: string;
  readonly locales?: readonly string[] | undefined;
  readonly defaultLocale?: string | undefined;
  readonly defaultTimeZone?: string | undefined;
  readonly defaultCurrency?: string | undefined;
  readonly theme?: Input<ThemeConfig> | undefined;
  readonly auth?: Input<AuthConfig> | undefined;
  readonly pwa?: PwaConfigInput | undefined;
  readonly roles?: readonly Role[] | undefined;
  readonly database?: Input<DatabaseConfig> | undefined;
  readonly cache?: Input<CacheConfig> | undefined;
  readonly jobs?: Input<JobsConfig> | undefined;
  readonly realtime?: Input<RealtimeConfig> | undefined;
  readonly notify?: Input<NotifyConfig> | undefined;
  readonly ai?: AiConfigInput | undefined;
  readonly drain?: Input<DrainConfig> | undefined;
}

/** An overlay from `config/<concern>.ts`. No `name` — the base owns it. */
export type AppConfigOverlay = Omit<AppConfigInput, 'name'> & { readonly name?: string };

const NAME_RE = /^[a-z][a-z0-9-]{1,63}$/;

/**
 * Built from `@ultimat3/schema`'s `CURRENCY_CODE_PATTERN`, the framework's ONE declaration of what
 * an ISO 4217 code looks like — the same source `isCurrencyCode`, the published OpenAPI `pattern`
 * and `@ultimat3/entity`'s Postgres CHECK all derive from. It was a character-for-character copy
 * here until the `core -> schema` edge was declared (`scripts/lib/tiers.ts`), held equal only by a
 * pin test in `@ultimat3/cli`.
 */
const CURRENCY_RE = new RegExp(CURRENCY_CODE_PATTERN);

function isLocale(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

function defaults(name: string): Omit<AppConfig, 'name' | 'site' | 'seo'> {
  return {
    locales: ['en'],
    defaultLocale: 'en',
    defaultTimeZone: 'UTC',
    defaultCurrency: 'USD',
    theme: { defaultMode: 'system', tokens: {} },
    auth: { signInPath: null },
    pwa: {
      enabled: false,
      offline: { fallback: null, image: null, font: null, neverCache: [], personalPages: 'never' },
      backgroundSync: false,
      push: false,
      name: '',
      colors: undefined,
    },
    roles: [...ROLES],
    database: { driver: 'postgres', ssl: false },
    cache: { defaultTtlMs: 60_000, tiers: ['request-memo', 'lru'] },
    jobs: {
      queues: [`${name}-default`],
      concurrency: 8,
      maxAttempts: 5,
      backoff: 'exponential',
      visibilityTimeoutMs: 30_000,
    },
    // ON by default since 22.0.0, when the boot began obeying the key: an app with no section
    // keeps the `sync` node it always got, and `enabled: false` is the explicit opt-out.
    realtime: { enabled: true, transport: 'memory', urlEnv: undefined },
    notify: { inboxReadRetentionMs: undefined, inboxUnreadRetentionMs: undefined },
    ai: { mcp: { expose: true, path: '/mcp' } },
    // Read from the process env when the config is DEFINED — the same env the drain will run in.
    drain: { readinessGraceMs: defaultReadinessGraceMs() },
  };
}

function validate(config: AppConfig): void {
  const issues: string[] = [];
  // Zero or one entry: the zone's own remedy, carried only when the zone is what failed.
  const zoneFix: string[] = [];
  // Same shape, and it exists for the upgrade: an 8.0.0 app carrying `['memo', 'shared']` in an
  // untyped config file reaches here rather than the compiler, and needs the new spelling.
  const tierFix: string[] = [];
  // Same shape again: carried only when an installable app is missing what an install needs.
  const pwaFix: string[] = [];

  if (!NAME_RE.test(config.name)) {
    issues.push(`name "${config.name}" must match ${String(NAME_RE)}`);
  }
  if (config.locales.length === 0) issues.push('locales must list at least one locale');
  for (const locale of config.locales) {
    if (!isLocale(locale)) issues.push(`locales contains "${locale}", not a BCP-47 tag`);
  }
  if (!config.locales.includes(config.defaultLocale)) {
    issues.push(`defaultLocale "${config.defaultLocale}" is not in locales`);
  }
  // `@ultimat3/time`'s rule, restated because tier 0 cannot import tier 1 — see
  // `time-zone-name.ts`. One validator means a zone `app.config.ts` accepts is a zone every
  // `format` call, `task()` and `toZoned` below it can then do arithmetic in.
  if (!isIanaZoneName(config.defaultTimeZone)) {
    issues.push(
      `defaultTimeZone "${config.defaultTimeZone}" is not an IANA Area/Location zone name`,
    );
    zoneFix.push(TIMEZONE_FIX);
  }
  if (!CURRENCY_RE.test(config.defaultCurrency)) {
    issues.push(`defaultCurrency "${config.defaultCurrency}" is not a 3-letter ISO 4217 code`);
  }
  if (config.roles.length === 0) issues.push('roles must list at least one runtime role');
  // A domain per numeric key, never a bare `< 1`: every comparison with `NaN` is false, so the old
  // `concurrency < 1` passed `NaN`, `2.5` and `Infinity`, and nothing screened the other three.
  const counts: readonly (string | undefined)[] = [
    countIssue('jobs.concurrency', config.jobs.concurrency, 1),
    countIssue('jobs.maxAttempts', config.jobs.maxAttempts, 1),
    countIssue('jobs.visibilityTimeoutMs', config.jobs.visibilityTimeoutMs, 1),
    countIssue('cache.defaultTtlMs', config.cache.defaultTtlMs, 0),
    readinessGraceIssue(config.drain.readinessGraceMs),
  ];
  for (const issue of counts) if (issue !== undefined) issues.push(issue);
  if (config.jobs.queues.length === 0) issues.push('jobs.queues must list at least one queue');
  // An untyped config reaches here with whatever it wrote: a string is a name worth echoing, and
  // anything else goes through `describeValue` rather than `${…}`.
  const transport: unknown = config.realtime.transport;
  if (!REALTIME_TRANSPORTS.some((known) => known === transport)) {
    const said = typeof transport === 'string' ? `"${transport}"` : describeValue(transport);
    issues.push(`realtime.transport ${said} is not one of ${REALTIME_TRANSPORTS.join(', ')}`);
  } else if (transport === 'nats' && config.realtime.urlEnv === undefined) {
    issues.push(`realtime.transport "nats" requires realtime.urlEnv`);
  }
  // BOTH RETENTION WINDOWS OR NEITHER — `undefined` is a real value here (never swept) and the
  // only other legal one is a positive, finite count of milliseconds. Zero is refused rather than
  // read as "immediately": a sweep at age 0 deletes every row the instant it is written, which is
  // an inbox that silently receives nothing, and nobody types it on purpose. `describeValue`
  // rather than `${…}`: this validator is the boundary a JS app's untyped config crosses, so the
  // value here is `unknown` in practice however the interface types it.
  for (const key of INBOX_RETENTION_KEYS) {
    const ms: unknown = config.notify[key];
    if (ms === undefined) continue;
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
      issues.push(
        `notify.${key} must be a positive number of milliseconds, not ${describeValue(ms)}`,
      );
    }
  }

  // What an install needs, asked at BOOT and not at emit — `config-pwa.ts` owns the rules and the
  // remedy, because `pwa.enabled` turning four other requirements on is a question about that block
  // and nothing else here.
  if (pwaIssues(config.pwa, issues)) pwaFix.push(PWA_FIX);
  siteIssues(config, issues);

  // A rung the ladder cannot build is the defect this key had: `sortTiers` places a name by its
  // index in `CACHE_TIERS`, and a name missing from it sorts to `-1` — AHEAD of the request memo.
  // So an unknown tier is refused at boot rather than silently ignored or silently placed first.
  for (const tier of config.cache.tiers) {
    if (CACHE_TIERS.includes(tier)) continue;
    issues.push(`cache.tiers contains "${tier}", which is not one of ${CACHE_TIERS.join(', ')}`);
    if (tierFix.length === 0) tierFix.push(CACHE_TIER_FIX);
  }

  if (issues.length > 0) {
    throw new ConfigInvalidError({
      cause: issues.join('; '),
      // The generic instruction goes LAST so the fix line still ends in a command that can be
      // pasted — a trailing `.` after `x verify` is a command nobody can run.
      fix: [...zoneFix, ...tierFix, ...pwaFix, BASE_FIX].join('. '),
      meta: { issues },
    });
  }
}

/**
 * The single config entry point. Later overlays win, so `config/jobs.ts` can own jobs without
 * touching `app.config.ts`.
 */
export function defineConfig(
  input: AppConfigInput,
  ...overlays: readonly AppConfigOverlay[]
): AppConfig {
  const base = defaults(input.name);
  // Every layer, in order, merged per section and KEY BY KEY — see `layered`. `name` comes from
  // the input alone because it identifies the app: an overlay may not rename it.
  const layers: readonly AppConfigOverlay[] = [input, ...overlays];

  const config: AppConfig = {
    name: input.name,
    locales: lastSaid(
      base.locales,
      layers.map((layer) => layer.locales),
    ),
    defaultLocale: lastSaid(
      base.defaultLocale,
      layers.map((layer) => layer.defaultLocale),
    ),
    defaultTimeZone: lastSaid(
      base.defaultTimeZone,
      layers.map((layer) => layer.defaultTimeZone),
    ),
    defaultCurrency: lastSaid(
      base.defaultCurrency,
      layers.map((layer) => layer.defaultCurrency),
    ),
    theme: layered(
      base.theme,
      layers.map((layer) => layer.theme),
    ),
    auth: layered(
      base.auth,
      layers.map((layer) => layer.auth),
    ),
    // Two merges, one per level: the outer one may not see `offline` at all, or it would drop the
    // nested defaults `PwaConfigInput` exists to keep. Hence the cast — the outer patch is this
    // block minus the key the inner merge owns.
    pwa: {
      ...layered(
        base.pwa,
        layers.map((layer) => ({ ...layer.pwa, offline: undefined }) as Input<PwaConfig>),
      ),
      offline: layered(
        base.pwa.offline,
        layers.map((layer) => layer.pwa?.offline),
      ),
    },
    roles: lastSaid(
      base.roles,
      layers.map((layer) => layer.roles),
    ),
    database: layered(
      base.database,
      layers.map((layer) => layer.database),
    ),
    cache: layered(
      base.cache,
      layers.map((layer) => layer.cache),
    ),
    jobs: layered(
      base.jobs,
      layers.map((layer) => layer.jobs),
    ),
    realtime: layered(
      base.realtime,
      layers.map((layer) => layer.realtime),
    ),
    notify: layered(
      base.notify,
      layers.map((layer) => layer.notify),
    ),
    ai: {
      mcp: layered(
        base.ai.mcp,
        layers.map((layer) => layer.ai?.mcp),
      ),
    },
    drain: layered(
      base.drain,
      layers.map((layer) => layer.drain),
    ),
    ...mergeSite(layers),
  };

  validate(config);
  return Object.freeze(config);
}
