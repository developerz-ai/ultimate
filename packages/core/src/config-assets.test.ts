// The `assets` section: absent by default (today's behaviour), the overlay merge, and the
// refusals `defineConfig` raises for a retention window that could never be one.
import { describe, expect, test } from 'bun:test';
import { defineConfig } from './config';
import { isUltimateError } from './errors';

const failure = (call: () => unknown): { readonly code: string; readonly cause: string } => {
  try {
    call();
  } catch (error) {
    if (isUltimateError(error)) return { code: error.code, cause: error.cause };
    return expect.unreachable('defineConfig threw something that is not an UltimateError');
  }
  return expect.unreachable('defineConfig accepted it');
};

const retain = (value: unknown): unknown =>
  defineConfig({ name: 'app', assets: { retain: value as { disk: string; builds: number } } });

describe('assets.retain — default, merge and refusal', () => {
  test('absent by default: nothing is retained, as before the key existed', () => {
    expect(defineConfig({ name: 'app' }).assets).toEqual({ retain: undefined });
  });

  test('a declared window is carried as written', () => {
    const config = defineConfig({ name: 'app', assets: { retain: { disk: 'assets', builds: 3 } } });
    expect(config.assets.retain).toEqual({ disk: 'assets', builds: 3 });
  });

  test('the last layer that said it wins; one that said nothing keeps it', () => {
    const kept = defineConfig(
      { name: 'app', assets: { retain: { disk: 'assets', builds: 3 } } },
      { assets: {} },
    );
    expect(kept.assets.retain).toEqual({ disk: 'assets', builds: 3 });
    const moved = defineConfig(
      { name: 'app', assets: { retain: { disk: 'assets', builds: 3 } } },
      { assets: { retain: { disk: 'bucket', builds: 5 } } },
    );
    expect(moved.assets.retain).toEqual({ disk: 'bucket', builds: 5 });
  });

  test('builds that is not a whole number of at least 1 is X_CONFIG_INVALID, naming the key', () => {
    for (const builds of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '3']) {
      const refused = failure(() => retain({ disk: 'assets', builds }));
      expect(refused.code).toBe('X_CONFIG_INVALID');
      expect(refused.cause).toContain('assets.retain.builds must be a whole number of at least 1');
    }
  });

  test('builds has no default: a window the app did not size is refused', () => {
    expect(failure(() => retain({ disk: 'assets' })).cause).toContain(
      'assets.retain.builds must be a whole number of at least 1',
    );
  });

  test('a disk that is not a non-empty name is refused', () => {
    for (const disk of ['', '  ', 3, undefined]) {
      expect(failure(() => retain({ disk, builds: 2 })).cause).toContain(
        'assets.retain.disk must name a disk declared with defineStorage',
      );
    }
  });

  test('a retain that is not an object, and a key the section does not hold, are refused', () => {
    expect(failure(() => retain(true)).cause).toContain('assets.retain must be { disk, builds }');
    const typo = failure(() => retain({ disk: 'assets', builds: 2, bulids: 3 }));
    expect(typo.cause).toContain('assets.retain.bulids is not an app.config.ts key');
  });
});
