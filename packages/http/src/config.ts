// The HTTP slice of `app.config.ts`. One resolver, so a value is either a locked
// default or an explicit override — never "whatever the first caller passed".
import { type CorsConfig, DEFAULT_CORS } from './cors';
import {
  DEFAULT_LOCALE_CONFIG,
  DEFAULT_TZ_CONFIG,
  type LocaleConfig,
  type TimeZoneConfig,
} from './locale';
import { DEFAULT_RATE_LIMIT, type RateLimitConfig } from './rate-limit';
import { DEFAULT_SECURITY, type SecurityConfig } from './security-headers';

export interface HttpConfig {
  readonly port: number;
  readonly hostname: string;
  /** Mounted prefix, stripped before matching. `'/'` means no prefix. */
  readonly basePath: string;
  /** Build id this process serves; `null` disables skew detection (dev). */
  readonly buildId: string | null;
  readonly buildIdHeader: string;
  readonly dev: boolean;
  /** Read `x-forwarded-for` / `x-forwarded-proto`. Only safe behind our own proxy. */
  readonly trustProxy: boolean;
  readonly bodyLimitBytes: number;
  /** How long SIGTERM waits for in-flight requests before hard-stopping. */
  readonly drainTimeoutMs: number;
  readonly locale: LocaleConfig;
  readonly tz: TimeZoneConfig;
  readonly cors: CorsConfig;
  readonly security: SecurityConfig;
  readonly rateLimit: RateLimitConfig;
}

export interface HttpConfigInput {
  readonly port?: number;
  readonly hostname?: string;
  readonly basePath?: string;
  readonly buildId?: string | null;
  readonly buildIdHeader?: string;
  readonly dev?: boolean;
  readonly trustProxy?: boolean;
  readonly bodyLimitBytes?: number;
  readonly drainTimeoutMs?: number;
  readonly locale?: Partial<LocaleConfig>;
  readonly tz?: Partial<TimeZoneConfig>;
  readonly cors?: Partial<CorsConfig>;
  readonly security?: Partial<Omit<SecurityConfig, 'csp'>> & {
    readonly csp?: Partial<SecurityConfig['csp']>;
  };
  readonly rateLimit?: Partial<RateLimitConfig>;
}

/**
 * `basePath` is stripped before matching so route paths never encode the mount point.
 * Matching is on a segment boundary: a mount at `/api` owns `/api` and `/api/...` but
 * never `/apix`, which is a different route whose first three characters happen to agree.
 */
export const stripBasePath = (pathname: string, basePath: string): string => {
  if (basePath === '/' || basePath === '') return pathname;
  const prefix = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  if (pathname === prefix) return '/';
  if (!pathname.startsWith(`${prefix}/`)) return pathname;
  return pathname.slice(prefix.length);
};

const env = (name: string): string | undefined => {
  const value = Bun.env[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

export const defineHttpConfig = (input: HttpConfigInput = {}): HttpConfig => {
  const dev = input.dev ?? env('NODE_ENV') !== 'production';
  return {
    port: input.port ?? Number.parseInt(env('PORT') ?? '3000', 10),
    hostname: input.hostname ?? env('HOSTNAME') ?? '0.0.0.0',
    basePath: input.basePath ?? '/',
    buildId: input.buildId ?? env('BUILD_ID') ?? null,
    buildIdHeader: input.buildIdHeader ?? 'x-ultimate-build',
    dev,
    trustProxy: input.trustProxy ?? true,
    bodyLimitBytes: input.bodyLimitBytes ?? 1_048_576,
    drainTimeoutMs: input.drainTimeoutMs ?? 15_000,
    locale: { ...DEFAULT_LOCALE_CONFIG, ...input.locale },
    tz: { ...DEFAULT_TZ_CONFIG, ...input.tz },
    cors: { ...DEFAULT_CORS, ...input.cors },
    security: {
      ...DEFAULT_SECURITY,
      ...input.security,
      csp: { ...DEFAULT_SECURITY.csp, reportOnly: dev, ...input.security?.csp },
    },
    rateLimit: { ...DEFAULT_RATE_LIMIT, ...input.rateLimit },
  };
};
