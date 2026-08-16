import { describe, expect, test } from 'bun:test';
import { resolveTimeZone } from './context';

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
