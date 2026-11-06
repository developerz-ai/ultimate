// The `clientErrors` section: off by default, merged key by key, every knob refused in its words.
import { describe, expect, test } from 'bun:test';
import { defineConfig } from './config';
import { CLIENT_ERRORS_DEFAULTS } from './config-client-errors';
import { ERROR_SOURCES } from './error-reporter';
import { isUltimateError } from './errors';

const causeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return isUltimateError(error) ? `${error.code} ${error.cause}` : 'not an UltimateError';
  }
  return 'did not throw';
};

describe('clientErrors — default, merge and refusal', () => {
  test('off by default, anonymous refused, 30 a minute', () => {
    const vitals = { enabled: false, sampleRate: 0.1, surfaces: ['app' as const] };
    expect(defineConfig({ name: 'app' }).clientErrors).toEqual({
      enabled: false,
      anonymous: false,
      perMinute: 30,
      vitals,
    });
    expect(CLIENT_ERRORS_DEFAULTS).toEqual({
      enabled: false,
      anonymous: false,
      perMinute: 30,
      vitals,
    });
  });

  test('the last layer that said a key wins it; one that said nothing keeps it', () => {
    const config = defineConfig(
      { name: 'app', clientErrors: { enabled: true, perMinute: 10 } },
      { clientErrors: { anonymous: true } },
    );
    expect(config.clientErrors).toMatchObject({ enabled: true, anonymous: true, perMinute: 10 });
  });

  test('perMinute: 0 is X_CONFIG_INVALID — a limit of nothing is a route that refuses everything', () => {
    const cause = causeOf(() => defineConfig({ name: 'app', clientErrors: { perMinute: 0 } }));
    expect(cause).toStartWith('X_CONFIG_INVALID');
    expect(cause).toContain('clientErrors.perMinute');
  });

  test('a fraction and a string are refused too', () => {
    expect(
      causeOf(() => defineConfig({ name: 'app', clientErrors: { perMinute: 2.5 } })),
    ).toContain('clientErrors.perMinute');
    expect(
      causeOf(() =>
        defineConfig({ name: 'app', clientErrors: { enabled: 'true' as unknown as boolean } }),
      ),
    ).toContain('clientErrors.enabled must be true or false');
    expect(
      causeOf(() =>
        defineConfig({ name: 'app', clientErrors: { anonymous: 1 as unknown as boolean } }),
      ),
    ).toContain('clientErrors.anonymous must be true or false');
  });

  test('an unknown key in the block is refused by name', () => {
    const cause = causeOf(() =>
      defineConfig({
        name: 'app',
        clientErrors: { webVitals: true } as unknown as { enabled: boolean },
      }),
    );
    expect(cause).toStartWith('X_CONFIG_INVALID');
    expect(cause).toContain('webVitals');
  });
});

describe('clientErrors.vitals — real-user timings, the same door', () => {
  test('off by default, and on independently of error reports', () => {
    const config = defineConfig({ name: 'app', clientErrors: { vitals: { enabled: true } } });
    expect(config.clientErrors.enabled).toBe(false);
    expect(config.clientErrors.vitals).toEqual({
      enabled: true,
      sampleRate: 0.1,
      surfaces: ['app'],
    });
  });

  test('merged key by key inside the block: an overlay naming one key keeps the others', () => {
    const config = defineConfig(
      { name: 'app', clientErrors: { vitals: { enabled: true, sampleRate: 0.5 } } },
      { clientErrors: { vitals: { surfaces: ['app', 'site'] } } },
    );
    expect(config.clientErrors.vitals).toEqual({
      enabled: true,
      sampleRate: 0.5,
      surfaces: ['app', 'site'],
    });
  });

  test('a rate outside 0–1, or not a number, is refused by name', () => {
    for (const sampleRate of [1.5, -0.1, Number.NaN, '0.5' as unknown as number]) {
      const cause = causeOf(() =>
        defineConfig({ name: 'app', clientErrors: { vitals: { sampleRate } } }),
      );
      expect(cause).toStartWith('X_CONFIG_INVALID');
      expect(cause).toContain('clientErrors.vitals.sampleRate');
    }
    expect(
      causeOf(() => defineConfig({ name: 'app', clientErrors: { vitals: { sampleRate: 0 } } })),
    ).toBe('did not throw');
  });

  test('a surface outside app and site, or none at all, is refused by name', () => {
    const unknown = causeOf(() =>
      defineConfig({
        name: 'app',
        clientErrors: { vitals: { surfaces: ['admin' as unknown as 'app'] } },
      }),
    );
    expect(unknown).toContain('clientErrors.vitals.surfaces');
    expect(unknown).toContain('admin');
    const none = causeOf(() =>
      defineConfig({ name: 'app', clientErrors: { vitals: { surfaces: [] } } }),
    );
    expect(none).toContain('clientErrors.vitals.surfaces');
  });

  test('an unknown key inside vitals is refused by name', () => {
    const cause = causeOf(() =>
      defineConfig({
        name: 'app',
        clientErrors: { vitals: { lcp: true } as unknown as { enabled: boolean } },
      }),
    );
    expect(cause).toStartWith('X_CONFIG_INVALID');
    expect(cause).toContain('lcp');
  });
});

describe('ERROR_SOURCES', () => {
  test('a browser report has its own facet', () => {
    expect(ERROR_SOURCES).toContain('browser');
  });
});
