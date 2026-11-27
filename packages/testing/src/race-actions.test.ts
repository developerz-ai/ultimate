// `raceActions` and `expectPartial` with no database: calls that reject the way a driver does.

import { describe, expect, test } from 'bun:test';
import { expectPartial, raceActions } from './race-actions';
import { testName } from './test-types';

const driverError = (state: string): Error & { code: string } =>
  Object.assign(new Error('driver'), { code: state });

describe(testName('unit', 'raceActions'), () => {
  test('runs every call in every round, concurrently', async () => {
    let live = 0;
    let peak = 0;
    const call = async (): Promise<number> => {
      live += 1;
      peak = Math.max(peak, live);
      await Bun.sleep(0); // a turn, not a wait: every call has started before any finishes
      live -= 1;
      return 1;
    };
    const report = await raceActions([call, call, call], { rounds: 4 });
    expect(peak).toBe(3);
    expect(report.settled).toHaveLength(4);
    expect(report.serializationFailures).toEqual([]);
  });

  test('lists a deadlock and a serialization failure, and not a unique violation', async () => {
    const report = await raceActions(
      [
        () => Promise.reject(driverError('40P01')),
        () => Promise.reject(driverError('40001')),
        () => Promise.reject(driverError('23505')),
        () => Promise.resolve('ok'),
      ],
      { rounds: 2 },
    );
    expect(report.serializationFailures.map((f) => [f.round, f.call, f.sqlState, f.code])).toEqual([
      [0, 0, '40P01', 'X_DB_SERIALIZATION_FAILURE'],
      [0, 1, '40001', 'X_DB_SERIALIZATION_FAILURE'],
      [1, 0, '40P01', 'X_DB_SERIALIZATION_FAILURE'],
      [1, 1, '40001', 'X_DB_SERIALIZATION_FAILURE'],
    ]);
    expect(report.settled[0]?.[2]?.status).toBe('rejected');
  });

  test('a round count that is not a positive integer is refused', async () => {
    await expect(raceActions([], { rounds: 0 })).rejects.toMatchObject({ code: 'X_INVARIANT' });
  });
});

describe(testName('unit', 'expectPartial'), () => {
  const answer = {
    allowed: [{ id: 1 }],
    denied: [{ row: { id: 2 }, code: 'X_POLICY_DENIED', reason: 'not yours' }],
  };
  test('passes the exact split', () => {
    expectPartial(answer, {
      allowed: [{ id: 1 }],
      denied: [{ row: { id: 2 }, code: 'X_POLICY_DENIED', reason: 'not yours' }],
    });
  });
  test('fails on a row that moved sides, and on a wrong code', () => {
    expect(() => expectPartial(answer, { allowed: [{ id: 1 }, { id: 2 }], denied: [] })).toThrow();
    expect(() =>
      expectPartial(answer, {
        allowed: [{ id: 1 }],
        denied: [{ row: { id: 2 }, code: 'X_OTHER' }],
      }),
    ).toThrow();
  });
});
