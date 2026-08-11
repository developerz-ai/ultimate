// Which CDN a boot purges against is decided exactly once, here. These tests are what keep the
// two failure modes out: a half-set pair reading as "no CDN" (an environment that ships believing
// it purges), and two credentials resolving to a winner (one edge left serving a stale page).

import { describe, expect, test } from 'bun:test';
import { CDN_PURGE_ENV_KEYS, isNoopPurgeDriver, selectPurgeDriver } from './purge-env';

const FASTLY = { FASTLY_API_TOKEN: 'fastly-token', FASTLY_SERVICE_ID: 'svc_1' };
const CLOUDFLARE = { CLOUDFLARE_API_TOKEN: 'cf-token', CLOUDFLARE_ZONE_ID: 'zone_1' };

const refusal = (env: Record<string, string | undefined>): { code?: string; cause?: string } => {
  try {
    selectPurgeDriver(env);
  } catch (error) {
    return error as { code?: string; cause?: string };
  }
  throw new Error('expected selectPurgeDriver to refuse');
};

describe('CDN_PURGE_ENV_KEYS', () => {
  test('names the four keys this module reads, and nothing else', () => {
    expect([...CDN_PURGE_ENV_KEYS]).toEqual([
      'FASTLY_API_TOKEN',
      'FASTLY_SERVICE_ID',
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_ZONE_ID',
    ]);
  });
});

describe('selectPurgeDriver', () => {
  test('a complete Fastly pair selects fastly', () => {
    const selection = selectPurgeDriver(FASTLY);
    expect(selection.driver.name).toBe('fastly');
    expect(selection.detail).toBe('FASTLY_API_TOKEN');
  });

  test('a complete Cloudflare pair selects cloudflare', () => {
    const selection = selectPurgeDriver(CLOUDFLARE);
    expect(selection.driver.name).toBe('cloudflare');
    expect(selection.detail).toBe('CLOUDFLARE_API_TOKEN');
  });

  test('no credential purges nothing, and says what to set', () => {
    const selection = selectPurgeDriver({});
    expect(isNoopPurgeDriver(selection.driver)).toBe(true);
    expect(selection.detail).toContain('FASTLY_API_TOKEN');
    expect(selection.detail).toContain('CLOUDFLARE_API_TOKEN');
  });

  test('a blank credential is no credential, not an empty token', () => {
    expect(isNoopPurgeDriver(selectPurgeDriver({ FASTLY_API_TOKEN: '   ' }).driver)).toBe(true);
    expect(isNoopPurgeDriver(selectPurgeDriver({ CLOUDFLARE_ZONE_ID: '' }).driver)).toBe(true);
  });

  // A token with no service id is a half-finished deploy. Treating it as "no CDN" is how an
  // environment ships believing it purges — so either key selects, and the other is required.
  test('a token without its id refuses, naming the missing key', () => {
    const failure = refusal({ FASTLY_API_TOKEN: 'fastly-token' });
    expect(failure.code).toBe('X_CONFIG_INVALID');
    expect(failure.cause).toContain('FASTLY_SERVICE_ID');
  });

  test('an id without its token refuses, naming the missing key', () => {
    const failure = refusal({ CLOUDFLARE_ZONE_ID: 'zone_1' });
    expect(failure.code).toBe('X_CONFIG_INVALID');
    expect(failure.cause).toContain('CLOUDFLARE_API_TOKEN');
  });

  test('two CDNs at once are refused rather than resolved to a winner', () => {
    const failure = refusal({ ...FASTLY, ...CLOUDFLARE });
    expect(failure.code).toBe('X_CONFIG_INVALID');
    expect(failure.cause).toContain('two CDNs');
  });

  test('a stray key from the other provider still refuses', () => {
    expect(refusal({ ...FASTLY, CLOUDFLARE_ZONE_ID: 'zone_1' }).code).toBe('X_CONFIG_INVALID');
  });

  // The detail reaches a boot line and a log. `FASTLY_API_TOKEN` holds a credential.
  test('the detail carries the env key, never the value behind it', () => {
    expect(selectPurgeDriver(FASTLY).detail).not.toContain('fastly-token');
    expect(selectPurgeDriver(CLOUDFLARE).detail).not.toContain('cf-token');
  });
});
