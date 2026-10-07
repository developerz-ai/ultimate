// The resolver every HTTP config goes through, so a value is either a locked default or an
// explicit override — never "whatever the first caller passed". It is NOT a slice of
// `app.config.ts`, which this file claimed for four majors while `AppConfig` has never carried an
// `http` key: an app declares its half through `configureHttp()` (`app-config.ts`) and the boot
// lays its own facts over it before calling this.
import { DEFAULT_ENVIRONMENT, tryResolveEnvironment } from '@ultimat3/core';
import { assertCorsConfig, type CorsConfig, DEFAULT_CORS } from './cors';
import { type CsrfConfig, DEFAULT_CSRF } from './csrf';
import { drainTimeoutDeleted, httpCountInvalid, trustProxyUnset } from './errors';
import { assertHealthDetailPeers, DEFAULT_HEALTH_DETAIL_PEERS } from './health-disclosure';
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
  /**
   * Read Envoy's `x-forwarded-client-cert` into `ctx.peer`. Its OWN declaration, `false` until an
   * app makes it: `trustProxy` says the proxy appends to `x-forwarded-for`, which is no promise
   * that it strips or overwrites a certificate header the client sent — and this one names an
   * identity. Read at `trustedProxyHops`, so it does nothing without `trustProxy`.
   */
  readonly trustClientCertHeader: boolean;
  /**
   * Who `/healthz` and `/readyz` tell more than the verdict: each entry an address class
   * (`'loopback'`, `'private'`, …) or one exact address. Everyone else gets `state`, `ready` and
   * `role` — the endpoints answer outside the pipeline, so the build id, the in-flight count and
   * the readiness check names were otherwise any stranger's to read. `[]` tells nobody.
   */
  readonly healthDetailPeers: readonly string[];
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
  readonly trustClientCertHeader?: boolean;
  readonly healthDetailPeers?: readonly string[];
  readonly bodyLimitBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly maxInflight?: number;
  readonly locale?: Partial<LocaleConfig>;
  readonly tz?: Partial<TimeZoneConfig>;
  readonly cors?: Partial<CorsConfig>;
  readonly csrf?: Partial<CsrfConfig>;
  readonly security?: Partial<Omit<SecurityConfig, 'csp' | 'hsts'>> & {
    readonly csp?: Partial<SecurityConfig['csp']>;
    /**
     * Merged over `DEFAULT_SECURITY.hsts` key by key, so `{ preload: true }` alone is the preload
     * opt-in (submit the host at hstspreload.org only after that). `null` sends no HSTS at all.
     */
    readonly hsts?: Partial<NonNullable<SecurityConfig['hsts']>> | null;
  };
  readonly rateLimit?: Partial<RateLimitConfig>;
}

/** Key by key over the default two-year policy; `null` is the one way to send none. */
const resolveHsts = (
  input: Partial<NonNullable<SecurityConfig['hsts']>> | null | undefined,
): SecurityConfig['hsts'] => {
  if (input === null) return null;
  const base = DEFAULT_SECURITY.hsts ?? {
    maxAgeSeconds: 63_072_000,
    includeSubdomains: true,
    preload: false,
  };
  return { ...base, ...input };
};

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
 * A whole, in-range count, or the refusal that names it.
 *
 * `Number.isSafeInteger` and not `Number.isFinite`: these are byte counts, millisecond budgets and
 * request ceilings, and above 2^53 a double cannot name its own successor — the same rule
 * `@ultimat3/schema` states for an integer at the wire boundary. The `Finite` in the name is
 * load-bearing: `bun run finite-bounds` recognises a repair by the shape of the CALL, so a screen
 * named `count` left every option below reading as unchecked.
 *
 * `min` is the CALLER's, exactly as it is on `@ultimat3/core`'s `finiteCount`, because only the
 * caller knows what zero means: `requestTimeoutMs: 0` is "no deadline" and `maxInflight: 0` is
 * "never shed", both decisions the code reads, while `trustedProxyHops: 0` is a proxy trusted for
 * nothing — the state the whole declaration exists to refuse. A helper that picked one bound would
 * be wrong at half the call sites, and a second helper for "positive" would be the copy.
 */
const assertFiniteCount = (
  name: string,
  value: number,
  max: number,
  expected: string,
  example: string,
  min: 0 | 1 = 0,
): number => {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw httpCountInvalid(name, value, expected, example);
  }
  return value;
};

const MAX_PORT = 65_535;

/**
 * The longest delay a timer holds: a signed 32-bit count of milliseconds, about 24.8 days. Past
 * it `setTimeout` arms ~1 ms, so a "longer" request budget timed every request out at once.
 * `requestTimeoutMs` is screened against it and `deadline.ts` reads the inbound header by it.
 */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Nobody has 64 proxies in front of one process; a bigger number is a typo, not a topology.
 *
 * EXPORTED, and that is the point of it: `@ultimat3/cli`'s `trustedHopsFromEnv` screens the same
 * setting from `TRUSTED_PROXY_HOPS` and had to restate the literal, which is how one setting came
 * to have two ceilings — that end said 16 while this one said 64, so a deployment behind 20 hops
 * was accepted by the library and refused at boot. `cli` is tier 5 and this is tier 2, so the
 * import is downward and legal; the number lives here because this is where the setting is.
 */
