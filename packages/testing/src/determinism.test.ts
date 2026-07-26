import { describe, expect, test } from 'bun:test';
import {
  advanceClock,
  assertDeterministic,
  frozenClock,
  frozenNow,
  installDeterminism,
  seededRandom,
  seededUuid,
  setFrozenClock,
} from './determinism';

// Self-sufficient: the preload installs this globally, but a single test file must be runnable on
// its own with `bun test src/determinism.test.ts`.
installDeterminism();

describe('unit · determinism', () => {
  test('the clock is frozen: two reads of now() are identical', () => {
    setFrozenClock('2026-01-01T00:00:00.000Z');
    const first = Date.now();
    const second = Date.now();
    expect(first).toBe(second);
    expect(new Date().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('time only moves when a test advances it', () => {
    setFrozenClock('2026-01-01T00:00:00.000Z');
    advanceClock(3 * 24 * 60 * 60 * 1000);
    expect(frozenNow().toISOString()).toBe('2026-01-04T00:00:00.000Z');
  });

  test('frozenClock scopes the clock to one body and restores it', async () => {
    setFrozenClock('2026-01-01T00:00:00.000Z');
    const inside = await frozenClock('2030-06-01T12:00:00.000Z', () => new Date().toISOString());
    expect(inside).toBe('2030-06-01T12:00:00.000Z');
    expect(new Date().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('an explicit Date argument still constructs the date it was given', () => {
    expect(new Date('1999-12-31T00:00:00.000Z').getUTCFullYear()).toBe(1999);
    expect(new Date(0).getTime()).toBe(0);
  });

  test('the seeded RNG produces the same sequence for the same seed', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const c = seededRandom(43);
    const first = [a(), a(), a()];
    expect(first).toEqual([b(), b(), b()]);
    expect(first[0]).not.toBe(c());
    for (const value of first) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  test('seeded uuids are stable and well-formed', () => {
    const uuid = seededUuid(7);
    const value = uuid();
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(seededUuid(7)()).toBe(value);
  });

  test('assertDeterministic fails a body that changes between runs', async () => {
    let counter = 0;
    expect(await assertDeterministic('stable', () => 'same')).toBe('same');
    try {
      await assertDeterministic('counter', () => {
        counter += 1;
        return counter;
      });
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeUltimateError('X_TEST_NONDETERMINISTIC');
      expect((error as { fix: string }).fix).toContain('frozenClock');
    }
  });
});
