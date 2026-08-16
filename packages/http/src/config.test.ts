// `defineHttpConfig` is where every HTTP default is decided once, so these tests are the
// record of what an app gets when it writes nothing — a quiet change to a default changes
// every app that never set the field. `stripBasePath` is here too, because a mount point that
// matches off a segment boundary hands one route's traffic to another.
import { describe, expect, test } from 'bun:test';
import { defineHttpConfig, stripBasePath } from './config';
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
      buildIdHeader: 'x-my-build',
      dev: false,
      trustProxy: false,
      bodyLimitBytes: 2_048,
      drainTimeoutMs: 5_000,
    });

    expect(config.port).toBe(4321);
    expect(config.hostname).toBe('localhost');
    expect(config.basePath).toBe('/api');
    expect(config.buildId).toBe('build-1');
    expect(config.buildIdHeader).toBe('x-my-build');
    expect(config.dev).toBe(false);
    expect(config.trustProxy).toBe(false);
    expect(config.bodyLimitBytes).toBe(2_048);
    expect(config.drainTimeoutMs).toBe(5_000);
  });

  test('defaults not overridden by env: basePath, buildIdHeader, trustProxy, bodyLimitBytes, drainTimeoutMs', () => {
    const config = defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false });

    expect(config.basePath).toBe('/');
    expect(config.buildIdHeader).toBe('x-ultimate-build');
    // `false`, and it USED to be `true`: trusting x-forwarded-* and x-request-id is a claim
    // about the deployment, and a direct caller could otherwise choose its own request id.
    expect(config.trustProxy).toBe(false);
    expect(config.trustedProxyHops).toBe(0);
    expect(config.bodyLimitBytes).toBe(1_048_576);
    expect(config.drainTimeoutMs).toBe(15_000);
  });

  test('locale merges input over DEFAULT_LOCALE_CONFIG', () => {
    const config = defineHttpConfig({
      rateLimit: { scope: 'process' },
      dev: false,
      locale: { default: 'de' },
    });

    expect(config.locale.default).toBe('de');
    expect(config.locale.supported).toEqual(DEFAULT_LOCALE_CONFIG.supported);
    expect(config.locale.cookie).toBe(DEFAULT_LOCALE_CONFIG.cookie);
  });

  test('tz merges input over DEFAULT_TZ_CONFIG', () => {
    const config = defineHttpConfig({
      rateLimit: { scope: 'process' },
      dev: false,
      tz: { default: 'America/New_York' },
    });

    expect(config.tz.default).toBe('America/New_York');
    expect(config.tz.header).toBe(DEFAULT_TZ_CONFIG.header);
    expect(config.tz.cookie).toBe(DEFAULT_TZ_CONFIG.cookie);
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
