import { describe, expect, test } from 'bun:test';
import { frozenClock } from './clock';
import {
  isUuid,
  nanoid,
  parseId,
  resetIdCounter,
  spanId,
  traceId,
  typedId,
  uuid,
  uuidTimestamp,
} from './ids';

describe('uuid v7', () => {
  test('is version 7, RFC-variant and well formed', () => {
    const id = uuid();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
    expect(id).toHaveLength(36);
  });

  test('is strictly monotonic under a frozen clock (same millisecond)', () => {
    resetIdCounter();
    const clock = frozenClock('2026-07-26T10:00:00.000Z');
    const ids = Array.from({ length: 5000 }, () => uuid(clock));

    for (let index = 1; index < ids.length; index += 1) {
      const previous = ids[index - 1] as string;
      const current = ids[index] as string;
      expect(current > previous).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('is monotonic across real time and never goes backwards on clock skew', () => {
    resetIdCounter();
    const forwards = uuid();
    const skewed = frozenClock('2000-01-01T00:00:00.000Z');
    const afterSkew = uuid(skewed);
    expect(afterSkew > forwards).toBe(true);
  });

  test('embeds the generation timestamp', () => {
    resetIdCounter();
    const at = new Date('2026-07-26T10:00:00.000Z');
    const id = uuid(frozenClock(at));
    expect(uuidTimestamp(id).getTime()).toBe(at.getTime());
    expect(() => uuidTimestamp('not-a-uuid')).toThrow(/X_ID_INVALID/);
  });
});

describe('branded ids', () => {
  test('typedId produces a uuid and parseId rejects junk', () => {
    const id = typedId<'post'>();
    expect(isUuid(id)).toBe(true);
    expect(parseId('post', id)).toBe(id);
    expect(() => parseId('post', 'abc')).toThrow(/X_ID_INVALID/);
  });

  // The refusal is the whole product of this function, and it may not be lost to its own
  // formatting: a caller that catches a TypeError instead of X_ID_INVALID matches nothing on
  // `error.code`, and an HTTP surface answers 500 where a 400 belonged. Every value here is one
  // an app can hand `parseId` — the id came off a job payload, a test fixture or a cache key.
  const hostile = new Map<string, unknown>([
    ['a bigint', 10n],
    ['a symbol', Symbol('post')],
    [
      'a hostile toJSON',
      {
        toJSON: () => {
          throw new Error('gotcha');
        },
      },
    ],
    [
      'a throwing getter',
      Object.defineProperty({}, 'id', {
        enumerable: true,
        get: () => {
          throw new Error('gotcha');
        },
      }),
    ],
  ]);

  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  hostile.set('a cycle', cyclic);

  for (const [label, value] of hostile) {
    test(`parseId refuses ${label} with X_ID_INVALID, not a formatting throw`, () => {
      expect(() => parseId('post', value)).toThrow(/X_ID_INVALID/);
    });
  }
});

describe('nanoid and trace ids', () => {
  test('nanoid is url-safe and the requested length', () => {
    expect(nanoid()).toHaveLength(21);
    // 1000 draws: catches an alphabet that is not exactly 64 chars wide.
    for (let index = 0; index < 1000; index += 1) {
      expect(nanoid(8)).toMatch(/^[A-Za-z0-9_-]{8}$/);
    }
  });

  test('trace and span ids are w3c sized hex', () => {
    expect(traceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(spanId()).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('the monotonic counter seed', () => {
  test('spans the full 10 bits COUNTER_SEED_MASK declares', () => {
    // `randomBytes(2)[0] & 0x3ff` allocated two bytes and read one, so the seed could only reach
    // 255 while the mask declared 1023 — the constant and the code disagreed and the second byte
    // was dead weight on every uuid(). rand_a is the `7xxx` group: strip the version nibble.
    const seeds = new Set<number>();
    for (let index = 0; index < 4000; index += 1) {
      resetIdCounter();
      const randA = Number.parseInt(uuid().split('-')[2]?.slice(1) ?? '0', 16);
      seeds.add(randA);
    }
    expect(Math.max(...seeds)).toBeGreaterThan(0x0ff);
    expect(Math.max(...seeds)).toBeLessThanOrEqual(0x3ff);
  });
});
