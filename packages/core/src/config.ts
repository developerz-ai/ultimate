// Single responsibility: `app.config.ts` — the one config file. Deeply optional with real
// defaults, validated eagerly, and composable so a big app can split it across `config/*.ts`
// without inventing a second config mechanism.

import { CURRENCY_CODE_PATTERN } from '@ultimat3/schema';
// Same rule for the same reason: `app.config.ts` CONSUMES the cache tier names, it does not own
// them. Declaring them here is what let `cache.tiers` and the ladder `@ultimat3/cache` orders by
// drift into two vocabularies with no map between them (issue #293).
import { CACHE_TIERS, type CacheTierName } from './cache-vocabulary';
import { describeValue } from './error-render';
import { ConfigInvalidError } from './errors';
import { ROLES, type Role } from './roles';
// `app.config.ts` CONSUMES the route vocabulary; it does not own it. Declaring `OfflineStrategy`
// here is what made it copyable — `render`, `manifest` and `pwa` each wrote their own rather than
// import a name that reads like a config key.
import type { OfflineStrategy } from './route-vocabulary';
import { isIanaZoneName } from './time-zone-name';

export type ThemeMode = 'light' | 'dark' | 'system';
export type RealtimeTransport = 'memory' | 'nats' | 'redis';

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
 * `installPrompt` was removed 2026-08, same rule: `@ultimat3/pwa`'s `createInstallController` is
 * real and complete, nothing ever threaded the flag into it, and both tracked apps plus every
 * scaffolded app set a switch with no wire. Call the controller from your own affordance instead.
 */
export interface PwaConfig {
  readonly enabled: boolean;
  readonly offline: OfflineStrategy;
  readonly backgroundSync: boolean;
  readonly push: boolean;
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
}

type Input<T> = { readonly [K in keyof T]?: T[K] | undefined };

/** `mcp` is the only member, and it is NESTED — `Input<AiConfig>` would make it all-or-nothing. */
export interface AiConfigInput {
  readonly mcp?: Input<McpConfig> | undefined;
}

export interface AppConfigInput {
  readonly name: string;
  readonly locales?: readonly string[] | undefined;
  readonly defaultLocale?: string | undefined;
  readonly defaultTimeZone?: string | undefined;
  readonly defaultCurrency?: string | undefined;
  readonly theme?: Input<ThemeConfig> | undefined;
  readonly auth?: Input<AuthConfig> | undefined;
  readonly pwa?: Input<PwaConfig> | undefined;
  readonly roles?: readonly Role[] | undefined;
  readonly database?: Input<DatabaseConfig> | undefined;
  readonly cache?: Input<CacheConfig> | undefined;
  readonly jobs?: Input<JobsConfig> | undefined;
  readonly realtime?: Input<RealtimeConfig> | undefined;
  readonly notify?: Input<NotifyConfig> | undefined;
  readonly ai?: AiConfigInput | undefined;
}

/** An overlay from `config/<concern>.ts`. No `name` — the base owns it. */
export type AppConfigOverlay = Omit<AppConfigInput, 'name'> & { readonly name?: string };

/**
 * Apply a partial section over its defaults. Explicit `undefined` never wins — that is what
 * makes every config field deeply optional without `exactOptionalPropertyTypes` fighting back.
 */
