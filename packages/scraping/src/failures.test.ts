// Reading a thrown value nobody here constructed. Both questions have to survive the trip a real
// failure makes — through a worker, a subprocess, a JSON round trip — because a terminal failure
// that arrives as a plain object and is not recognised there is a failure the queue retries.

import { describe, expect, test } from 'bun:test';
import { authFailed, blocked, promptUnanswered, sessionExpired } from './error-throws';
import { BURNS_SESSION, burnsSession, errorCode, NEVER_RETRIED, neverRetried } from './failures';

describe('unit · errorCode', () => {
  test('an UltimateError answers its code, never its message', () => {
    const error = authFailed('orders.daily', 'wrong password');
    expect(errorCode(error)).toBe('X_SCRAPE_AUTH_FAILED');
  });

  test('a plain object that crossed a worker boundary still answers its code', () => {
    expect(errorCode({ code: 'X_SCRAPE_BLOCKED', message: 'blocked' })).toBe('X_SCRAPE_BLOCKED');
  });

  test('a code that is not an X_ code is not a code — a site`s own `code` field is not ours', () => {
    // A fetch failure carries `code: 'ECONNRESET'`, and a scraped payload can carry anything.
    expect(errorCode({ code: 'ECONNRESET' })).toBeUndefined();
    expect(errorCode({ code: 42 })).toBeUndefined();
    expect(errorCode(new Error('X_SCRAPE_BLOCKED'))).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
    expect(errorCode('X_SCRAPE_BLOCKED')).toBeUndefined();
  });
});

describe('unit · burnsSession', () => {
  test('a block and an expired session both burn the identity', () => {
    expect(burnsSession(blocked('orders.daily', 'https://shop.test/orders', 'HTTP 403'))).toBe(
      true,
    );
    expect(burnsSession(sessionExpired('orders.daily', 'k'))).toBe(true);
    expect([...BURNS_SESSION].sort()).toEqual(['X_SCRAPE_BLOCKED', 'X_SCRAPE_SESSION_EXPIRED']);
  });

  test('anything else keeps the session — burning one costs a fresh login on every hiccup', () => {
    expect(burnsSession(authFailed('orders.daily', 'wrong password'))).toBe(false);
    expect(burnsSession(new Error('socket hang up'))).toBe(false);
    expect(burnsSession(undefined)).toBe(false);
  });
});

describe('unit · neverRetried', () => {
  test('a refused credential and an unanswered prompt are never retried', () => {
    // A site that locks an account after three wrong attempts makes a retrying framework the
    // thing that destroys the user's account.
    expect(neverRetried(authFailed('orders.daily', 'wrong password'))).toBe(true);
    expect(neverRetried(promptUnanswered('orders.daily', 'SMS code'))).toBe(true);
    expect([...NEVER_RETRIED].sort()).toEqual([
      'X_SCRAPE_AUTH_FAILED',
      'X_SCRAPE_PROMPT_UNANSWERED',
    ]);
  });

  test('a block IS retried — a new identity is exactly what the retry is for', () => {
    expect(neverRetried(blocked('orders.daily', 'https://shop.test/orders', 'HTTP 403'))).toBe(
      false,
    );
    expect(neverRetried({ code: 'X_SCRAPE_TIMEOUT' })).toBe(false);
    expect(neverRetried(null)).toBe(false);
  });
});
