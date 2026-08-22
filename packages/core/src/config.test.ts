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

  test('names no key the framework does not read', () => {
    // `JobsConfig.driver`'s shape, three more times: `auth.afterSignInPath`, `pwa.installPrompt`
    // and `ai.modelEnv` were each declared, defaulted and merged here and read by NO file, so an
    // app setting one got silence. Key SETS, not spot checks — a spot check cannot see a fourth.
    const config = defineConfig({ name: 'myapp' });

    expect(Object.keys(config.auth).sort()).toEqual(['signInPath']);
    expect(Object.keys(config.pwa).sort()).toEqual([
      'backgroundSync',
      'enabled',
      'offline',
      'push',
    ]);
    expect(Object.keys(config.ai).sort()).toEqual(['mcp']);
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
    expect(error.cause).toContain('is not an IANA Area/Location zone name');
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

  /**
   * An `app.config.ts` written before 5.0.0, as a JS caller or a `// @ts-expect-error` away from
   * one. It does not throw and it does not lose the rest of the section — the key rides through the
   * spread — and that is the honest statement of the migration: deleting the line is the whole of
   * it, and leaving it in does what it always did, which is nothing.
   */
  test('a stale config carrying one still boots, and it still selects nothing', () => {
    const config = defineConfig({ name: 'myapp' }, {
      jobs: { driver: 'redis', concurrency: 3 },
    } as never);
    expect(config.jobs.concurrency).toBe(3);
    expect(config.jobs.maxAttempts).toBe(5);
    // Present as a VALUE, because a spread carries a key no type names — and read by nothing, then
    // as now. What 5.0.0 removed is the declaration, and with it the promise it made.
    expect((config.jobs as { driver?: string }).driver).toBe('redis');
  });
});

/**
 * ONE timezone rule, stated in two places because tier 0 may not import `@ultimat3/time`.
 * `defaultTimeZone` was validated with a bare `new Intl.DateTimeFormat(…)` probe, and ICU 78
 * (Bun 1.4) resolves `CET`, `EST`, `Japan`, `GMT` and `Zulu` where ICU 75 threw — so 6.0.0's
 * structural rule reached `task()` and every `@ultimat3/time` entry point and never reached the
 * config file, and `defaultTimeZone: 'CET'` booted clean and threw on the first format call.
 */
describe('defaultTimeZone answers what @ultimat3/time answers', () => {
  const refusalFor = (defaultTimeZone: string): UltimateError => {
    try {
      defineConfig({ name: 'myapp', defaultTimeZone });
    } catch (thrown) {
      if (isUltimateError(thrown)) return thrown;
    }
    return expect.unreachable(`defaultTimeZone ${JSON.stringify(defaultTimeZone)} must be refused`);
  };

  test.each(['CET', 'EST', 'Japan', 'GMT', 'Zulu', '+01:00'])(
    'refuses %s, which boots clean and throws on the first format call',
    (zone) => {
      const error = refusalFor(zone);
      expect(error.code).toBe('X_CONFIG_INVALID');
      expect(error.cause).toContain(`defaultTimeZone "${zone}"`);
      expect(error.cause).toContain('is not an IANA Area/Location zone name');
    },
  );

  test.each(['Europe/Berlin', 'UTC', 'utc', 'US/Eastern', 'Asia/Calcutta', 'Etc/GMT+2'])(
    'still accepts %s',
    (zone) => {
      expect(defineConfig({ name: 'myapp', defaultTimeZone: zone }).defaultTimeZone).toBe(zone);
    },
  );

  // Axiom 4: an operator holding `CET` needs the spelling to write, not a restatement of the rule.
  test('the fix names the shape, the mechanical swap and how to list every accepted name', () => {
    const fix = refusalFor('CET').fix;
    expect(fix).toContain('Area/Location');
    expect(fix).toContain('Japan → Asia/Tokyo');
    expect(fix).toContain("Intl.supportedValuesOf('timeZone')");
    // The generic instruction survives — a config can be wrong in more than one field at once.
    expect(fix).toContain('x verify');
  });
});
