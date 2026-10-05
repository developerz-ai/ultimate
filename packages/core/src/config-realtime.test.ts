// `realtime.maxSubscriptionsPerActor`: one actor's share of a sync node's live queries. Validated
// here, eagerly, like every count — a `NaN` ceiling is a cap no comparison ever reaches.

import { describe, expect, test } from 'bun:test';
import { defineConfig } from './config';
import { isUltimateError } from './errors';

const refusal = (realtime: unknown): string => {
  try {
    defineConfig({ name: 'app', realtime: realtime as never });
  } catch (error) {
    return isUltimateError(error) ? `${error.code}: ${error.cause}` : 'not coded';
  }
  return 'accepted';
};

describe('realtime.maxSubscriptionsPerActor', () => {
  test('an app may set it, and the merged config carries it', () => {
    const config = defineConfig({ name: 'app', realtime: { maxSubscriptionsPerActor: 50 } });
    expect(config.realtime.maxSubscriptionsPerActor).toBe(50);
  });

  test('unset is the framework default — the sync node applies 1,000', () => {
    expect(defineConfig({ name: 'app' }).realtime.maxSubscriptionsPerActor).toBeUndefined();
  });

  test.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '100'])(
    '%p is refused, naming the key',
    (value) => {
      const said = refusal({ maxSubscriptionsPerActor: value });
      expect(said).toStartWith('X_CONFIG_INVALID');
      expect(said).toContain('realtime.maxSubscriptionsPerActor');
    },
  );
});

describe('realtime.maxSocketsPerActor', () => {
  test('an app may set it; unset is the sync node default of 16', () => {
    expect(
      defineConfig({ name: 'app', realtime: { maxSocketsPerActor: 4 } }).realtime
        .maxSocketsPerActor,
    ).toBe(4);
    expect(defineConfig({ name: 'app' }).realtime.maxSocketsPerActor).toBeUndefined();
  });

  test.each([0, -1, 2.5, Number.NaN, '16'])('%p is refused, naming the key', (value) => {
    const said = refusal({ maxSocketsPerActor: value });
    expect(said).toStartWith('X_CONFIG_INVALID');
    expect(said).toContain('realtime.maxSocketsPerActor');
  });
});
