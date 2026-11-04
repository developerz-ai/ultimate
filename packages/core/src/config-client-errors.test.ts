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
    expect(defineConfig({ name: 'app' }).clientErrors).toEqual({
      enabled: false,
      anonymous: false,
      perMinute: 30,
    });
    expect(CLIENT_ERRORS_DEFAULTS).toEqual({ enabled: false, anonymous: false, perMinute: 30 });
  });

  test('the last layer that said a key wins it; one that said nothing keeps it', () => {
    const config = defineConfig(
      { name: 'app', clientErrors: { enabled: true, perMinute: 10 } },
      { clientErrors: { anonymous: true } },
    );
    expect(config.clientErrors).toEqual({ enabled: true, anonymous: true, perMinute: 10 });
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

describe('ERROR_SOURCES', () => {
  test('a browser report has its own facet', () => {
    expect(ERROR_SOURCES).toContain('browser');
  });
});
