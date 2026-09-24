// The one rule for where a page's socket dials, now the framework's rather than each app's.

import { describe, expect, test } from 'bun:test';
import { SYNC_PATH, syncOriginsFrom, syncUrlFrom } from './sync-url';

describe('syncUrlFrom', () => {
  test('no SYNC_URL is the same-origin path — the node every rung already serves there', () => {
    expect(syncUrlFrom({})).toBe(SYNC_PATH);
    expect(syncUrlFrom({ SYNC_URL: '  ' })).toBe('/_x/sync');
  });

  test('a declared ws/wss URL is used verbatim', () => {
    expect(syncUrlFrom({ SYNC_URL: 'wss://sync.example.com/_x/sync' })).toBe(
      'wss://sync.example.com/_x/sync',
    );
  });

  test('anything a browser cannot dial is X_CONFIG_INVALID at boot, never a dead socket later', () => {
    const refusal = (value: string): unknown => {
      try {
        return syncUrlFrom({ SYNC_URL: value });
      } catch (error) {
        return error;
      }
    };
    expect(refusal('https://sync.example.com')).toBeUltimateError('X_CONFIG_INVALID');
    expect(refusal('not a url')).toBeUltimateError('X_CONFIG_INVALID');
  });
});

describe('syncOriginsFrom', () => {
  // The page's origin, when it is served on another host than the node — the one fact a node
  // cannot read off its own request.
  test("APP_URL's origin is the one page origin the node admits besides its own host", () => {
    expect(syncOriginsFrom({ APP_URL: 'https://www.example.com/some/path/' })).toEqual([
      'https://www.example.com',
    ]);
    expect(syncOriginsFrom({})).toEqual([]);
    expect(syncOriginsFrom({ APP_URL: ' ' })).toEqual([]);
  });

  test('an APP_URL that is no URL is X_CONFIG_INVALID, never an empty allowance', () => {
    const error = (() => {
      try {
        return syncOriginsFrom({ APP_URL: 'www.example.com' });
      } catch (failure) {
        return failure;
      }
    })();
    expect((error as { code?: string }).code).toBe('X_CONFIG_INVALID');
  });
});
