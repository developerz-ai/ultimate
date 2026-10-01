// The `navigation` section: the refusals `defineConfig` raises, the default, and the overlay merge.
import { describe, expect, test } from 'bun:test';
import { defineConfig } from './config';
import type { NavigationSurface } from './config-navigation';
import { isUltimateError } from './errors';

const causeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (!isUltimateError(error)) return expect.unreachable('defineConfig threw its own error');
    return error.cause;
  }
  return expect.unreachable('expected X_CONFIG_INVALID, nothing was thrown');
};

/** What an untyped `app.config.js` can write and the type would refuse. */
const untyped = (client: unknown): readonly NavigationSurface[] =>
  client as readonly NavigationSurface[];

describe('navigation — refusals', () => {
  test('a surface that renders no documents is refused, by name', () => {
    expect(
      causeOf(() => defineConfig({ name: 'app', navigation: { client: untyped(['api']) } })),
    ).toContain('navigation.client contains "api", not one of site, app');
    expect(
      causeOf(() => defineConfig({ name: 'app', navigation: { client: untyped(['shared']) } })),
    ).toContain('"shared"');
  });

  test('a value that is not a list is refused rather than read as one surface', () => {
    expect(
      causeOf(() => defineConfig({ name: 'app', navigation: { client: untyped('app') } })),
    ).toContain('navigation.client must be a list of surfaces');
  });

  test('a surface listed twice is refused', () => {
    expect(
      causeOf(() => defineConfig({ name: 'app', navigation: { client: ['app', 'app'] } })),
    ).toContain('lists "app" twice');
  });
});

describe('navigation — default and merge', () => {
  test('off by default: every navigation is a full document load', () => {
    expect(defineConfig({ name: 'app' }).navigation.client).toEqual([]);
  });

  test('the last layer that listed surfaces wins; one that said nothing keeps it', () => {
    const config = defineConfig(
      { name: 'app', navigation: { client: ['app'] } },
      { navigation: { client: ['site', 'app'] } },
      { navigation: {} },
    );
    expect(config.navigation.client).toEqual(['site', 'app']);
  });
});

describe('navigation.speculation', () => {
  test('on by default, at moderate, with nothing excluded', () => {
    expect(defineConfig({ name: 'app' }).navigation.speculation).toEqual({
      prefetch: 'moderate',
      exclude: [],
    });
  });

  test('each key is the last layer that set it; `false` turns it off', () => {
    const config = defineConfig(
      { name: 'app', navigation: { speculation: { prefetch: 'conservative', exclude: ['/a/*'] } } },
      { navigation: { speculation: { prefetch: false } } },
    );
    expect(config.navigation.speculation).toEqual({ prefetch: false, exclude: ['/a/*'] });
  });

  test('an eagerness that fetches links nobody pointed at is refused', () => {
    expect(
      causeOf(() =>
        defineConfig({
          name: 'app',
          navigation: { speculation: { prefetch: 'eager' as unknown as 'moderate' } },
        }),
      ),
    ).toContain('navigation.speculation.prefetch must be moderate, conservative or false');
  });

  test('an exclusion that is not a same-origin path pattern is refused', () => {
    expect(
      causeOf(() =>
        defineConfig({
          name: 'app',
          navigation: { speculation: { exclude: ['https://other.test/*'] } },
        }),
      ),
    ).toContain('navigation.speculation.exclude contains');
  });
});
