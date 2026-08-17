// Single responsibility: tests for the read path's one guarantee — a key is read once per
// request. WHERE it fills is `read-tier.test.ts`; what is proved here is how many
// times the read path reaches for the ladder. Three questions about a fill that are NOT this file's:
// who an entry may be served to (`cache-authority.test.ts`), whether it may be written at all
// (`cache-fence.test.ts`), and what happens when the tier refuses (`cache-degraded.test.ts`).
// Concurrency is the half that used to be missing: the memo holds the read *in flight*,
// not its value, or two readers arriving in the same tick both miss and both execute. The same
// shape is what lets a legitimately `undefined` result memoize, and the failure case is here
// because a promise-keyed memo can hold a rejection forever if nobody evicts it.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { CacheSetOptions, CacheTag, CacheTier } from '@ultimat3/cache';
import { isolateTiers, registerTier, resetTiers } from '@ultimat3/cache';
import { createContext, frozenClock } from '@ultimat3/core';
import { readFresh, readOnce, readThrough, requestMemo } from './cache';

interface Written {
  readonly value: unknown;
  readonly ttlMs: number | undefined;
  readonly tags: readonly CacheTag[];
}

/**
 * Counts the tier round trips a read costs, so "one round trip" is a number, not a claim.
 *
 * It records the RELATIVE `ttlMs` it was handed, because that is now the whole of what the read
 * path decides: the absolute expiry is the tier's, computed with the tier's own clock. The read
 * path computing one itself is the `Date.now()` bug this migration deleted.
 */
function countingTier(): CacheTier & {
  gets: number;
  sets: number;
  readonly writes: Written[];
} {
  const entries = new Map<string, { value: unknown; tags: readonly CacheTag[] }>();
  return {
    name: 'lru',
    gets: 0,
    sets: 0,
    writes: [],
    async get<T>(key: string) {
      this.gets += 1;
      const held = entries.get(key);
      return held === undefined ? undefined : { value: held.value as T, tags: held.tags };
    },
    async set<T>(key: string, value: T, options?: CacheSetOptions) {
      this.sets += 1;
      this.writes.push({ value, ttlMs: options?.ttlMs, tags: options?.tags ?? [] });
      entries.set(key, { value, tags: options?.tags ?? [] });
    },
    async del(key: string) {
      entries.delete(key);
    },
    async invalidateTags() {
      const keys = [...entries.keys()];
      entries.clear();
      return { tier: 'lru' as const, keys };
    },
  };
}

/** A source that hangs until released, so a second reader is provably concurrent with the first. */
function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

let restore: (() => void) | undefined;
let tier = countingTier();

beforeEach(() => {
  restore?.();
  restore = isolateTiers();
  resetTiers();
  tier = countingTier();
  registerTier(tier);
});

afterAll(() => {
  restore?.();
  restore = undefined;
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
    await tier.set('k', 'cached');
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

  // A RELATIVE lease, and never an absolute expiry: the tier's own clock turns it into one.
  // A `null` ttl is "the caller named none" and reaches the tier as an omission, which is how a
  // tier is asked for its own default — it is not, and has never been, "never expires".
  test('hands the tier a relative lease, or none at all', async () => {
    const run = async (): Promise<string> => 'rows';

    await readThrough(createContext({}), 'ttl', 60_000, run);
    await readThrough(createContext({}), 'forever', null, run);

    const [ttl, forever] = tier.writes;
    expect(ttl).toEqual({ value: 'rows', ttlMs: 60_000, tags: [] });
    expect(forever).toEqual({ value: 'rows', ttlMs: undefined, tags: [] });
    expect(tier.writes).toHaveLength(2);
  });

  // The read path reads no clock at all now. `read-tier.test.ts` is where a frozen clock is
  // driven end to end through a real tier; this only pins that nothing here re-derives one.
  test('reads no clock of its own, so an injected one cannot be bypassed', async () => {
    const ctx = createContext({ clock: frozenClock(1_000) });

    await readThrough(ctx, 'k', 60_000, async () => 'rows');

    expect(tier.writes[0]).toEqual({ value: 'rows', ttlMs: 60_000, tags: [] });
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
