// `defineHttpConfig` is where every HTTP default is decided once, so these tests are the
// record of what an app gets when it writes nothing — a quiet change to a default changes
// every app that never set the field. `stripBasePath` is here too, because a mount point that
// matches off a segment boundary hands one route's traffic to another.
import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { type AppHttpConfig, configureHttp } from './app-config';
import { defineHttpConfig, type HttpConfigInput, stripBasePath } from './config';
import { DEFAULT_CORS } from './cors';
import { DEFAULT_LOCALE_CONFIG, DEFAULT_TZ_CONFIG } from './locale';
import { DEFAULT_RATE_LIMIT } from './rate-limit';
import { DEFAULT_SECURITY } from './security-headers';

describe('stripBasePath', () => {
  test('basePath of "/" or "" returns the pathname unchanged', () => {
    expect(stripBasePath('/posts', '/')).toBe('/posts');
    expect(stripBasePath('/posts', '')).toBe('/posts');
  });

  test('a trailing slash on basePath is trimmed before matching', () => {
    expect(stripBasePath('/api/posts', '/api/')).toBe('/posts');
  });

  test('a pathname not starting with the prefix is returned unchanged', () => {
    expect(stripBasePath('/other/posts', '/api')).toBe('/other/posts');
  });

  test('a sibling path sharing only a character prefix is not treated as mounted', () => {
    expect(stripBasePath('/apix/posts', '/api')).toBe('/apix/posts');
    expect(stripBasePath('/apix/posts', '/api/')).toBe('/apix/posts');
    expect(stripBasePath('/apix', '/api')).toBe('/apix');
  });

  test('a pathname starting with the prefix has the prefix stripped', () => {
    expect(stripBasePath('/api/posts', '/api')).toBe('/posts');
  });

  test('a pathname exactly matching the prefix resolves to "/"', () => {
    expect(stripBasePath('/api', '/api')).toBe('/');
  });
});

