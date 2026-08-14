import { describe, expect, test } from 'bun:test';
import { APP_VERSION_KEY, appVersion, DEFAULT_APP_VERSION } from './app-version';

describe('appVersion', () => {
  test('reads APP_VERSION', () => {
    expect(appVersion({ [APP_VERSION_KEY]: '1.4.2' })).toBe('1.4.2');
  });

  test('an unset key is the local build', () => {
    expect(appVersion({})).toBe(DEFAULT_APP_VERSION);
    expect(DEFAULT_APP_VERSION).toBe('dev');
  });

  test('an exported-but-empty key names no build either', () => {
    // A platform that exports the key with no value has said nothing, and `""` written into a
    // ledger row is a build id no operator can look up.
    expect(appVersion({ [APP_VERSION_KEY]: '' })).toBe(DEFAULT_APP_VERSION);
  });

  test('reads this process environment by default', () => {
    const previous = process.env[APP_VERSION_KEY];
    process.env[APP_VERSION_KEY] = 'from-process-env';
    try {
      expect(appVersion()).toBe('from-process-env');
    } finally {
      if (previous === undefined) delete process.env[APP_VERSION_KEY];
      else process.env[APP_VERSION_KEY] = previous;
    }
  });
});
