// `HttpConfig.tls`: a listener's certificate and key, both or neither, judged at the boundary so a
// half-declared pair is a coded refusal at boot — never a plaintext listener or a bare TypeError.

import { describe, expect, test } from 'bun:test';
import { defineHttpConfig, type HttpConfigInput } from './config';

const CERT = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
const KEY = '-----BEGIN PRIVATE KEY-----\nMIGH\n-----END PRIVATE KEY-----\n';
const base: HttpConfigInput = { rateLimit: { scope: 'process' } };

describe('unit · http tls is both halves or none', () => {
  test('absent is absent: the resolved config carries no tls key at all', () => {
    expect(Object.hasOwn(defineHttpConfig(base), 'tls')).toBe(false);
  });

  test('a PEM certificate and a PEM key are carried as given', () => {
    expect(defineHttpConfig({ ...base, tls: { cert: CERT, key: KEY } }).tls).toEqual({
      cert: CERT,
      key: KEY,
    });
  });

  test('an empty half, a swapped pair or a non-PEM value is X_CONFIG_INVALID, the key never echoed', () => {
    const bad = [
      { cert: CERT, key: '' },
      { cert: '', key: KEY },
      { cert: KEY, key: CERT },
      { cert: CERT, key: 'not a pem at all' },
    ];
    for (const tls of bad) {
      let caught: unknown;
      try {
        defineHttpConfig({ ...base, tls });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeUltimateError('X_CONFIG_INVALID');
      expect(JSON.stringify(caught)).not.toContain('MIGH');
    }
  });
});
