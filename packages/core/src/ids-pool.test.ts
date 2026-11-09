// The random pool behind every id: one `crypto.getRandomValues` fill per `RANDOM_POOL_BYTES`, each
// byte handed out once (consecutive ids ARE the fill, in order), and ids that stay unique.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { nanoid, RANDOM_POOL_BYTES, randomHex, resetRandomPool, spanId, traceId } from './ids';

afterEach(() => resetRandomPool());

/** Every fill the pool asks for, kept so a test can read back the bytes it was given. */
function recordFills() {
  const fills: Uint8Array[] = [];
  const real = crypto.getRandomValues.bind(crypto);
  const spy = spyOn(crypto, 'getRandomValues').mockImplementation(((array: Uint8Array) => {
    const filled = real(array);
    fills.push(filled);
    return filled;
  }) as typeof crypto.getRandomValues);
  return { fills, restore: () => spy.mockRestore() };
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

describe('unit · the id random pool', () => {
  test('one fill serves a pool of trace ids; the next id past it refills', () => {
    resetRandomPool();
    const { fills, restore } = recordFills();
    try {
      const perPool = RANDOM_POOL_BYTES / 16;
      for (let index = 0; index < perPool; index += 1) traceId();
      expect(fills).toHaveLength(1);
      traceId();
      expect(fills).toHaveLength(2);
    } finally {
      restore();
    }
  });

  test('no byte is reused: consecutive ids spell the fill, in order, once', () => {
    resetRandomPool();
    const { fills, restore } = recordFills();
    const ids: string[] = [];
    try {
      for (let index = 0; index < RANDOM_POOL_BYTES / 8; index += 1) ids.push(spanId());
    } finally {
      restore();
    }
    expect(fills).toHaveLength(1);
    expect(ids.join('')).toBe(hex(fills[0] ?? new Uint8Array()));
  });

  test('a request that does not fit the tail refills rather than wrapping', () => {
    resetRandomPool();
    const { fills, restore } = recordFills();
    try {
      randomHex(RANDOM_POOL_BYTES / 4 - 1);
      randomHex(RANDOM_POOL_BYTES / 4 - 1);
      randomHex(RANDOM_POOL_BYTES / 4 - 1);
      randomHex(RANDOM_POOL_BYTES / 4 - 1);
      expect(fills).toHaveLength(1);
      const tail = randomHex(8);
      expect(fills).toHaveLength(2);
      expect(tail).toBe(hex(fills[1]?.subarray(0, 8) ?? new Uint8Array()));
    } finally {
      restore();
    }
  });

  test('a request too big to pool is drawn on its own and leaves the pool alone', () => {
    resetRandomPool();
    traceId();
    const { fills, restore } = recordFills();
    try {
      expect(nanoid(RANDOM_POOL_BYTES)).toHaveLength(RANDOM_POOL_BYTES);
      traceId();
      expect(fills.map((fill) => fill.length)).toEqual([RANDOM_POOL_BYTES]);
    } finally {
      restore();
    }
  });

  test('ids stay unique and well-formed across many refills', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 20_000; index += 1) seen.add(traceId());
    expect(seen.size).toBe(20_000);
    for (const id of seen) expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});