describe('defineHttpConfig', () => {
  test('echoes every explicit top-level field', () => {
    const config = defineHttpConfig({
      rateLimit: { scope: 'process' },
      port: 4321,
      hostname: 'localhost',
      basePath: '/api',
      buildId: 'build-1',
      dev: false,
      trustProxy: false,
      bodyLimitBytes: 2_048,
    });

    expect(config.port).toBe(4321);
    expect(config.hostname).toBe('localhost');
    expect(config.basePath).toBe('/api');
    expect(config.buildId).toBe('build-1');
    expect(config.dev).toBe(false);
    expect(config.trustProxy).toBe(false);
    expect(config.bodyLimitBytes).toBe(2_048);
  });

  test('defaults not overridden by env: basePath, trustProxy, bodyLimitBytes', () => {
    const config = defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false });

    expect(config.basePath).toBe('/');
    // `false`, and it USED to be `true`: trusting x-forwarded-* and x-request-id is a claim
    // about the deployment, and a direct caller could otherwise choose its own request id.
    expect(config.trustProxy).toBe(false);
    expect(config.trustedProxyHops).toBe(0);
    expect(config.bodyLimitBytes).toBe(1_048_576);
  });

  test('locale merges input over DEFAULT_LOCALE_CONFIG', () => {
    const config = defineHttpConfig({
      rateLimit: { scope: 'process' },
      dev: false,
      locale: { cookie: 'lang' },
    });

    expect(config.locale.cookie).toBe('lang');
  });

  // The supported set and the fallback belong to `defineCatalogs()`, the zone default to
  // `configureTime()`. This config holds WHERE to read a request's choice from, never what the
  // choice may be — a second declaration here is what let an app ship `{ en, fr }` and resolve
  // `ctx.locale` to `'en'` forever.
  test('holds header and cookie names only, never a supported set or a default', () => {
    expect(Object.keys(DEFAULT_LOCALE_CONFIG).sort()).toEqual(['cookie']);
    expect(Object.keys(DEFAULT_TZ_CONFIG).sort()).toEqual(['cookie', 'header']);
  });

  test('tz merges input over DEFAULT_TZ_CONFIG', () => {
    const config = defineHttpConfig({
      rateLimit: { scope: 'process' },
      dev: false,
      tz: { cookie: 'zone' },
    });

    expect(config.tz.cookie).toBe('zone');
    expect(config.tz.header).toBe(DEFAULT_TZ_CONFIG.header);
  });

  test('cors merges input over DEFAULT_CORS, leaving other fields intact', () => {
    const config = defineHttpConfig({
      rateLimit: { scope: 'process' },
      dev: false,
      cors: { credentials: false },
    });

    expect(config.cors.credentials).toBe(false);
    expect(config.cors.origins).toEqual(DEFAULT_CORS.origins);
    expect(config.cors.methods).toEqual(DEFAULT_CORS.methods);
    expect(config.cors.allowHeaders).toEqual(DEFAULT_CORS.allowHeaders);
    expect(config.cors.exposeHeaders).toEqual(DEFAULT_CORS.exposeHeaders);
    expect(config.cors.maxAgeSeconds).toBe(DEFAULT_CORS.maxAgeSeconds);
  });

  test('rateLimit merges input over DEFAULT_RATE_LIMIT', () => {
    const config = defineHttpConfig({
      dev: false,
      rateLimit: { scope: 'process', enabled: false },
    });

    expect(config.rateLimit.enabled).toBe(false);
    expect(config.rateLimit.defaultBucket).toBe(DEFAULT_RATE_LIMIT.defaultBucket);
    expect(config.rateLimit.buckets).toEqual(DEFAULT_RATE_LIMIT.buckets);
  });

  test('security merges input over DEFAULT_SECURITY, leaving other fields intact', () => {
    const config = defineHttpConfig({
      rateLimit: { scope: 'process' },
      dev: false,
      security: { referrerPolicy: 'no-referrer' },
    });

    expect(config.security.referrerPolicy).toBe('no-referrer');
    expect(config.security.frameAncestors).toEqual(DEFAULT_SECURITY.frameAncestors);
    expect(config.security.permissionsPolicy).toBe(DEFAULT_SECURITY.permissionsPolicy);
    expect(config.security.coop).toBe(DEFAULT_SECURITY.coop);
    expect(config.security.corp).toBe(DEFAULT_SECURITY.corp);
    expect(config.security.hsts).toEqual(DEFAULT_SECURITY.hsts);
  });

  test('security.csp.reportOnly follows the resolved dev flag when not overridden (dev: true)', () => {
    const config = defineHttpConfig({ rateLimit: { scope: 'process' }, dev: true });
    expect(config.security.csp.reportOnly).toBe(true);
  });

  test('security.csp.reportOnly follows the resolved dev flag when not overridden (dev: false)', () => {
    const config = defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false });
    expect(config.security.csp.reportOnly).toBe(false);
  });

  test('an explicit security.csp.reportOnly wins over the dev flag', () => {
    const config = defineHttpConfig({
      rateLimit: { scope: 'process' },
      dev: true,
      security: { csp: { reportOnly: false } },
    });
    expect(config.security.csp.reportOnly).toBe(false);
  });

  test('security.csp.extend and reportUri still merge from DEFAULT_SECURITY.csp when not overridden', () => {
    const config = defineHttpConfig({
      rateLimit: { scope: 'process' },
      dev: true,
      security: { csp: { reportOnly: false } },
    });
    expect(config.security.csp.extend).toEqual(DEFAULT_SECURITY.csp.extend);
    expect(config.security.csp.reportUri).toBe(DEFAULT_SECURITY.csp.reportUri);
  });
});

/**
 * The one reader in this package of "is this production?". It used to be `NODE_ENV` alone, so a
 * deployment declaring production the framework's own documented way (`ULTIMATE_ENV`) served the
 * dev error overlay — absolute paths, module layout, internal causes — to any anonymous request
 * that provoked a 5xx, with the CSP report-only and therefore enforcing nothing.
 */
describe('security.hsts merges key by key', () => {
  const scope = { rateLimit: { scope: 'process' as const } };
  test('{ preload: true } alone opts into preload and keeps the default age and subdomains', () => {
    const config = defineHttpConfig({ ...scope, security: { hsts: { preload: true } } });
    expect(config.security.hsts).toEqual({ ...DEFAULT_SECURITY.hsts, preload: true } as never);
    expect(config.security.hsts?.maxAgeSeconds).toBe(63_072_000);
  });

  test('absent keeps the default, which never preloads', () => {
    expect(defineHttpConfig(scope).security.hsts?.preload).toBe(false);
  });

  test('null sends none', () => {
    expect(defineHttpConfig({ ...scope, security: { hsts: null } }).security.hsts).toBeNull();
  });
});

