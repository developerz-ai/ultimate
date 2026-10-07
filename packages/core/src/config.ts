// Single responsibility: `app.config.ts` — the one config file. Deeply optional with real
// defaults, validated eagerly, and composable so a big app can split it across `config/*.ts`
// without inventing a second config mechanism.

// Same rule for the same reason: `app.config.ts` CONSUMES the cache tier names, it does not own
// them. Declaring them here is what let `cache.tiers` and the ladder `@ultimat3/cache` orders by
// drift into two vocabularies with no map between them (issue #293).
import { CACHE_TIERS, type CacheTierName } from './cache-vocabulary';
import type { AiConfig, AiConfigInput } from './config-ai';
import { countIssue } from './config-count';
import { configDefaults } from './config-defaults';
import { BASE_FIX, CACHE_TIER_FIX } from './config-fixes';
import { type DrainConfig, type HealthConfig, readinessModeIssue } from './config-health';
import type { IslandsConfig, IslandsSectionInput } from './config-islands';
import { islandsIssues, mergeIslands } from './config-islands';
import { type JobsConcurrency, jobsConcurrencyIssues } from './config-jobs';
import { refuseUnknownKeys } from './config-keys';
import { type MailConfig, type MailSectionInput, mailIssues, mergeMail } from './config-mail';
import { type Input, lastSaid, layered } from './config-merge';
import type { NavigationConfig, NavigationSectionInput } from './config-navigation';
import { mergeNavigation, navigationIssues } from './config-navigation';
import type { PwaConfig, PwaOfflineConfig } from './config-pwa';
import { PWA_FIX, pwaIssues } from './config-pwa';
import { removedKeyFix, removedKeyIssue, removedKeysIn } from './config-removed';
import {
  booleanIssue,
  nameListIssues,
  oneOfIssue,
  routePathIssue,
  shapeIssues,
} from './config-shape';
import type { SeoConfig, SiteConfig, SiteSectionsInput } from './config-site';
import { mergeSite, siteIssues } from './config-site';
import { drainIssues } from './drain-deadline';
import { describeValue } from './error-render';
import { ConfigInvalidError } from './errors';
import { ROLES, type Role } from './roles';

export const THEME_MODES = ['light', 'dark', 'system'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];
/**
 * The buses `@ultimat3/realtime`'s `selectTransport` builds, and nothing else. `'redis'` was in
 * this union until 22.0.0 with no Redis transport anywhere: it booted whatever `NATS_URL` chose.
 */
export const REALTIME_TRANSPORTS = ['memory', 'nats'] as const;
export type RealtimeTransport = (typeof REALTIME_TRANSPORTS)[number];

/**
 * No `tokens` (deleted in 25.0.0): read by nothing once the theme seam landed — the app's theme is
 * `export const brand = defineTheme(…)` from `@ultimat3/ui`. A second theming path nothing read.
 */
export interface ThemeConfig {
  readonly defaultMode: ThemeMode;
}

/**
 * Where a browser that failed `auth: 'required'` is sent.
 *
 * `signInPath: null` is the default and the redirect stays off until an app names its page: the
 * framework may not invent one of its app's routes, and an app that spells it `/login` would send
 * every unauthenticated visitor to a 404. Null means the visitor gets the problem document — the
 * right answer for an agent, and what a browser got in production until this existed.
 *
 * `afterSignInPath` was removed 2026-08, like `database.urlEnv` (below): read by NO file. The
 * landing path belongs to the app's sign-in route, the only code that can honour it.
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
 * `poolSize` was a dead second spelling of `DATABASE_POOL_MAX`; `client.ts` reads `DATABASE_URL`
 * as a literal, so no `urlEnv` could be honoured; nothing emits `SET search_path` for `schema`.
 *
 * Wiring them instead would need a tier-0 → tier-1 read the tier table forbids. Deleting is axiom
 * 3 applied to configuration: a value that produces neither a build error nor a runtime effect is
 * worse than no field, because an SRE sets `poolSize: 3`, redeploys, and nothing changes.
 */
const DATABASE_DRIVERS = ['postgres'] as const;

export interface DatabaseConfig {
  readonly driver: (typeof DATABASE_DRIVERS)[number];
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
  /** Order is fixed by `CACHE_TIERS`; listing order here selects rungs, it does not rank them. */
  readonly tiers: readonly CacheTierName[];
}

const JOB_BACKOFFS = ['exponential', 'fixed'] as const;

