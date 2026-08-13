// Single responsibility: `app.config.ts` — the one config file. Deeply optional with real
// defaults, validated eagerly, and composable so a big app can split it across `config/*.ts`
// without inventing a second config mechanism.

import { ConfigInvalidError } from './errors';
import { ROLES, type Role } from './roles';

export type ThemeMode = 'light' | 'dark' | 'system';
export type OfflineStrategy = 'precache' | 'runtime' | 'network-only';
export type CacheTier = 'memo' | 'lru' | 'shared' | 'isr' | 'cdn';
export type JobsDriver = 'postgres' | 'redis' | 'nats';
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
  /** Where sign-in lands when there is nowhere to return to, or `?next=` is not same-origin. */
  readonly afterSignInPath: string;
}

export interface PwaConfig {
  readonly enabled: boolean;
  readonly offline: OfflineStrategy;
  readonly installPrompt: boolean;
  readonly backgroundSync: boolean;
  readonly push: boolean;
}

export interface DatabaseConfig {
  readonly driver: 'postgres';
  /** Env key holding the connection string — never the string itself. */
  readonly urlEnv: string;
  readonly poolSize: number;
  readonly ssl: boolean;
  readonly schema: string;
  /**
   * Preload foreign keys resolved by a page into a request-scoped cache, so the first
   * `findById` for any one of them resolves that key for the whole page in one statement.
   * A sequential `for … of` loop awaits between iterations, so batching is not possible
   * without this; enabling it collapses N+1 loops to one statement after the page. Default:
   * true.
   */
  readonly jitPreload: boolean;
}

export interface CacheConfig {
  readonly driver: 'memory' | 'redis';
  readonly urlEnv: string | undefined;
  readonly defaultTtlMs: number;
  readonly tiers: readonly CacheTier[];
}

export interface JobsConfig {
  readonly driver: JobsDriver;
  readonly queues: readonly string[];
  readonly concurrency: number;
  readonly maxAttempts: number;
  readonly backoff: 'exponential' | 'fixed';
  readonly visibilityTimeoutMs: number;
}

export interface RealtimeConfig {
  readonly enabled: boolean;
  readonly tier: RealtimeTier;
  readonly transport: RealtimeTransport;
  readonly urlEnv: string | undefined;
  readonly heartbeatMs: number;
}

export interface McpConfig {
  readonly expose: boolean;
  readonly path: string;
}

export interface AiConfig {
  readonly mcp: McpConfig;
  /** Env key for the model id, so no model string is baked into the image. */
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
const CURRENCY_RE = /^[A-Z]{3}$/;

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

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
    database: {
      driver: 'postgres',
      urlEnv: 'DATABASE_URL',
      poolSize: 10,
      ssl: false,
      schema: 'public',
      jitPreload: true,
    },
    cache: { driver: 'memory', urlEnv: undefined, defaultTtlMs: 60_000, tiers: ['memo', 'lru'] },
    jobs: {
      driver: 'postgres',
      queues: [`${name}-default`],
      concurrency: 8,
      maxAttempts: 5,
      backoff: 'exponential',
      visibilityTimeoutMs: 30_000,
    },
    realtime: {
      enabled: false,
      tier: 'channels',
      transport: 'memory',
      urlEnv: undefined,
      heartbeatMs: 15_000,
    },
    ai: { mcp: { expose: true, path: '/mcp' }, modelEnv: undefined },
  };
}

function validate(config: AppConfig): void {
  const issues: string[] = [];

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
  if (!isTimeZone(config.defaultTimeZone)) {
    issues.push(`defaultTimeZone "${config.defaultTimeZone}" is not an IANA time zone`);
  }
  if (!CURRENCY_RE.test(config.defaultCurrency)) {
    issues.push(`defaultCurrency "${config.defaultCurrency}" is not a 3-letter ISO 4217 code`);
  }
  if (config.roles.length === 0) issues.push('roles must list at least one runtime role');
  if (config.database.poolSize < 1) issues.push('database.poolSize must be >= 1');
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
      fix: 'edit app.config.ts to fix the fields named in cause, then run: x verify',
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