describe('dev is decided by ULTIMATE_ENV, not NODE_ENV alone', () => {
  const withEnv = <T>(values: Record<string, string | undefined>, run: () => T): T => {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(values)) {
      previous.set(key, process.env[key]);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return run();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  test('ULTIMATE_ENV=production with NODE_ENV unset is production', () => {
    const config = withEnv({ ULTIMATE_ENV: 'production', NODE_ENV: undefined }, () =>
      defineHttpConfig({ rateLimit: { scope: 'process' } }),
    );
    expect(config.dev).toBe(false);
    expect(config.security.csp.reportOnly).toBe(false);
  });

  test('ULTIMATE_ENV wins over NODE_ENV in both directions', () => {
    const overridden = withEnv({ ULTIMATE_ENV: 'production', NODE_ENV: 'development' }, () =>
      defineHttpConfig({ rateLimit: { scope: 'process' } }),
    );
    expect(overridden.dev).toBe(false);

    const relaxed = withEnv({ ULTIMATE_ENV: 'development', NODE_ENV: 'production' }, () =>
      defineHttpConfig({ rateLimit: { scope: 'process' } }),
    );
    expect(relaxed.dev).toBe(true);
  });

  test('NODE_ENV=production still decides when ULTIMATE_ENV is unset', () => {
    const config = withEnv({ ULTIMATE_ENV: undefined, NODE_ENV: 'production' }, () =>
      defineHttpConfig({ rateLimit: { scope: 'process' } }),
    );
    expect(config.dev).toBe(false);
  });

  test('an explicit dev still wins over the environment', () => {
    const config = withEnv({ ULTIMATE_ENV: 'production', NODE_ENV: undefined }, () =>
      defineHttpConfig({ rateLimit: { scope: 'process' }, dev: true }),
    );
    expect(config.dev).toBe(true);
  });
});

/**
 * Every numeric knob here arrives from `app.config.ts` or the environment, and `Number(env)` on an
 * unset variable is `NaN`. `NaN` is not nullish, so `??` passes it through; `Math.max`/`Math.floor`
 * propagate it; and then every comparison it reaches answers FALSE. The result is never a wrong
 * number — it is the guard turning itself off:
 *
 * | knob | what `NaN` does, measured |
 * |---|---|
 * | `bodyLimitBytes` | `total > NaN` is false, so `readWithinLimit` buffers the WHOLE body |
 * | `requestTimeoutMs` | `NaN <= 0` is false, so a deadline arms — `setTimeout(fn, NaN)` is 1ms, and every request 504s |
 * | `maxInflight` | `ceiling > 0` is false, so the `admit` stage sheds nothing |
 * | `trustedProxyHops` | `Math.max(0, Math.floor(NaN))` is `NaN`, so `forwardedElement` answers `undefined` and `trustProxy: true` silently does nothing |
 */
/** Every call below needs it: `rateLimit.scope` is a declaration the deployment owes. */
const SCOPED = { rateLimit: { scope: 'process' } } as const;

describe('defineHttpConfig refuses a limit that is not a number', () => {
  const NOT_A_COUNT = [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5] as const;

  for (const value of NOT_A_COUNT) {
    test(`bodyLimitBytes: ${String(value)} is X_CONFIG_INVALID, never an uncapped body`, () => {
      expect(() => defineHttpConfig({ ...SCOPED, bodyLimitBytes: value })).toThrow(
        /X_CONFIG_INVALID/,
      );
    });
  }

  test('each knob is named in its own refusal', () => {
    expect(() => defineHttpConfig({ ...SCOPED, requestTimeoutMs: Number.NaN })).toThrow(
      /requestTimeoutMs/,
    );
    expect(() => defineHttpConfig({ ...SCOPED, maxInflight: Number.NaN })).toThrow(/maxInflight/);
    expect(() =>
      defineHttpConfig({ ...SCOPED, trustProxy: true, trustedProxyHops: Number.NaN }),
    ).toThrow(/trustedProxyHops/);
    expect(() => defineHttpConfig({ ...SCOPED, port: Number.NaN })).toThrow(/port/);
  });

  test('a port outside the range a socket has is refused, 0 (pick one) is not', () => {
    expect(() => defineHttpConfig({ ...SCOPED, port: 65_536 })).toThrow(/X_CONFIG_INVALID/);
    expect(defineHttpConfig({ ...SCOPED, port: 0 }).port).toBe(0);
  });

  test('the documented zeroes still mean what they meant', () => {
    // `requestTimeoutMs: 0` is "no deadline" and `maxInflight: 0` is "never shed" — both are
    // decisions the code reads, not accidents, so the screen must not take them away.
    expect(defineHttpConfig({ ...SCOPED, requestTimeoutMs: 0 }).requestTimeoutMs).toBe(0);
    expect(defineHttpConfig({ ...SCOPED, maxInflight: 0 }).maxInflight).toBe(0);
    expect(defineHttpConfig({ ...SCOPED, bodyLimitBytes: 0 }).bodyLimitBytes).toBe(0);
  });

  test('a fractional hop count is refused rather than floored to something else', () => {
    // It was `Math.max(0, Math.floor(hops))`, which is a clamp and not a validator: it turned
    // `-1` into `0` (trust silently off) and `NaN` into `NaN` (trust silently off) with no word.
    expect(() => defineHttpConfig({ ...SCOPED, trustProxy: true, trustedProxyHops: 1.5 })).toThrow(
      /X_CONFIG_INVALID/,
    );
    expect(
      defineHttpConfig({ ...SCOPED, trustProxy: true, trustedProxyHops: 2 }).trustedProxyHops,
    ).toBe(2);
  });

  test('a hop count of ZERO is refused — it IS the state this screen was written to name', () => {
    // `forwardedElement` returns `undefined` for `hops < 1` (`forwarded.ts`), so
    // `{ trustProxy: true, trustedProxyHops: 0 }` is byte-for-byte the failure the comment above
    // the screen describes: `clientAddress` falls back to the socket, every caller behind the
    // ingress shares one rate-limit bucket, and `x-forwarded-proto` is untrusted so HSTS is never
    // emitted. `-1` and `NaN` were refused for producing exactly this, and `0` was let through.
    expect(() => defineHttpConfig({ ...SCOPED, trustProxy: true, trustedProxyHops: 0 })).toThrow(
      /X_CONFIG_INVALID/,
    );
    expect(() => defineHttpConfig({ ...SCOPED, trustProxy: true, trustedProxyHops: 0 })).toThrow(
      /trustedProxyHops/,
    );
    // The floor is 1 because ONE proxy is the smallest topology `trustProxy: true` can describe.
    expect(
      defineHttpConfig({ ...SCOPED, trustProxy: true, trustedProxyHops: 1 }).trustedProxyHops,
    ).toBe(1);
  });

  test('trustProxy: false still resolves 0 — the count is not a declaration at all then', () => {
    // The floor applies to a DECLARED count. With nothing trusted there is no hop to name, and 0
    // is what every reader of `HttpConfig.trustedProxyHops` already treats as "trust nothing".
    expect(defineHttpConfig({ ...SCOPED }).trustedProxyHops).toBe(0);
    expect(defineHttpConfig({ ...SCOPED, trustProxy: false }).trustedProxyHops).toBe(0);
  });

  test('trustProxy: true with no count is still X_TRUST_PROXY_UNSET, not a screened zero', () => {
    // There is no `?? 0` behind this: a default of zero would be the silent trust-nothing above,
    // arriving through the door the unset refusal exists to close. The two refusals are one
    // declaration, so the unset one must still fire and must NOT become the count refusal.
    expect(() => defineHttpConfig({ ...SCOPED, trustProxy: true })).toThrow(/X_TRUST_PROXY_UNSET/);
  });

  test('an app that sets nothing still gets every default', () => {
    const config = defineHttpConfig({ ...SCOPED });
    expect(config.bodyLimitBytes).toBe(1_048_576);
    expect(config.requestTimeoutMs).toBe(30_000);
    expect(config.maxInflight).toBe(1_000);
    expect(config.trustedProxyHops).toBe(0);
  });
});

// `??` reads an explicit `null` as "unset", so `buildId: null` — the documented way to switch
// skew detection off — was overruled by a `BUILD_ID` in the environment. And `HOSTNAME` is the
// container id under Docker, never an address to bind.
describe('a declaration is not overruled by the environment', () => {
  const withEnv = <T>(patch: Record<string, string>, run: () => T): T => {
    const before = Object.fromEntries(Object.keys(patch).map((key) => [key, Bun.env[key]]));
    Object.assign(Bun.env, patch);
    try {
      return run();
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete Bun.env[key];
        else Bun.env[key] = value;
      }
    }
  };

  test('buildId: null disables skew detection whatever BUILD_ID says', () => {
    withEnv({ BUILD_ID: 'from-env' }, () => {
      const base = { rateLimit: { scope: 'process' as const } };
      expect(defineHttpConfig({ ...base, buildId: null }).buildId).toBeNull();
      expect(defineHttpConfig(base).buildId).toBe('from-env');
      expect(defineHttpConfig({ ...base, buildId: 'declared' }).buildId).toBe('declared');
    });
  });

  test('HOSTNAME is never the bind address: undeclared, the server binds every interface', () => {
    withEnv({ HOSTNAME: '3f1c9a7be2d4' }, () => {
      const base = { rateLimit: { scope: 'process' as const } };
      expect(defineHttpConfig(base).hostname).toBe('0.0.0.0');
      expect(defineHttpConfig({ ...base, hostname: '127.0.0.1' }).hostname).toBe('127.0.0.1');
    });
  });
});

