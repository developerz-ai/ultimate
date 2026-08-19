// Request-zone selection: which source wins, that an invalid one is skipped rather than thrown,
// and that what comes back is the canonical name — a header casing must not fork a formatter cache.

import { afterEach, describe, expect, test } from 'bun:test';
import { configureTime, currentTimeZone, resolveTimeZone, timeConfig } from './context';
import { UTC } from './zones';

const OVERRIDES = { defaultZone: 'Europe/Berlin', order: ['user', 'header', 'query'] as const };

describe('resolveTimeZone', () => {
  test('the first valid source wins and an invalid one is skipped, never thrown', () => {
    expect(resolveTimeZone({ header: 'America/New_York' }, OVERRIDES)).toEqual({
      zone: 'America/New_York',
      source: 'header',
    });
    expect(resolveTimeZone({ user: 'Mars/Olympus', query: 'Asia/Tokyo' }, OVERRIDES)).toEqual({
      zone: 'Asia/Tokyo',
      source: 'query',
    });
    expect(resolveTimeZone({}, OVERRIDES)).toEqual({ zone: 'Europe/Berlin', source: 'default' });
  });

  test('the resolved zone is canonical, so a header casing cannot fork a formatter cache', () => {
    // `Intl` accepts every casing, so `x-timezone: eUrOpE/bErLiN` used to travel the whole
    // request as its own distinct zone string and mint its own permanent formatter.
    expect(resolveTimeZone({ header: 'eUrOpE/bErLiN' }, OVERRIDES).zone).toBe('Europe/Berlin');
    expect(resolveTimeZone({ header: 'utc' }, OVERRIDES).zone).toBe('UTC');
  });
});

// T2. `resolveTimeZone`'s own doc says "the canonical spelling is what leaves this function", and
// `configureTime` writes the value that leaves it on the `default` branch — unchecked. A bad
// default was accepted at boot and surfaced as `X_TIMEZONE_INVALID` at RENDER time, from a
// formatter, in a stack that names no configuration.
describe('configureTime', () => {
  afterEach(() => {
    configureTime({ defaultZone: UTC });
  });

  test('refuses a default zone that is not IANA, at the call that sets it', () => {
    let thrown: unknown;
    try {
      configureTime({ defaultZone: 'Mars/Olympus' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUltimateError('X_TIMEZONE_INVALID');
    // And the config it refused is not half-applied.
    expect(timeConfig().defaultZone).toBe(UTC);
  });

  test('canonicalizes the default, so one zone is not two cache keys', () => {
    // `Intl` answers for every casing, so `eUrOpE/bErLiN` used to travel the process as its own
    // distinct zone string and mint a permanent entry in every formatter cache it reached.
    expect(configureTime({ defaultZone: 'eUrOpE/bErLiN' }).defaultZone).toBe('Europe/Berlin');
    expect(timeConfig().defaultZone).toBe('Europe/Berlin');
    expect(currentTimeZone()).toBe('Europe/Berlin');
    expect(resolveTimeZone({}).zone).toBe('Europe/Berlin');
    expect(configureTime({ defaultZone: 'utc' }).defaultZone).toBe('UTC');
  });

  test('leaves the order alone and returns the merged config', () => {
    const merged = configureTime({ order: ['header'] });
    expect(merged.order).toEqual(['header']);
    expect(merged.defaultZone).toBe(UTC);
    configureTime({ order: ['user', 'cookie', 'query', 'header'] });
  });
});
