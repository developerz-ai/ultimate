/**
 * unit — no socket. A `Retry-After` header off the wire, read as the delay a responder named:
 * delta-seconds and the IMF-fixdate form, capped, and anything else ignored rather than guessed.
 */

import { describe, expect, test } from 'bun:test';
import { MAX_RETRY_AFTER_SECONDS, retryAfterSecondsOf } from './client-retry-after';

const NOW = 'Wed, 21 Oct 2015 07:27:00 GMT';

describe('retryAfterSecondsOf', () => {
  test('reads delta-seconds, the form @ultimat3/http writes', () => {
    expect(retryAfterSecondsOf('120', NOW)).toBe(120);
    expect(retryAfterSecondsOf(' 7 ', NOW)).toBe(7);
    expect(retryAfterSecondsOf('1', NOW)).toBe(1);
  });

  test("reads an IMF-fixdate against the response's own Date", () => {
    expect(retryAfterSecondsOf('Wed, 21 Oct 2015 07:28:00 GMT', NOW)).toBe(60);
    expect(retryAfterSecondsOf('Wed, 21 Oct 2015 07:27:01 GMT', NOW)).toBe(1);
  });

  test('a stated 0 or a date already past is UNSTATED, so attempts never burn instantly', () => {
    // A zero wait is no schedule at all: every retry would fire at once, and a webhook would
    // dead-letter within seconds. Unstated falls back to the jittered curve instead.
    expect(retryAfterSecondsOf('0', NOW)).toBeUndefined();
    expect(retryAfterSecondsOf('000', NOW)).toBeUndefined();
    expect(retryAfterSecondsOf('Wed, 21 Oct 2015 07:00:00 GMT', NOW)).toBeUndefined();
    expect(retryAfterSecondsOf('Wed, 21 Oct 2015 07:27:00 GMT', NOW)).toBeUndefined();
  });

  test('a date with no readable Date beside it is ignored — the client clock is not trusted', () => {
    expect(retryAfterSecondsOf('Wed, 21 Oct 2015 07:28:00 GMT', null)).toBeUndefined();
    expect(retryAfterSecondsOf('Wed, 21 Oct 2015 07:28:00 GMT', 'yesterday')).toBeUndefined();
    // Delta-seconds needs no clock at all.
    expect(retryAfterSecondsOf('5', null)).toBe(5);
  });

  test('caps what it will wait, whichever form named it', () => {
    expect(retryAfterSecondsOf('999999999999999999999', NOW)).toBe(MAX_RETRY_AFTER_SECONDS);
    expect(retryAfterSecondsOf('Fri, 21 Oct 2095 07:28:00 GMT', NOW)).toBe(MAX_RETRY_AFTER_SECONDS);
  });

  test('ignores anything that is neither form', () => {
    for (const garbage of [
      null,
      '',
      '-1',
      '1.5',
      '1e3',
      'soon',
      '12abc',
      'Wed, 99 Oct 2015 07:28:00 GMT',
      'Wednesday, 21-Oct-15 07:28:00 GMT',
    ]) {
      expect(retryAfterSecondsOf(garbage, NOW)).toBeUndefined();
    }
  });
});
