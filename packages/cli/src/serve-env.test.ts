// What the container's environment decides, at the edges `serve.test.ts` does not reach: a port is
// decimal digits and nothing else, and an empty `ROLE` reads like an empty `PORT` or `HOST`.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { DEFAULT_PORT, metricsPortFromEnv, portFromEnv, roleFromEnv } from './serve-env';

const codeOf = (run: () => unknown): string => {
  try {
    run();
    return 'accepted';
  } catch (error) {
    return isUltimateError(error) ? error.code : 'uncoded';
  }
};

describe('unit · serve-env', () => {
  // `Number()` read `0x1F90` as 8080 and `8e3` as 8000, so "the whole string has to be a port"
  // admitted two spellings of a port nobody wrote down (s2-cli low).
  test('a port is decimal digits: hex, exponent, sign and fraction are refused', () => {
    for (const value of ['0x1F90', '8e3', '+80', '80.0', '1_000', '0b1']) {
      expect(codeOf(() => portFromEnv({ PORT: value }))).toBe('X_PORT_INVALID');
      expect(codeOf(() => metricsPortFromEnv({ METRICS_PORT: value }))).toBe('X_PORT_INVALID');
    }
    expect(portFromEnv({ PORT: ' 8080 ' })).toBe(8080);
    expect(portFromEnv({ PORT: '0' })).toBe(0);
  });

  test('an empty or blank ROLE is the default, as an empty PORT and HOST are', () => {
    expect(roleFromEnv({ ROLE: '' })).toBe('web');
    expect(roleFromEnv({ ROLE: '  ' })).toBe('web');
    expect(roleFromEnv({ ROLE: ' worker ' })).toBe('worker');
    expect(portFromEnv({ PORT: '' })).toBe(DEFAULT_PORT);
    expect(codeOf(() => roleFromEnv({ ROLE: 'wroker' }))).toBe('X_ROLE_UNKNOWN');
  });
});
