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
