import { describe, expect, test } from 'bun:test';
import { isRetryableStatus, RETRYABLE_STATUSES } from './retryable-status';

describe('isRetryableStatus', () => {
  test('the four retryable 4xx, and only those four', () => {
    const retryable = Array.from({ length: 100 }, (_, index) => 400 + index).filter(
      isRetryableStatus,
    );
    expect(retryable).toEqual([408, 409, 425, 429]);
  });

  test('every 5xx is retryable and every 2xx/3xx is not', () => {
    expect([500, 502, 503, 504, 599].every(isRetryableStatus)).toBe(true);
    expect([200, 201, 204, 301, 304].some(isRetryableStatus)).toBe(false);
  });

  test('the set is the one the two byte-identical copies shipped', () => {
    // packages/cache/src/purge-http.ts:19 and packages/mail/src/driver-resend.ts:27, verbatim.
    expect([...RETRYABLE_STATUSES].sort((a, b) => a - b)).toEqual([408, 409, 425, 429]);
  });

  test('a 400 and a 404 are terminal — the same body gets the same answer forever', () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(422)).toBe(false);
  });
});
