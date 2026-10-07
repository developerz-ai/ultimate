import { describe, expect, test } from 'bun:test';
import { type AppConfigInput, defineConfig } from './config';
import { REMOVED_CONFIG_KEYS } from './config-removed';
import { isUltimateError, type UltimateError } from './errors';

/**
 * 25.0.0 deleted six `app.config.ts` keys. An app upgrading carries them in a file the compiler
 * may not see (a JS config, an overlay cast through `never`), and a key that is silently ignored
 * is the defect the deletion exists to end — so each one is REFUSED, by name, with its
 * replacement in the `fix:`.
 */
const refusalOf = (...layers: readonly unknown[]): UltimateError => {
  const [base, ...overlays] = layers;
  try {
    defineConfig(base as AppConfigInput, ...(overlays as never[]));
  } catch (thrown) {
    if (isUltimateError(thrown)) return thrown;
  }
  return expect.unreachable(`defineConfig accepted ${JSON.stringify(layers)}`);
};

const CASES: readonly (readonly [string, Record<string, unknown>, string])[] = [
  ['locales', { locales: ['en', 'es'] }, 'defineCatalogs'],
  ['defaultLocale', { defaultLocale: 'en' }, 'defineCatalogs'],
  ['defaultTimeZone', { defaultTimeZone: 'UTC' }, 'zone'],
  ['defaultCurrency', { defaultCurrency: 'USD' }, 'currency'],
  ['theme.tokens', { theme: { defaultMode: 'dark', tokens: { brand: 'primary' } } }, 'defineTheme'],
  // Two sources for one URL: endpoint #0 mounted here while its RFC 9728 metadata named its own.
  ['ai.mcp.path', { ai: { mcp: { expose: true, path: '/mcp' } } }, 'defineAppMcp({ path'],
];

describe('a key 25.0.0 removed', () => {
  test.each(CASES)(
    '%s is refused with X_CONFIG_INVALID naming its replacement',
    (key, said, by) => {
      const error = refusalOf({ name: 'myapp', ...said });
      expect(error.code).toBe('X_CONFIG_INVALID');
      expect(error.cause).toContain(`${key} was removed in 25.0.0`);
      expect(error.fix).toContain(by);
      expect(error.fix).toContain(`delete ${key} from app.config.ts`);
      expect(error.meta).toEqual({ issues: [expect.stringContaining(key)], removed: [key] });
    },
  );

  test.each(CASES)('%s is refused from an overlay too', (key, said) => {
    expect(refusalOf({ name: 'myapp' }, said).cause).toContain(`${key} was removed in 25.0.0`);
  });

  test('every removed key in one config is named in one refusal', () => {
    const all = Object.assign({ name: 'myapp' }, ...CASES.map(([, said]) => said));
    const error = refusalOf(all);
    for (const [key] of CASES) expect(error.cause).toContain(`${key} was removed`);
    expect(error.meta?.['removed']).toEqual(CASES.map(([key]) => key));
  });

  // `undefined` is a layer not saying — the rule every other key follows — so an overlay that
  // spreads a section with the key unset is not an app still writing it.
  test('a key written as undefined is not a key written', () => {
    const config = defineConfig({ name: 'myapp' }, {
      locales: undefined,
      theme: { tokens: undefined },
    } as never);
    expect(config.theme.defaultMode).toBe('system');
  });

  test('the table is these keys and every row carries a replacement', () => {
    expect(Object.keys(REMOVED_CONFIG_KEYS).sort()).toEqual([
      'ai.mcp.path',
      'defaultCurrency',
      'defaultLocale',
      'defaultTimeZone',
      'jobs.driver',
      'locales',
      'theme.tokens',
    ]);
    for (const row of Object.values(REMOVED_CONFIG_KEYS)) {
      expect(row.removedIn).toMatch(/^\d+\.0\.0$/);
      expect(row.instead.length).toBeGreaterThan(20);
    }
  });
});

describe('the config an app gets carries none of them', () => {
  test('no top-level removed key, and theme is defaultMode alone', () => {
    const config = defineConfig({ name: 'myapp' });
    for (const key of ['locales', 'defaultLocale', 'defaultTimeZone', 'defaultCurrency']) {
      expect(Object.hasOwn(config, key)).toBe(false);
    }
    expect(Object.keys(config.theme)).toEqual(['defaultMode']);
    expect(Object.keys(config.ai.mcp)).toEqual(['expose']);
  });
});
