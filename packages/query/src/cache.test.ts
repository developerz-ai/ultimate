// Single responsibility: tests for the read path's one guarantee — a key is read once per
// request. The tier it fills through is `read-cache.test.ts`; what is proved here is how many
// times the read path reaches for it.
// Concurrency is the half that used to be missing: the memo holds the read *in flight*,
// not its value, or two readers arriving in the same tick both miss and both execute. The same
// shape is what lets a legitimately `undefined` result memoize, and the failure case is here
// because a promise-keyed memo can hold a rejection forever if nobody evicts it.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { CacheTag } from '@ultimat3/cache';
import { createContext } from '@ultimat3/core';
import { readFresh, readOnce, readThrough, requestMemo } from './cache';
import type { ReadCache, ReadCacheEntry } from './read-cache';
import { getReadCache, MemoryReadCache, setReadCache } from './read-cache';

/** Counts the tier round trips a read costs, so "one round trip" is a number, not a claim. */
class CountingCache implements ReadCache {
  gets = 0;
  sets = 0;
  readonly writes: ReadCacheEntry[] = [];
  readonly #entries = new MemoryReadCache();

  async get(key: string): Promise<ReadCacheEntry | undefined> {
    this.gets += 1;
    return await this.#entries.get(key);
  }

  async set(key: string, entry: ReadCacheEntry): Promise<void> {
    this.sets += 1;
    this.writes.push(entry);
    await this.#entries.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    await this.#entries.delete(key);
  }

  async invalidateTags(tags: readonly CacheTag[]): Promise<readonly string[]> {
    return await this.#entries.invalidateTags(tags);
  }
}

/** A source that hangs until released, so a second reader is provably concurrent with the first. */
function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

const original = getReadCache();
let tier = new CountingCache();

beforeEach(() => {
  tier = new CountingCache();
  setReadCache(tier);
});

afterAll(() => {
  setReadCache(original);
});

describe('requestMemo', () => {
  test('is one map per ctx, the same one on every call', () => {
    const a = createContext({});
    const b = createContext({});

    expect(requestMemo(a)).toBe(requestMemo(a));
    expect(requestMemo(a)).not.toBe(requestMemo(b));
  });
});

describe('readOnce', () => {
  test('runs the source once for two reads that race in the same tick, tier untouched', async () => {
    const ctx = createContext({});
    const source = gate();
    let calls = 0;
    const run = async (): Promise<string> => {
      calls += 1;
      await source.wait;
      return 'rows';
    };

    const first = readOnce(ctx, 'k', run);
    const second = readOnce(ctx, 'k', run);
    source.open();

    expect(await first).toBe('rows');
    expect(await second).toBe('rows');
    expect(calls).toBe(1);
    // The memo is the whole of it: a query with no `cache:` block must not reach the tier.
    expect(tier.gets).toBe(0);
    expect(tier.sets).toBe(0);
  });

  test('answers a later read in the same request from the memo', async () => {
    const ctx = createContext({});
    let calls = 0;
    const run = async (): Promise<string> => {
      calls += 1;
      return 'rows';
    };

    expect(await readOnce(ctx, 'k', run)).toBe('rows');
    expect(await readOnce(ctx, 'k', run)).toBe('rows');
    expect(calls).toBe(1);
    expect(tier.gets).toBe(0);
  });

  test('keys the memo by ctx, so another request reads for itself', async () => {
    let calls = 0;
    const run = async (): Promise<string> => {
      calls += 1;
      return 'rows';
    };

    await readOnce(createContext({}), 'k', run);
    await readOnce(createContext({}), 'k', run);
    expect(calls).toBe(2);
  });

  test('keeps two keys apart inside one request', async () => {
    const ctx = createContext({});
    let calls = 0;
    const run = async (): Promise<number> => {
      calls += 1;
      return calls;
    };

    expect(await readOnce(ctx, 'a', run)).toBe(1);
    expect(await readOnce(ctx, 'b', run)).toBe(2);
  });

  test('memoizes a result that is legitimately undefined', async () => {
    const ctx = createContext({});
    let calls = 0;
    const run = async (): Promise<undefined> => {
      calls += 1;
      return undefined;
    };

    expect(await readOnce(ctx, 'k', run)).toBeUndefined();
    expect(await readOnce(ctx, 'k', run)).toBeUndefined();
    expect(calls).toBe(1);
  });

  test('does not memoize a rejection: the next read in the request retries', async () => {
    const ctx = createContext({});
    let calls = 0;
    const run = async (): Promise<string> => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return 'rows';
    };

    await expect(readOnce(ctx, 'k', run)).rejects.toThrow('boom');
    expect(requestMemo(ctx).has('k')).toBe(false);
    expect(await readOnce(ctx, 'k', run)).toBe('rows');
    expect(calls).toBe(2);
  });

  // A `run` that throws before it ever returns a promise leaves nothing to join, so the memo must
  // not be holding a key either — the next read has to start the work over.
  test('memoizes nothing when the read throws synchronously', async () => {
    const ctx = createContext({});
    const run = (): Promise<string> => {
      throw new Error('boom');
    };

    await expect(readOnce(ctx, 'k', run)).rejects.toThrow('boom');
    expect(requestMemo(ctx).has('k')).toBe(false);
  });
});

