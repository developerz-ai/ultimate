// The request fingerprint an idempotency record persists: keyed, so the table is no oracle for a
// low-entropy input; and read across an upgrade or a secret rotation without a false 409 and
// without ever running the handler twice.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  configureCursorSigning,
  fingerprint,
  isUltimateError,
  resetCursorSigning,
} from '@ultimat3/core';
import { withIdempotency } from './idempotency';
import { MemoryIdempotencyStore } from './idempotency-memory';

const INPUT = { accountNumber: '0123456789', holderId: '1020304050' };
const OTHER = { ...INPUT, accountNumber: '9876543210' };

afterEach(() => resetCursorSigning());

function counter(): { readonly run: () => Promise<{ n: number }>; readonly runs: () => number } {
  let runs = 0;
  return {
    run: () => {
      runs += 1;
      return Promise.resolve({ n: runs });
    },
    runs: () => runs,
  };
}

/** A record written by an earlier build: `requestHash` as given, settled with `{ n: 1 }`. */
async function seeded(requestHash: string): Promise<MemoryIdempotencyStore> {
  const store = new MemoryIdempotencyStore();
  const { record } = await store.reserve('k', requestHash);
  await store.settle('k', { n: 1 }, record.id, false);
  return store;
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not-ultimate';
  }
  return undefined;
}

describe('the persisted request fingerprint', () => {
  test('is keyed: the stored value is not the bare SHA-256 of the input', async () => {
    configureCursorSigning('app-secret');
    const store = new MemoryIdempotencyStore();
    await withIdempotency(store, 'k', INPUT, counter().run);
    const stored = (await store.get('k'))?.requestHash ?? '';
    expect(stored.startsWith('h1:')).toBe(true);
    expect(stored).not.toContain(fingerprint(INPUT));
  });

  test('same key, same body replays without re-running', async () => {
    configureCursorSigning('app-secret');
    const store = new MemoryIdempotencyStore();
    const { run, runs } = counter();
    await withIdempotency(store, 'k', INPUT, run);
    const second = await withIdempotency(store, 'k', INPUT, run);
    expect(second).toEqual({ value: { n: 1 }, replayed: true });
    expect(runs()).toBe(1);
  });

  test('same key, different body is X_IDEMPOTENCY_CONFLICT', async () => {
    configureCursorSigning('app-secret');
    const store = new MemoryIdempotencyStore();
    const { run, runs } = counter();
    await withIdempotency(store, 'k', INPUT, run);
    expect(await codeOf(withIdempotency(store, 'k', OTHER, run))).toBe('X_IDEMPOTENCY_CONFLICT');
    expect(runs()).toBe(1);
  });
});

describe('a record written before keying (legacy unkeyed fingerprint)', () => {
  test('the same body still replays', async () => {
    const store = await seeded(fingerprint(INPUT));
    const { run, runs } = counter();
    expect(await withIdempotency(store, 'k', INPUT, run)).toEqual({
      value: { n: 1 },
      replayed: true,
    });
    expect(runs()).toBe(0);
  });

  test('a different body is still a conflict', async () => {
    const store = await seeded(fingerprint(INPUT));
    const { run, runs } = counter();
    expect(await codeOf(withIdempotency(store, 'k', OTHER, run))).toBe('X_IDEMPOTENCY_CONFLICT');
    expect(runs()).toBe(0);
  });
});

describe('a record keyed under a secret this process does not hold', () => {
  test('replays on its status: no false conflict, and no second run', async () => {
    configureCursorSigning('old-secret');
    const first = new MemoryIdempotencyStore();
    await withIdempotency(first, 'k', INPUT, counter().run);
    const stored = (await first.get('k'))?.requestHash ?? '';

    configureCursorSigning('new-secret');
    const store = await seeded(stored);
    const { run, runs } = counter();
    expect(await withIdempotency(store, 'k', OTHER, run)).toEqual({
      value: { n: 1 },
      replayed: true,
    });
    expect(runs()).toBe(0);
  });
});