describe('the drain budget has one key, and it is drain.deadlineMs', () => {
  // `http.drainTimeoutMs` was a second knob for the budget `drain.deadlineMs` owns (25.0.0): on
  // the web role it won, applied after `lifecycleForRole`, so one app had two answers to "how
  // long does SIGTERM wait" and the role decided which was true.
  test('the resolved config carries no drain key of its own', () => {
    expect(
      Object.keys(defineHttpConfig({ ...SCOPED })).filter((key) => /drain/i.test(key)),
    ).toEqual([]);
  });

  test('a config still passing drainTimeoutMs is refused, naming drain.deadlineMs', () => {
    // Untyped on purpose: the field is gone from `HttpConfigInput`, so only a JS caller, a spread
    // of an `unknown` or a cast can still hand it over — and that caller must hear about it.
    const legacy: unknown = { ...SCOPED, drainTimeoutMs: 5_000 };
    let thrown: unknown;
    try {
      defineHttpConfig(legacy as HttpConfigInput);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UltimateError);
    const error = thrown as UltimateError;
    expect(error.code).toBe('X_CONFIG_INVALID');
    expect(error.cause).toContain('http.drainTimeoutMs');
    expect(error.fix).toContain('drain.deadlineMs');
  });

  // Core's rule for a removed key (`core/src/config-removed.ts`), so the two surfaces agree on
  // what "written" means: `undefined` is a layer not saying, any other value — `null` too — says.
  test('an undefined drainTimeoutMs is a layer not saying, exactly as core reads a removed key', () => {
    const spread: unknown = { ...SCOPED, drainTimeoutMs: undefined };
    expect(() => defineHttpConfig(spread as HttpConfigInput)).not.toThrow();
  });

  test('a null drainTimeoutMs is still the deleted key written', () => {
    const legacy: unknown = { ...SCOPED, drainTimeoutMs: null };
    expect(() => defineHttpConfig(legacy as HttpConfigInput)).toThrow(/drain\.deadlineMs/);
  });
});