function section<T extends object>(base: T, patch: Input<T> | undefined): T {
  if (patch === undefined) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

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

function defaults(name: string): Omit<AppConfig, 'name'> {
  return {
    locales: ['en'],
    defaultLocale: 'en',
    defaultTimeZone: 'UTC',
    defaultCurrency: 'USD',
    theme: { defaultMode: 'system', tokens: {} },
    auth: { signInPath: null },
    pwa: { enabled: false, offline: 'network-only', backgroundSync: false, push: false },
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
    realtime: { enabled: false, transport: 'memory', urlEnv: undefined },
    notify: { inboxReadRetentionMs: undefined, inboxUnreadRetentionMs: undefined },
    ai: { mcp: { expose: true, path: '/mcp' } },
  };
}

const BASE_FIX = 'edit app.config.ts to fix the fields named in cause, then run: x verify';

/**
 * Appended only when the zone is what failed. Axiom 4: an operator holding `'CET'` needs the
 * spelling to write, and the two refused classes have different remedies — a single-label legacy
 * name swaps mechanically, an abbreviation or an offset has no replacement at all because it names
 * no jurisdiction. Deliberately parallel to `@ultimat3/time`'s `X_TIMEZONE_INVALID` fix, since the
 * two refuse the same strings and an operator may meet either first.
 */
const TIMEZONE_FIX =
  "set defaultTimeZone to an Area/Location name, or UTC — list every accepted one with bun -e \"console.log(Intl.supportedValuesOf('timeZone').join('\\n'))\" — where a legacy single-label name swaps mechanically (Japan → Asia/Tokyo, GB → Europe/London, Universal → UTC), while an abbreviation or numeric offset (CET, EST5EDT, +01:00) carries no DST rule and has no replacement, so name the city whose clock you mean (Europe/Paris, America/New_York)";

/**
 * Appended only when a tier name is what failed, and it names the rename rather than the rule: the
 * three refused spellings are the ones 8.0.0 accepted, and two of them have a mechanical
 * replacement while `isr` has none — it is a `RenderMode`, and no cache tier ever served it.
 */
const CACHE_TIER_FIX =
  "in app.config.ts, rewrite cache.tiers with the rung names the ladder serves — request-memo, lru, redis, cdn — where memo becomes request-memo and shared becomes redis, and isr is dropped: it is a render mode, so move it to render: 'isr' on the routes that want it";

function validate(config: AppConfig): void {
  const issues: string[] = [];
  // Zero or one entry: the zone's own remedy, carried only when the zone is what failed.
  const zoneFix: string[] = [];
  // Same shape, and it exists for the upgrade: an 8.0.0 app carrying `['memo', 'shared']` in an
  // untyped config file reaches here rather than the compiler, and needs the new spelling.
  const tierFix: string[] = [];

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
  if (config.jobs.concurrency < 1) issues.push('jobs.concurrency must be >= 1');
  if (config.jobs.queues.length === 0) issues.push('jobs.queues must list at least one queue');
  if (config.realtime.transport !== 'memory' && config.realtime.urlEnv === undefined) {
    issues.push(`realtime.transport "${config.realtime.transport}" requires realtime.urlEnv`);
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
      fix: [...zoneFix, ...tierFix, BASE_FIX].join('. '),
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
  // One `Object.assign` over all overlays rather than a spread per overlay: `reduce` with a
  // spread copies every key again on each step, and config is merged at boot on every start.
  // `name` is applied last because it identifies the app — an overlay may not rename it.
  const merged: AppConfigInput = Object.assign({}, input, ...overlays, {
    name: input.name,
  }) as AppConfigInput;

  const config: AppConfig = {
    name: merged.name,
    locales: merged.locales ?? base.locales,
    defaultLocale: merged.defaultLocale ?? base.defaultLocale,
    defaultTimeZone: merged.defaultTimeZone ?? base.defaultTimeZone,
    defaultCurrency: merged.defaultCurrency ?? base.defaultCurrency,
    theme: section(base.theme, merged.theme),
    auth: section(base.auth, merged.auth),
    pwa: section(base.pwa, merged.pwa),
    roles: merged.roles ?? base.roles,
    database: section(base.database, merged.database),
    cache: section(base.cache, merged.cache),
    jobs: section(base.jobs, merged.jobs),
    realtime: section(base.realtime, merged.realtime),
    notify: section(base.notify, merged.notify),
    ai: { mcp: section(base.ai.mcp, merged.ai?.mcp) },
  };

  validate(config);
  return Object.freeze(config);
}