describe('readThrough', () => {
  test('runs the source once for two reads that race in the same tick', async () => {
    const ctx = createContext({});
    const source = gate();
    let calls = 0;
    const run = async (): Promise<string> => {
      calls += 1;
      await source.wait;
      return 'rows';
    };

    const first = readThrough(ctx, 'k', null, run);
    const second = readThrough(ctx, 'k', null, run);
    source.open();

    expect(await first).toBe('rows');
    expect(await second).toBe('rows');
    expect(calls).toBe(1);
    expect(tier.sets).toBe(1);
  });

  test('asks the tier once however many readers arrive while the read is in flight', async () => {
    const ctx = createContext({});
    const source = gate();
    const run = async (): Promise<string> => {
      await source.wait;
      return 'rows';
    };

    const readers = Array.from({ length: 5 }, () => readThrough(ctx, 'k', null, run));
    source.open();

    expect(await Promise.all(readers)).toEqual(Array.from({ length: 5 }, () => 'rows'));
    expect(tier.gets).toBe(1);
  });

  test('answers a later read in the same request from the memo', async () => {
    const ctx = createContext({});
    let calls = 0;
    const run = async (): Promise<string> => {
      calls += 1;
      return 'rows';
    };

    expect(await readThrough(ctx, 'k', null, run)).toBe('rows');
    expect(await readThrough(ctx, 'k', null, run)).toBe('rows');
    expect(calls).toBe(1);
    expect(tier.gets).toBe(1);
  });

  // A value-keyed memo cannot tell "memoized undefined" from "not memoized", so this read used to
  // fall through to the tier every time. The memo holds the promise, and a promise is never
  // undefined.
  test('memoizes a result that is legitimately undefined', async () => {
    const ctx = createContext({});
    let calls = 0;
    const run = async (): Promise<undefined> => {
      calls += 1;
      return undefined;
    };

    expect(await readThrough(ctx, 'k', null, run)).toBeUndefined();
    expect(await readThrough(ctx, 'k', null, run)).toBeUndefined();
    expect(calls).toBe(1);
    expect(tier.gets).toBe(1);
  });

  test('keys the memo by ctx, so another request reads for itself', async () => {
    const run = async (): Promise<string> => 'rows';

    expect(await readThrough(createContext({}), 'k', null, run)).toBe('rows');
    expect(await readThrough(createContext({}), 'k', null, run)).toBe('rows');
    expect(tier.gets).toBe(2);
  });

  test('keeps two keys apart inside one request', async () => {
    const ctx = createContext({});
    let calls = 0;
    const run = async (): Promise<number> => {
      calls += 1;
      return calls;
    };

    expect(await readThrough(ctx, 'a', null, run)).toBe(1);
    expect(await readThrough(ctx, 'b', null, run)).toBe(2);
    expect(calls).toBe(2);
  });

  test('serves a tier hit without touching the source, and does not write it back', async () => {
    await tier.set('k', { value: 'cached', expiresAt: null });
    const ctx = createContext({});
    let calls = 0;
    const run = async (): Promise<string> => {
      calls += 1;
      return 'fresh';
    };

    expect(await readThrough(ctx, 'k', null, run)).toBe('cached');
    expect(calls).toBe(0);
    expect(tier.sets).toBe(1);
  });

  test('writes the tier with an absolute expiry, or none at all', async () => {
    const run = async (): Promise<string> => 'rows';

    // The clock reads once, before the writes. Recomputing `Date.now()` for the assertion asserts
    // that no millisecond ticked across two awaits, which is the test machine's business.
    const before = Date.now();
    await readThrough(createContext({}), 'ttl', 60_000, run);
    await readThrough(createContext({}), 'forever', null, run);
    const after = Date.now();

    const [ttl, forever] = tier.writes;
    expect(ttl?.value).toBe('rows');
    expect(ttl?.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(ttl?.expiresAt).toBeLessThanOrEqual(after + 60_000);
    expect(forever).toEqual({ value: 'rows', expiresAt: null, tags: [] });
    expect(tier.writes).toHaveLength(2);
  });

  test('fails every reader that joined the read, having run the source once', async () => {
    const ctx = createContext({});
    const source = gate();
    let calls = 0;
    const run = async (): Promise<string> => {
      calls += 1;
      await source.wait;
      throw new Error('boom');
    };

    // Both handlers attach in this tick: a joined read that rejects before anyone is listening
    // is an unhandled rejection, not a passing test.
    const failures = Promise.all([
      readThrough(ctx, 'k', null, run).catch((error: unknown) => String(error)),
      readThrough(ctx, 'k', null, run).catch((error: unknown) => String(error)),
    ]);
    source.open();

    expect(await failures).toEqual(['Error: boom', 'Error: boom']);
    expect(calls).toBe(1);
  });

  test('does not memoize a rejection: the next read in the request retries', async () => {
    const ctx = createContext({});
    let calls = 0;
    const run = async (): Promise<string> => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return 'rows';
    };

    await expect(readThrough(ctx, 'k', null, run)).rejects.toThrow('boom');
    expect(requestMemo(ctx).has('k')).toBe(false);
    expect(await readThrough(ctx, 'k', null, run)).toBe('rows');
    expect(calls).toBe(2);
  });
});

