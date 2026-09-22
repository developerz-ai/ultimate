// The one rule for where a page's socket dials, now the framework's rather than each app's.

import { describe, expect, test } from 'bun:test';
import { SYNC_PATH, syncUrlFrom } from './sync-url';

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