export interface JobsConfig {
  /**
   * No `driver`. It accepted `'postgres' | 'redis' | 'nats'`, was read by NOTHING, and boot always
   * built the Postgres driver — so `jobs: { driver: 'redis' }` did not throw, did not warn, and
   * silently gave you Postgres. Deleted 2026-08-20 (5.0.0); since 25.0.0 a config still writing it
   * is REFUSED by name (`config-removed.ts`) rather than carried through the spread.
   *
   * The seam that works is `setJobDriver(driver)` —
   * `setJobDriver(postgresJobDriver({ executor }))`, or `setJobDriver(memoryJobDriver())` in a
   * test. Swap the driver, zero job-code change, which is the whole of what the `JobDriver`
   * interface buys. There is no config line, and one that cannot be honoured is worse than none.
   */
  readonly queues: readonly string[];
  /**
   * Slots per worker process: one number for every queue it serves, or a table per queue
   * (`{ banks: 4, 'banks-long': 2 }`, a queue it does not name at `JOBS_CONCURRENCY_DEFAULT`).
   */
  readonly concurrency: JobsConcurrency;
  readonly maxAttempts: number;
  readonly backoff: (typeof JOB_BACKOFFS)[number];
  readonly visibilityTimeoutMs: number;
}

/**
 * No `heartbeatMs`. It was declared here, defaulted to 15_000, and read by NOTHING — deleted
 * 2026-08-19. The socket beat is `new LiveClient({ heartbeatMs })`, browser code that cannot read
 * server config, and the presence beat is DERIVED (`PresenceRegistry.heartbeatMs` is
 * `max(1000, floor(ttlMs / 3))`). A second knob is a second number that can disagree with the one
 * it is a fraction of, and a knob nothing reads is a knob nothing enforces — axioms 1 and 3.
 *
 * No `tier` either (deleted 2026-08-23): no file read it, so `tier: 'local-first'` bought nothing.
 * An app's realtime tier is what it DECLARES — a `channel()` topic, a `live: true` query, a local
 * store — never a config key. `transport`, `urlEnv` and the two per-actor caps (read by the `sync`
 * role into its registry and node) are the fields code reads.
 */
export interface RealtimeConfig {
  readonly enabled: boolean;
  readonly transport: RealtimeTransport;
  readonly urlEnv: string | undefined;
  /** Live subscriptions one actor (or anonymous network) may hold per sync node. Unset: 1,000. */
  readonly maxSubscriptionsPerActor?: number | undefined;
  /** Sockets one actor (or anonymous network) may hold per sync node. Unset: 16. */
  readonly maxSocketsPerActor?: number | undefined;
}

/**
 * No `locales` / `defaultLocale`, `defaultTimeZone` or `defaultCurrency` (deleted in 25.0.0, and
 * REFUSED by name when written — `config-removed.ts`). The locales were a second declaration of
 * `defineCatalogs({ default })`; the zone and the currency were read by nothing, and an ambient
 * default for either is the defect the framework forbids (every format call takes its zone, every
 * `Money` its currency).
 */
export interface AppConfig {
  readonly name: string;
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
  readonly health: HealthConfig;
  readonly site: SiteConfig;
  readonly seo: SeoConfig;
  readonly navigation: NavigationConfig;
  readonly islands: IslandsConfig;
  readonly mail: MailConfig;
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

export interface AppConfigInput
  extends SiteSectionsInput,
    NavigationSectionInput,
    IslandsSectionInput,
    MailSectionInput {
  readonly name: string;
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
  readonly health?: Input<HealthConfig> | undefined;
}

/** An overlay from `config/<concern>.ts`. No `name` — the base owns it. */
export type AppConfigOverlay = Omit<AppConfigInput, 'name'> & { readonly name?: string };

const NAME_RE = /^[a-z][a-z0-9-]{1,63}$/;

function validate(config: AppConfig): void {
  const issues: string[] = [];
  // Zero or one entry, and it exists for the upgrade: an 8.0.0 app carrying `['memo', 'shared']`
  // in an untyped config file reaches here rather than the compiler, and needs the new spelling.
  const tierFix: string[] = [];
  // Same shape again: carried only when an installable app is missing what an install needs.
  const pwaFix: string[] = [];

  // `typeof` first: `NAME_RE.test(undefined)` tests the string "undefined", which matches.
  if (typeof config.name !== 'string') {
    issues.push(`name must be a string like "my-app", not ${describeValue(config.name)}`);
  } else if (!NAME_RE.test(config.name)) {
    issues.push(`name "${config.name}" must match ${String(NAME_RE)}`);
  }
  if (config.roles.length === 0) issues.push('roles must list at least one runtime role');
  // ONE check per key, each against the key's own domain. A number is never a bare `< 1` — every
  // comparison with `NaN` is false, so `concurrency < 1` passed `NaN`, `2.5` and `Infinity` — and
  // a switch is never read for truthiness: `ssl: 'false'` and `enabled: 'false'` were both ON.
  const perKey: readonly (string | undefined)[] = [
    ...config.roles.map((role) => oneOfIssue('roles', role, ROLES)),
    ...jobsConcurrencyIssues(config.jobs.concurrency),
    countIssue('jobs.maxAttempts', config.jobs.maxAttempts, 1),
    countIssue('jobs.visibilityTimeoutMs', config.jobs.visibilityTimeoutMs, 1),
    oneOfIssue('jobs.backoff', config.jobs.backoff, JOB_BACKOFFS),
    countIssue('cache.defaultTtlMs', config.cache.defaultTtlMs, 0),
    oneOfIssue('database.driver', config.database.driver, DATABASE_DRIVERS),
    booleanIssue('database.ssl', config.database.ssl),
    oneOfIssue('theme.defaultMode', config.theme.defaultMode, THEME_MODES),
    // `null` is the documented "no redirect"; a path that is said must be one a browser can follow.
    config.auth.signInPath === null
      ? undefined
      : routePathIssue('auth.signInPath', config.auth.signInPath),
    booleanIssue('ai.mcp.expose', config.ai.mcp.expose),
    booleanIssue('realtime.enabled', config.realtime.enabled),
    oneOfIssue('realtime.transport', config.realtime.transport, REALTIME_TRANSPORTS),
    ...(['maxSubscriptionsPerActor', 'maxSocketsPerActor'] as const).map((key) =>
      config.realtime[key] === undefined
        ? undefined
        : countIssue(`realtime.${key}`, config.realtime[key], 1),
    ),
    ...drainIssues(config.drain),
    readinessModeIssue(config.health.readiness),
  ];
  for (const issue of perKey) if (issue !== undefined) issues.push(issue);
  nameListIssues('jobs.queues', config.jobs.queues, 'queue', issues);
  if (config.realtime.transport === 'nats' && config.realtime.urlEnv === undefined) {
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
  // remedy: `pwa.enabled` turning four other requirements on is a question about that block alone.
  if (pwaIssues(config.pwa, issues)) pwaFix.push(PWA_FIX);
  siteIssues(config, issues);
  navigationIssues(config, issues);
  islandsIssues(config, issues);
  mailIssues(config, issues);

  // A rung the ladder cannot build is the defect this key had: `sortTiers` places a name by its
  // index in `CACHE_TIERS`, and a name missing from it sorts to `-1` — AHEAD of the request memo.
  // So an unknown tier is refused at boot rather than silently ignored or silently placed first.
  // An EMPTY ladder is refused with the unknown rung: it builds no tier at all, so every read
  // misses and nothing says the cache was configured away.
  if (config.cache.tiers.length === 0) issues.push('cache.tiers must list at least one tier');
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
      fix: [...tierFix, ...pwaFix, BASE_FIX].join('. '),
      meta: { issues },
    });
  }
}

