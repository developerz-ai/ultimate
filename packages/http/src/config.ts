// The resolver every HTTP config goes through, so a value is either a locked default or an
// explicit override — never "whatever the first caller passed". It is NOT a slice of
// `app.config.ts`, which this file claimed for four majors while `AppConfig` has never carried an
// `http` key: an app declares its half through `configureHttp()` (`app-config.ts`) and the boot
// lays its own facts over it before calling this.
import { DEFAULT_ENVIRONMENT, tryResolveEnvironment } from '@ultimat3/core';
import { assertCorsConfig, type CorsConfig, DEFAULT_CORS } from './cors';
import { type CsrfConfig, DEFAULT_CSRF } from './csrf';
import { httpCountInvalid, trustProxyUnset } from './errors';
import {
  DEFAULT_LOCALE_CONFIG,
  DEFAULT_TZ_CONFIG,
  type LocaleConfig,
  type TimeZoneConfig,
} from './locale';
import { type RateLimitConfig, resolveRateLimitConfig } from './rate-limit';
import { assertCspExtend, DEFAULT_SECURITY, type SecurityConfig } from './security-headers';

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
  /**
   * How long SIGTERM waits for in-flight requests before hard-stopping, or `null` when this app
   * has not said and core's own deadline stands.
   *
   * `null` and not a 15s default, because the two are different claims and only one of them may
   * reach `configureLifecycle`. `createServer` applied the resolved number unconditionally, so an
   * app that had already written `configureLifecycle({ deadlineMs: 600_000 })` — the edit
   * `X_SHUTDOWN_TIMEOUT`'s own `fix:` line prints — had it silently reverted by the next line of
   * boot, in every process that serves web. Declaring this key IS declaring the drain budget for
   * the whole process; leaving it out is declining to.
   */
  readonly drainTimeoutMs: number | null;
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

/**
 * A count, or a refusal naming the knob. `Number.isSafeInteger` and not `Number.isFinite`: these
 * are byte counts, millisecond budgets and request ceilings, and above 2^53 a double cannot name
 * its own successor — the same rule `@ultimat3/schema` states for an integer at the wire boundary.
 */
/**
 * A whole, in-range count, or the refusal that names it. The `Finite` in the name is load-bearing:
 * `bun run finite-bounds` recognises a repair by the shape of the CALL, so a screen named `count`
 * left every option below reading as unchecked.
 */
const assertFiniteCount = (
  name: string,
  value: number,
  max: number,
  expected: string,
  example: string,
): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw httpCountInvalid(name, value, expected, example);
  }
  return value;
};

const MAX_PORT = 65_535;

/** Nobody has 64 proxies in front of one process; a bigger number is a typo, not a topology. */
const MAX_PROXY_HOPS = 64;

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
  const csp = { ...DEFAULT_SECURITY.csp, reportOnly: dev, ...input.security?.csp };
  // Beside `assertCorsConfig`, and for its reason: a merged value is the only one that can be
  // judged, and a directive name that is not a token would otherwise be a bare `TypeError` out of
  // the first response's header build — or worse, a second directive nobody declared.
  assertCspExtend(csp.extend);
  return {
    // `Number.parseInt(env('PORT'), 10)` is `NaN` for `PORT=web`, and a config that carries NaN
    // into `Bun.serve` binds a port nobody asked for.
    port: assertFiniteCount(
      'port',
      input.port ?? Number.parseInt(env('PORT') ?? '3000', 10),
      MAX_PORT,
      'a whole port number from 0 to 65535, where 0 asks the OS for a free one',
      'port: 3000',
    ),
    hostname: input.hostname ?? env('HOSTNAME') ?? '0.0.0.0',
    basePath: input.basePath ?? '/',
    buildId: input.buildId ?? env('BUILD_ID') ?? null,
    buildIdHeader: input.buildIdHeader ?? 'x-ultimate-build',
    dev,
    signInPath: input.signInPath ?? null,
    trustProxy,
    // Screened, not clamped. `Math.max(0, Math.floor(x))` turned `-1` into `0` and `NaN` into
    // `NaN`, and BOTH of those mean "trust nothing" to `forwardedElement` — so the one declaration
    // that says which x-forwarded-for entry is the caller silently stopped being made, and every
    // request's client ip became the proxy's own. One bucket for the whole fleet, no word said.
    trustedProxyHops: trustProxy
      ? assertFiniteCount(
          'trustedProxyHops',
          input.trustedProxyHops ?? 0,
          MAX_PROXY_HOPS,
          'the whole number of proxies that append to x-forwarded-for',
          'trustProxy: true, trustedProxyHops: 1',
        )
      : 0,
    bodyLimitBytes: assertFiniteCount(
      'bodyLimitBytes',
      input.bodyLimitBytes ?? 1_048_576,
      Number.MAX_SAFE_INTEGER,
      'a whole number of bytes',
      'bodyLimitBytes: 1_048_576',
    ),
    // 30s: longer than any request a browser waits out, shorter than the 15s drain budget times
    // two, so a rolling restart cannot be held open by work started just before SIGTERM.
    requestTimeoutMs: assertFiniteCount(
      'requestTimeoutMs',
      input.requestTimeoutMs ?? 30_000,
      Number.MAX_SAFE_INTEGER,
      'a whole number of milliseconds, where 0 means no deadline',
      'requestTimeoutMs: 30_000',
    ),
    maxInflight: assertFiniteCount(
      'maxInflight',
      input.maxInflight ?? 1_000,
      Number.MAX_SAFE_INTEGER,
      'a whole number of requests, where 0 means never shed',
      'maxInflight: 1_000',
    ),
    drainTimeoutMs:
      input.drainTimeoutMs === undefined || input.drainTimeoutMs === null
        ? null
        : assertFiniteCount(
            'drainTimeoutMs',
            input.drainTimeoutMs,
            Number.MAX_SAFE_INTEGER,
            'a whole number of milliseconds, or null for the lifecycle default',
            'drainTimeoutMs: 15_000',
          ),
    locale: { ...DEFAULT_LOCALE_CONFIG, ...input.locale },
    tz: { ...DEFAULT_TZ_CONFIG, ...input.tz },
    cors,
    csrf: { ...DEFAULT_CSRF, ...input.csrf },
    security: { ...DEFAULT_SECURITY, ...input.security, csp },
    rateLimit: resolveRateLimitConfig(input.rateLimit),
  };
};
