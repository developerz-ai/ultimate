// The one property a memoised boot has to have and the plain `??=` does not: a rejection is not
// an answer. One transient failure — Postgres refusing a connection for a second — wedged every
// later tool call in an `x mcp serve` session with the first error, forever.

import { describe, expect, test } from 'bun:test';
import { dbUnavailable } from '@ultimat3/db';
import { retryMemo } from './retry-memo';

describe('unit · retryMemo', () => {
  test('a rejected attempt is not cached — the next caller retries', async () => {
    let attempts = 0;
    const memo = retryMemo(async () => {
      attempts += 1;
      if (attempts === 1) throw dbUnavailable('the connection was refused this once');
      return 'booted';
    });

    await expect(memo.get()).rejects.toBeUltimateError('X_DB_UNAVAILABLE');
    expect(await memo.get()).toBe('booted');
    expect(attempts).toBe(2);
  });

  test('the memo is cleared before the rejection reaches the caller awaiting it', async () => {
    // The ordering is what makes the retry real rather than racy: the clearing handler is attached
    // at creation, so it runs ahead of every caller's own continuation. A memo cleared afterwards
    // leaves the window in which a second call still gets the dead promise.
    const memo = retryMemo(() => Promise.reject(dbUnavailable('refused')));

    await expect(memo.get()).rejects.toBeUltimateError('X_DB_UNAVAILABLE');
    expect(memo.started()).toBeUndefined();
  });

  test('a successful attempt is made once, however many callers ask', async () => {
    // The reason a memo exists at all: `routes.list` must not pay a PGlite boot, and two tools
    // called back to back must not build two instances over one data directory.
    let attempts = 0;
    const memo = retryMemo(async () => {
      attempts += 1;
      return attempts;
    });

    expect(await memo.get()).toBe(1);
    expect(await memo.get()).toBe(1);
    expect(attempts).toBe(1);
  });

  test('one attempt in flight is shared, never started twice concurrently', async () => {
    let attempts = 0;
    const memo = retryMemo(async () => {
      attempts += 1;
      await Promise.resolve();
      return attempts;
    });

    const [first, second] = await Promise.all([memo.get(), memo.get()]);

    expect(first).toBe(1);
    expect(second).toBe(1);
    expect(attempts).toBe(1);
  });

  test('started() answers nothing until someone asks, which is what makes close() safe', async () => {
    // `LazyServices.close()` must not BOOT a database in order to stop one, and a host closed
    // before any tool ran is the ordinary `x mcp serve` session that answered only `routes.list`.
    let attempts = 0;
    const memo = retryMemo(async () => {
      attempts += 1;
      return 'booted';
    });

    expect(memo.started()).toBeUndefined();
    const pending = memo.get();
    expect(memo.started()).toBe(pending);
    expect(await pending).toBe('booted');
    expect(attempts).toBe(1);
  });
});