describe('the build-id header has one spelling, and it is core BUILD_ID_HEADER', () => {
  // `http.buildIdHeader` let a server listen for a header no client of it sent: the typed client,
  // the service worker and the CORS defaults all spell core's, and none of them read this config.
  test('the resolved config carries no header name of its own', () => {
    expect(Object.hasOwn(defineHttpConfig({ ...SCOPED }), 'buildIdHeader')).toBe(false);
  });

  test('a config still passing buildIdHeader is refused, naming BUILD_ID_HEADER', () => {
    const legacy: unknown = { ...SCOPED, buildIdHeader: 'x-my-build' };
    let thrown: unknown;
    try {
      defineHttpConfig(legacy as HttpConfigInput);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UltimateError);
    const error = thrown as UltimateError;
    expect(error.code).toBe('X_CONFIG_INVALID');
    expect(error.cause).toContain('http.buildIdHeader');
    expect(error.fix).toContain('BUILD_ID_HEADER');
    expect(error.meta).toEqual({ option: 'buildIdHeader', replacement: 'BUILD_ID_HEADER' });
  });

  test('an undefined buildIdHeader is a layer not saying', () => {
    const spread: unknown = { ...SCOPED, buildIdHeader: undefined };
    expect(() => defineHttpConfig(spread as HttpConfigInput)).not.toThrow();
  });

  test('configureHttp refuses it at the declaration too', () => {
    const legacy: unknown = { buildIdHeader: 'x-my-build' };
    expect(() => configureHttp(legacy as AppHttpConfig)).toThrow(/http\.buildIdHeader/);
  });
});