/**
 * Every layer, in order, merged per section and KEY BY KEY — see `layered`. `name` comes from the
 * input alone because it identifies the app: an overlay may not rename it. No layer at all is the
 * defaults, which is the reference `shapeIssues` compares each layer against.
 */
function merge(name: string, layers: readonly AppConfigOverlay[]): AppConfig {
  const base = configDefaults(name);
  return {
    name,
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
    health: layered(
      base.health,
      layers.map((layer) => layer.health),
    ),
    ...mergeSite(layers),
    ...mergeNavigation(layers),
    ...mergeIslands(layers),
    ...mergeMail(layers),
  };
}

/**
 * FIRST, before shape: a removed key is an instruction the app is still giving, and the answer is
 * the line to delete and what replaces it — never silence, and never a shape complaint about a
 * section (`theme.tokens: null`) that no longer has the key at all. Every layer is asked, so a
 * stale `config/theme.ts` overlay is caught as surely as the base.
 */
function refuseRemovedKeys(layers: readonly unknown[]): void {
  const removed = [...new Set(layers.flatMap((layer) => removedKeysIn(layer)))];
  if (removed.length === 0) return;
  const issues = removed.map(removedKeyIssue);
  throw new ConfigInvalidError({
    cause: issues.join('; '),
    fix: [...removed.map(removedKeyFix), BASE_FIX].join('. '),
    meta: { issues, removed },
  });
}

/**
 * The single config entry point. Later overlays win, so `config/jobs.ts` can own jobs without
 * touching `app.config.ts`.
 */
export function defineConfig(
  input: AppConfigInput,
  ...overlays: readonly AppConfigOverlay[]
): AppConfig {
  const layers: readonly AppConfigOverlay[] = [input, ...overlays];
  refuseRemovedKeys(layers);
  // Structure FIRST, per layer and before the merge: a section written as `null` or a list
  // written as a string is what `Object.entries` and `.length` raised a native `TypeError` on.
  const issues: string[] = [];
  // `navigation` is left out: `config-navigation.ts` carries a wrong shape through AS WRITTEN and
  // refuses it in its own words, with the surfaces it accepts.
  const reference = { ...merge(input.name, []), navigation: undefined };
  // Closed BEFORE shape: a typo'd section (`drian: null`) is the wrong name, not the wrong kind.
  refuseUnknownKeys(reference, layers);
  for (const layer of layers) shapeIssues(reference, layer, issues);
  if (issues.length > 0) {
    throw new ConfigInvalidError({ cause: issues.join('; '), fix: BASE_FIX, meta: { issues } });
  }
  const config = merge(input.name, layers);
  validate(config);
  return Object.freeze(config);
}
