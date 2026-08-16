// The HTTP slice of `app.config.ts`. One resolver, so a value is either a locked
// default or an explicit override — never "whatever the first caller passed".
import { DEFAULT_ENVIRONMENT, tryResolveEnvironment } from '@ultimat3/core';
import { assertCorsConfig, type CorsConfig, DEFAULT_CORS } from './cors';
import { type CsrfConfig, DEFAULT_CSRF } from './csrf';
import { trustProxyUnset } from './errors';
import {
  DEFAULT_LOCALE_CONFIG,
  DEFAULT_TZ_CONFIG,
  type LocaleConfig,
  type TimeZoneConfig,
} from './locale';
import { type RateLimitConfig, resolveRateLimitConfig } from './rate-limit';
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
  /**
   * Where a browser that failed `auth: 'required'` is sent, or `null` to answer it with the
   * problem document. `null` by default: guessing `/signin` sends an app that spells it `/login`
   * to a 404, and a framework may not invent one of its app's routes.
   */
  readonly signInPath: string | null;
  /**
   * Read `x-forwarded-for` / `x-forwarded-proto`, and echo an inbound `x-request-id`. A claim
   * about the DEPLOYMENT, so it is `false` until an app makes it — it used to default `true`,
   * which let any direct caller choose its own request id and poison log correlation. Setting it
   * requires `trustedProxyHops`.
   */
  readonly trustProxy: boolean;
  /**
   * How many proxies APPEND to `x-forwarded-for` between the client and this process — 1 for a
   * single ingress or ALB, 2 for a CDN in front of one. The header is read at
   * `entries.length - hops`, never at `[0]`: the leftmost value is whatever the client typed.
   * `0` when nothing is trusted.
   */
  readonly trustedProxyHops: number;
  readonly bodyLimitBytes: number;
  /**
   * How long one request may run before it is aborted and answered `X_TIMEOUT` (504). `0`
   * disables it, which is a deployment saying it would rather hold a connection forever than
   * cut one short. A caller may ask for LESS with `x-request-timeout-ms`, never for more.
   */
  readonly requestTimeoutMs: number;
  /**
   * Requests this process will hold at once before shedding with `X_OVERLOADED` (503) before any
   * work. `0` disables it. The ceiling is not a capacity plan — it is the difference between
   * degrading and collapsing, because past it every request queues behind the same pool and the
   * retries multiply the load.
   */
  readonly maxInflight: number;
  /** How long SIGTERM waits for in-flight requests before hard-stopping. */
  readonly drainTimeoutMs: number;
  readonly locale: LocaleConfig;
  readonly tz: TimeZoneConfig;
  readonly cors: CorsConfig;
  readonly csrf: CsrfConfig;
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
  readonly signInPath?: string | null;
  readonly trustProxy?: boolean;
  readonly trustedProxyHops?: number;
  readonly bodyLimitBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly maxInflight?: number;
  readonly drainTimeoutMs?: number;
  readonly locale?: Partial<LocaleConfig>;
  readonly tz?: Partial<TimeZoneConfig>;
  readonly cors?: Partial<CorsConfig>;
  readonly csrf?: Partial<CsrfConfig>;
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
  // `ULTIMATE_ENV` is the framework's one environment key and `NODE_ENV` is only its fallback, so
  // reading `NODE_ENV` alone made a deployment that declared production the documented way serve
  // the dev overlay and a report-only CSP. Non-throwing and `?? DEFAULT_ENVIRONMENT`, the same
  // expression `@ultimat3/policy`'s `traceByDefault` uses: a malformed `ULTIMATE_ENV` is its own
  // error with its own fix and must never be raised for the first time by a config default.
  const dev = input.dev ?? (tryResolveEnvironment() ?? DEFAULT_ENVIRONMENT) !== 'production';
  const cors = { ...DEFAULT_CORS, ...input.cors };
  // The one resolver is the one place a resolved combination can be judged: an override is merged
  // over defaults the author never restated, so `origins: ['*']` alone is what reaches this.
  assertCorsConfig(cors);
  const trustProxy = input.trustProxy ?? false;
  // Refused here, not on the first request: "trust the header" and "know which entry of it" are
  // one declaration, and half of it is a header the caller writes.
  if (trustProxy && input.trustedProxyHops === undefined) throw trustProxyUnset();
  return {
    port: input.port ?? Number.parseInt(env('PORT') ?? '3000', 10),
    hostname: input.hostname ?? env('HOSTNAME') ?? '0.0.0.0',
    basePath: input.basePath ?? '/',
    buildId: input.buildId ?? env('BUILD_ID') ?? null,
    buildIdHeader: input.buildIdHeader ?? 'x-ultimate-build',
    dev,
    signInPath: input.signInPath ?? null,
    trustProxy,
    trustedProxyHops: trustProxy ? Math.max(0, Math.floor(input.trustedProxyHops ?? 0)) : 0,
    bodyLimitBytes: input.bodyLimitBytes ?? 1_048_576,
    // 30s: longer than any request a browser waits out, shorter than the 15s drain budget times
    // two, so a rolling restart cannot be held open by work started just before SIGTERM.
    requestTimeoutMs: input.requestTimeoutMs ?? 30_000,
    maxInflight: input.maxInflight ?? 1_000,
    drainTimeoutMs: input.drainTimeoutMs ?? 15_000,
    locale: { ...DEFAULT_LOCALE_CONFIG, ...input.locale },
    tz: { ...DEFAULT_TZ_CONFIG, ...input.tz },
    cors,
    csrf: { ...DEFAULT_CSRF, ...input.csrf },
    security: {
      ...DEFAULT_SECURITY,
      ...input.security,
      csp: { ...DEFAULT_SECURITY.csp, reportOnly: dev, ...input.security?.csp },
    },
    rateLimit: resolveRateLimitConfig(input.rateLimit),
  };
};
