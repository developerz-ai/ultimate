// Single responsibility: `app.config.ts` — the one config file. Deeply optional with real
// defaults, validated eagerly, and composable so a big app can split it across `config/*.ts`
// without inventing a second config mechanism.

import { ConfigInvalidError } from './errors';
import { ROLES, type Role } from './roles';
import { isIanaZoneName } from './time-zone-name';

export type ThemeMode = 'light' | 'dark' | 'system';
export type OfflineStrategy = 'precache' | 'runtime' | 'network-only';
export type CacheTier = 'memo' | 'lru' | 'shared' | 'isr' | 'cdn';
export type RealtimeTier = 'channels' | 'live-queries' | 'local-first';
export type RealtimeTransport = 'memory' | 'nats' | 'redis';

export interface ThemeConfig {
  readonly defaultMode: ThemeMode;
  /** Semantic design tokens. Raw hex is a lint error in components, never here. */
  readonly tokens: Readonly<Record<string, string>>;
}

/**
 * Where a browser that failed `auth: 'required'` is sent, and where it lands afterwards.
 *
 * `signInPath: null` is the default and the redirect stays off until an app names its page: the
 * framework may not invent one of its app's routes, and an app that spells it `/login` would send
 * every unauthenticated visitor to a 404. Null means the visitor gets the problem document — the
 * right answer for an agent, and what a browser got in production until this existed.
 */
export interface AuthConfig {
  readonly signInPath: string | null;
  /**
   * Where sign-in lands when there is nowhere to return to, or `?next=` is not same-origin.
   *
   * **Consulted by nothing, `As of 2026-08.`** Accepted, defaulted and merged here and read by no
   * file in the repo — `dummy/social-media-clone/app.config.ts` sets `/dashboard` and gets
   * whatever the sign-in route does on its own. Same shape `urlEnv`, `poolSize` and `schema` were
   * deleted for below; this one is not deleted yet only because its writer is a tracked app's
   * config, so removing the key and the line that sets it is one commit across two file sets.
   */
  readonly afterSignInPath: string;
}

export interface PwaConfig {
  readonly enabled: boolean;
  readonly offline: OfflineStrategy;
  /**
   * **Consulted by nothing, `As of 2026-08.`** `wiki/Configuration.md` describes it as "render
   * your own install affordance from the deferred event", both tracked apps set it, and
   * `x new`'s scaffold writes it into every generated app — and no file reads it.
   * `@ultimat3/pwa`'s `install.ts` is real and complete; nothing threads this flag into it.
   * Delete the key or thread it; leaving it is a switch with no wire.
   */
  readonly installPrompt: boolean;
  readonly backgroundSync: boolean;
  readonly push: boolean;
}

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

export interface CacheConfig {
  readonly driver: 'memory' | 'redis';
  readonly urlEnv: string | undefined;
  readonly defaultTtlMs: number;
  readonly tiers: readonly CacheTier[];
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
 */
export interface RealtimeConfig {
  readonly enabled: boolean;
  readonly tier: RealtimeTier;
  readonly transport: RealtimeTransport;
  readonly urlEnv: string | undefined;
}

export interface McpConfig {
  readonly expose: boolean;
  readonly path: string;
}

export interface AiConfig {
  readonly mcp: McpConfig;
  /**
   * Env key for the model id, so no model string is baked into the image — **an intention, not a
   * behaviour, `As of 2026-08`.** The only read of it in the repo is the merge two hundred lines
   * below, which copies it from input to output; nothing consumes the merged value, so
   * `examples/dummy`'s `modelEnv: 'ANTHROPIC_MODEL'` selects no model. `@ultimat3/ai` reads env
   * for API KEYS only (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`); the model is
   * `request.model ?? DEFAULT_MODEL`, a compile-time constant in `models.ts`. So the exact thing
   * this key exists to prevent — a model string baked into the image — is what actually happens.
   */
  readonly modelEnv: string | undefined;
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
  readonly ai: AiConfig;
}

type Input<T> = { readonly [K in keyof T]?: T[K] | undefined };

export interface AiConfigInput extends Input<Omit<AiConfig, 'mcp'>> {
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
 * A deliberate duplicate of `CURRENCY_CODE_PATTERN` in `packages/schema/src/money-value.ts`, which
 * is the framework's ONE declaration of what an ISO 4217 code looks like and the source
 * `isCurrencyCode`, the published OpenAPI `pattern` and `@ultimat3/entity`'s Postgres CHECK all
 * derive from. This file cannot import it: `core` and `schema` are both tier 0 and `core → schema`
 * is not in `SIDEWAYS_ALLOW` (`scripts/lib/tiers.ts`), the same wall that makes `describeValue` a
 * character-for-character copy in `error-render.ts`.
 *
 * So keep the two identical, and keep the pattern inside the syntax ECMAScript, JSON Schema and
 * POSIX ERE spell identically — a `defaultCurrency` this accepts and `t.money` refuses is an app
 * whose configured currency cannot be written to a row.
 */
const CURRENCY_RE = /^[A-Z]{3}$/;

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
    auth: { signInPath: null, afterSignInPath: '/' },
    pwa: {
      enabled: false,
      offline: 'network-only',
      installPrompt: false,
      backgroundSync: false,
      push: false,
    },
    roles: [...ROLES],
    database: { driver: 'postgres', ssl: false },
    cache: { driver: 'memory', urlEnv: undefined, defaultTtlMs: 60_000, tiers: ['memo', 'lru'] },
    jobs: {
      queues: [`${name}-default`],
      concurrency: 8,
      maxAttempts: 5,
      backoff: 'exponential',
      visibilityTimeoutMs: 30_000,
    },
    realtime: { enabled: false, tier: 'channels', transport: 'memory', urlEnv: undefined },
    ai: { mcp: { expose: true, path: '/mcp' }, modelEnv: undefined },
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

function validate(config: AppConfig): void {
  const issues: string[] = [];
  // Zero or one entry: the zone's own remedy, carried only when the zone is what failed.
  const zoneFix: string[] = [];

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
  if (config.cache.driver === 'redis' && config.cache.urlEnv === undefined) {
    issues.push('cache.driver "redis" requires cache.urlEnv');
  }

  if (issues.length > 0) {
    throw new ConfigInvalidError({
      cause: issues.join('; '),
      // The generic instruction goes LAST so the fix line still ends in a command that can be
      // pasted — a trailing `.` after `x verify` is a command nobody can run.
      fix: [...zoneFix, BASE_FIX].join('. '),
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
    ai: {
      mcp: section(base.ai.mcp, merged.ai?.mcp),
      modelEnv: merged.ai?.modelEnv ?? base.ai.modelEnv,
    },
  };

  validate(config);
  return Object.freeze(config);
}
