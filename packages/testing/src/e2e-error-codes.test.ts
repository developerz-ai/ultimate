// The e2e driver's codes are registered by importing the barrel, and by importing only the module
// that throws them — the two ways a process reaches a CDP refusal.
import { expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode } from '@ultimat3/core';
import { CdpTimeoutError } from './cdp-errors';
import { E2E_ERROR_CODES, E2E_ERROR_TITLES } from './index';

test('every e2e and CDP code is registered with its own title', () => {
  for (const code of E2E_ERROR_CODES) {
    expect(hasErrorCode(code)).toBe(true);
    expect(describeErrorCode(code).title).toBe(E2E_ERROR_TITLES[code]);
  }
});

test('a CDP refusal renders its registered title as the first line', () => {
  const error = new CdpTimeoutError({ method: 'Page.navigate', timeoutMs: 5 });
  expect(error).toBeUltimateError('X_CDP_TIMEOUT');
  expect(error.format()).toContain(E2E_ERROR_TITLES.X_CDP_TIMEOUT);
});