export const MAX_PROXY_HOPS = 64;

/**
 * Which `x-forwarded-for` entry is the caller, or the refusal that says the declaration is not one.
 *
 * Screened, not clamped. `Math.max(0, Math.floor(x))` turned `-1` into `0` and `NaN` into `NaN`,
 * and BOTH mean "trust nothing" to `forwardedElement` — so the one declaration saying which entry
 * the caller wrote silently stopped being made, and every request's client ip became the proxy's
 * own. One rate-limit bucket for everything behind the ingress, no word said.
 *
 * **`0` is that same state and is refused with them**, `As of 2026-08-26`. `forwardedElement`
 * answers `undefined` for `hops < 1`, so `{ trustProxy: true, trustedProxyHops: 0 }` produced
 * exactly the failure the screen was written for while the screen accepted it. One is the smallest
 * topology `trustProxy: true` can describe.
 *
 * There is no `?? 0` fallback, and that is the point: an undeclared count is `trustProxyUnset()`,
 * because "trust the header" and "know which entry of it" are one declaration and half of it is a
 * header the caller writes. A default of zero would reopen the same hole from the other side.
 */
const resolveTrustedProxyHops = (trustProxy: boolean, declared: number | undefined): number => {
  if (!trustProxy) return 0;
  if (declared === undefined) throw trustProxyUnset();
  return assertFiniteCount(
    'trustedProxyHops',
    declared,
    MAX_PROXY_HOPS,
    'the whole number of proxies that append to x-forwarded-for, at least 1',
    'trustProxy: true, trustedProxyHops: 1',
    1,
  );
};

/**
 * Keys this config once carried and no longer reads. A typed caller is stopped by
 * `HttpConfigInput` itself; this is for the one that is not — plain JS, a spread of a parsed
 * object, a cast — so a deleted knob is an instruction rather than a number ignored in silence.
 */
export const refuseDeletedHttpKeys = (input: object): void => {
  // Core's rule for a removed key (`core/src/config-removed.ts`): `undefined` is a layer not
  // saying, so a spread carrying the key unset passes on both surfaces; any other value is written.
  const written: unknown = Object.hasOwn(input, 'drainTimeoutMs')
    ? (input as Record<string, unknown>)['drainTimeoutMs']
    : undefined;
  if (written !== undefined) throw drainTimeoutDeleted();
};

export const defineHttpConfig = (input: HttpConfigInput = {}): HttpConfig => {
  refuseDeletedHttpKeys(input);
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
  const trustedProxyHops = resolveTrustedProxyHops(trustProxy, input.trustedProxyHops);
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
    // Never `HOSTNAME`: Docker sets it to the container id, which is not an address to bind. The
    // boot passes what `HOST` says (`@ultimat3/cli`'s `hostnameFromEnv`); an embedder passes its own.
    hostname: input.hostname ?? '0.0.0.0',
    basePath: input.basePath ?? '/',
    // `undefined` falls back to the environment; an explicit `null` is the declaration that
    // switches skew detection off, and `??` would have read it as unset.
    buildId: input.buildId === undefined ? (env('BUILD_ID') ?? null) : input.buildId,
    buildIdHeader: input.buildIdHeader ?? 'x-ultimate-build',
    dev,
    signInPath: input.signInPath ?? null,
    trustProxy,
    trustedProxyHops,
    trustClientCertHeader: input.trustClientCertHeader === true,
    healthDetailPeers: assertHealthDetailPeers(
      input.healthDetailPeers === undefined ? DEFAULT_HEALTH_DETAIL_PEERS : input.healthDetailPeers,
    ),
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
      MAX_TIMER_MS,
      `a whole number of milliseconds up to ${MAX_TIMER_MS} (the longest a timer holds), where 0 means no deadline`,
      'requestTimeoutMs: 30_000',
    ),
    maxInflight: assertFiniteCount(
      'maxInflight',
      input.maxInflight ?? 1_000,
      Number.MAX_SAFE_INTEGER,
      'a whole number of requests, where 0 means never shed',
      'maxInflight: 1_000',
    ),
    locale: { ...DEFAULT_LOCALE_CONFIG, ...input.locale },
    tz: { ...DEFAULT_TZ_CONFIG, ...input.tz },
    cors,
    csrf: { ...DEFAULT_CSRF, ...input.csrf },
    security: {
      ...DEFAULT_SECURITY,
      ...input.security,
      csp,
      hsts: resolveHsts(input.security?.hsts),
    },
    rateLimit: resolveRateLimitConfig(input.rateLimit),
  };
};
