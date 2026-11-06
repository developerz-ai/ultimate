// The `time` section: `detect` off by default, merged by the last layer that said it, refused in
// its own words when it is not a boolean — a truthy string would have switched a cookie on.
import { describe, expect, test } from 'bun:test';
import { defineConfig } from './config';
import { TIME_DEFAULTS } from './config-time';
import { isUltimateError } from './errors';

const causeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return isUltimateError(error) ? `${error.code} ${error.cause}` : 'not an UltimateError';
  }
  return 'did not throw';
};

describe('time — default, merge and refusal', () => {
  test('detection is off until the app asks: it writes a cookie the app did not have', () => {
    expect(defineConfig({ name: 'app' }).time).toEqual({ detect: false });
    expect(TIME_DEFAULTS).toEqual({ detect: false });
  });

  test('the last layer that said `detect` wins it', () => {
    expect(defineConfig({ name: 'app', time: { detect: true } }).time.detect).toBe(true);
    expect(defineConfig({ name: 'app', time: { detect: true } }, { time: {} }).time.detect).toBe(
      true,
    );
    expect(
      defineConfig({ name: 'app', time: { detect: true } }, { time: { detect: false } }).time
        .detect,
    ).toBe(false);
  });

  test('a non-boolean is refused, and an unknown key under `time` too', () => {
    const untyped: unknown = { name: 'app', time: { detect: 'yes' } };
    expect(causeOf(() => defineConfig(untyped as never))).toContain('time.detect');
    const unknownKey: unknown = { name: 'app', time: { defaultZone: 'Europe/Berlin' } };
    expect(causeOf(() => defineConfig(unknownKey as never))).toContain('X_CONFIG_INVALID');
  });
});
