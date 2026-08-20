import { describe, expect, test } from 'bun:test';
import { type AppConfig, defineConfig } from './config';
import { isUltimateError, type UltimateError } from './errors';

describe('defineConfig', () => {
  test('fills every section with defaults from a one-line config', () => {
    const config = defineConfig({ name: 'myapp' });

    expect(config.defaultLocale).toBe('en');
    expect(config.defaultTimeZone).toBe('UTC');
    expect(config.defaultCurrency).toBe('USD');
    expect(config.theme.defaultMode).toBe('system');
    expect(config.pwa.enabled).toBe(false);
    expect(config.database).toEqual({ driver: 'postgres', ssl: false });
    expect(config.jobs.queues).toEqual(['myapp-default']);
    expect(config.ai.mcp).toEqual({ expose: true, path: '/mcp' });
    expect(Object.isFrozen(config)).toBe(true);
  });

  test('overlays let config/ split by concern, last one wins', () => {
    const config = defineConfig(
      { name: 'myapp', locales: ['en', 'es'], defaultLocale: 'es' },
      { jobs: { concurrency: 32 } },
      { realtime: { enabled: true, tier: 'live-queries', transport: 'nats', urlEnv: 'NATS_URL' } },
    );

    expect(config.jobs.concurrency).toBe(32);
    // untouched keys still come from defaults
    expect(config.jobs.maxAttempts).toBe(5);
    expect(config.realtime.tier).toBe('live-queries');
    expect(config.defaultLocale).toBe('es');
  });

  test('collects every problem into one X_CONFIG_INVALID', () => {
    let caught: unknown;
    try {
      defineConfig({
        name: 'My App',
        locales: ['en'],
        defaultLocale: 'de',
        defaultTimeZone: 'Mars/Olympus',
        defaultCurrency: 'usd',
      });
    } catch (thrown) {
      caught = thrown;
    }

    expect(isUltimateError(caught)).toBe(true);
    const error = caught as UltimateError;
    expect(error.code).toBe('X_CONFIG_INVALID');
    expect(error.cause).toContain('name "My App"');
    expect(error.cause).toContain('defaultLocale "de" is not in locales');
    expect(error.cause).toContain('is not an IANA time zone');
    expect(error.cause).toContain('is not a 3-letter ISO 4217 code');
    expect(error.fix).toContain('x verify');
  });

  test('defaultCurrency answers the same bound schema declares, case by case', () => {
    // `CURRENCY_RE` is a deliberate copy of `@ultimat3/schema`'s `CURRENCY_CODE_PATTERN` — core is
    // tier 0 and may not import schema — so the corpus is the copy too: this is the list
    // `money-value.test.ts` and `columns.test.ts` each run their own projection against. A widened
    // or narrowed regex in `config.ts` fails here, which is the only place in this package that a
    // divergence from the tier-0 declaration can be made visible at all. Comparing the two
    // patterns mechanically needs a package that may import both (the shape of
    // `schema-error-codes-pin.test.ts` in `@ultimat3/cli`); this is the local half.
    const cases: readonly (readonly [string, boolean])[] = [
      ['USD', true],
      ['EUR', true],
      ['XBT', true],
      ['AAA', true],
      ['ZZZ', true],
      ['usd', false],
      ['UsD', false],
      ['US', false],
      ['USDD', false],
      ['US1', false],
      ['US_', false],
      ['US ', false],
      [' US', false],
      ['', false],
      // `$` is end-of-input in ECMAScript and end-of-string in Postgres, but end-of-LINE in PCRE:
      // a bound copied through a third dialect accepts this one, and the copy above is a copy.
      ['USD\n', false],
    ];
    for (const [defaultCurrency, accepted] of cases) {
      const build = (): AppConfig => defineConfig({ name: 'myapp', defaultCurrency });
      if (accepted)
        expect([defaultCurrency, build().defaultCurrency]).toEqual([
          defaultCurrency,
          defaultCurrency,
        ]);
      else expect(build).toThrow(/is not a 3-letter ISO 4217 code/);
    }
  });

  test('a non-memory transport without a url env is a config error, not a runtime crash', () => {
    const causeOf = (input: () => void): string => {
      try {
        input();
      } catch (thrown) {
        return (thrown as UltimateError).cause;
      }
      throw new Error('expected defineConfig to throw');
    };

    const realtime = causeOf(() =>
      defineConfig({ name: 'myapp', realtime: { transport: 'nats' } }),
    );
    expect(realtime).toContain('realtime.urlEnv');
    expect(causeOf(() => defineConfig({ name: 'myapp', cache: { driver: 'redis' } }))).toContain(
      'cache.urlEnv',
    );
  });
});

// The claim that `poolSize` / `urlEnv` / `schema` are now a BUILD error lives in `type-pins.ts`,
// not here: `tsconfig.json` excludes `*.test.ts`, so a `@ts-expect-error` written in this file is
// never read by `tsc` and asserts nothing.
describe('database config carries only what something reads', () => {
  test('the fields that remain still default and still overlay', () => {
    expect(defineConfig({ name: 'myapp' }).database).toEqual({ driver: 'postgres', ssl: false });
    expect(defineConfig({ name: 'myapp', database: { ssl: true } }).database.ssl).toBe(true);
  });
});

describe('realtime section', () => {
  // `realtime.heartbeatMs` was declared, defaulted to 15_000 and read by NOTHING — the socket
  // heartbeat is the client's own option and the presence beat is derived from the TTL
  // (`PresenceRegistry.heartbeatMs`). Axiom 1: one knob. Deleted 2026-08-19, and this is what
  // stops it coming back, since a re-added field would sail through `section()` unnoticed.
  test('carries no heartbeatMs — the beat is the client option and the derived presence one', () => {
    const config = defineConfig({ name: 'myapp' });

    expect(Object.keys(config.realtime).sort()).toEqual(['enabled', 'tier', 'transport', 'urlEnv']);
    expect('heartbeatMs' in config.realtime).toBe(false);
  });
});

/**
 * `jobs.driver` accepted `'postgres' | 'redis' | 'nats'` and was read by NOTHING — boot always
 * built `createPgDriver`, so `jobs: { driver: 'redis' }` did not throw, did not warn, and silently
 * gave you Postgres. Deleted in 5.0.0.
 *
 * Asserted at RUNTIME and not only by the compiler, because the compiler is exactly what missed it:
 * this file's overlay test passed `{ jobs: { driver: 'redis' } }` and asserted `config.jobs.driver`
 * came back — green for as long as the field existed, and still green the moment it was deleted,
 * because a spread carries a key no type names. A type-level guard alone would have the same hole.
 */
describe('the dead jobs.driver field', () => {
  test('the default config declares no driver', () => {
    const config = defineConfig({ name: 'myapp' });
    expect(Object.hasOwn(config.jobs, 'driver')).toBe(false);
  });

  test('a JS caller passing one is not answered with a working switch', () => {
    // The cast is what a JS caller — or a config file that predates 5.0.0 — actually does. The
    // value survives the spread, which is why the assertion is that it selects nothing rather than
    // that it is absent: what is gone is the DECLARATION, and with it the promise it made.
    const config = defineConfig({ name: 'myapp' }, { jobs: { concurrency: 3 } } as never);
    expect(config.jobs.concurrency).toBe(3);
    expect(Object.hasOwn(config.jobs, 'driver')).toBe(false);
  });
});