describe('readFresh', () => {
  test('runs even when the memo already holds an answer', async () => {
    const ctx = createContext({});
    let calls = 0;
    const run = async (): Promise<number> => {
      calls += 1;
      return calls;
    };

    expect(await readOnce(ctx, 'k', run)).toBe(1);
    expect(await readFresh(ctx, 'k', run)).toBe(2);
    expect(calls).toBe(2);
  });

  test('replaces the memo, so the next plain read of the key joins it', async () => {
    const ctx = createContext({});
    let calls = 0;
    const run = async (): Promise<number> => {
      calls += 1;
      return calls;
    };

    await readOnce(ctx, 'k', run);
    await readFresh(ctx, 'k', run);

    // Not the stale 1 the first read left behind: the fresh read is the request's newest answer.
    expect(await readOnce(ctx, 'k', run)).toBe(2);
    expect(calls).toBe(2);
  });

  test('leaves the earlier answer standing when it rejects', async () => {
    const ctx = createContext({});
    const run = async (): Promise<string> => 'rows';
    const boom = async (): Promise<string> => {
      throw new Error('boom');
    };

    await readOnce(ctx, 'k', run);
    await expect(readFresh(ctx, 'k', boom)).rejects.toThrow('boom');

    // A failed read is not an answer, so it evicts itself — the next read re-runs the source
    // rather than replaying the failure.
    expect(requestMemo(ctx).has('k')).toBe(false);
    expect(await readOnce(ctx, 'k', run)).toBe('rows');
  });

  test('does not evict a fresh read that replaced it while it was in flight', async () => {
    const ctx = createContext({});
    const source = gate();
    const slow = async (): Promise<string> => {
      await source.wait;
      throw new Error('boom');
    };

    const failing = readOnce(ctx, 'k', slow).catch((error: unknown) => String(error));
    expect(await readFresh(ctx, 'k', async () => 'newer')).toBe('newer');
    source.open();

    expect(await failing).toBe('Error: boom');
    expect(await requestMemo(ctx).get('k')).toBe('newer');
  });
});
