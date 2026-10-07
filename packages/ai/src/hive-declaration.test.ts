// `hive()`'s declaration screens: a width or a money ceiling that is not a whole number is refused
// under the key the app wrote, and an honest one still fans out. The fan-out itself is `hive.test.ts`.

import { beforeEach, describe, expect, test } from 'bun:test';
import { resetActions } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { asyncRefusal, NOT_A_BOUND } from './bounds-fixture';
import { hive } from './hive';
import { ctxAs, worker } from './hive-fixture';
import { useFixtureModels } from './model-fixture';
import { resetAiRuntime } from './runtime';

useFixtureModels();

beforeEach(() => {
  resetAiRuntime();
  resetActions();
});

describe('hive() refuses a width that is not a number', () => {
  const fanOut = (extra: { concurrency?: number; minMembers?: number }, name: string) =>
    hive({
      input: t.object({}),
      member: worker([]),
      split: () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      onMemberError: 'collect',
      policy: allow(),
      ...extra,
    }).named(name);

  test('concurrency and minMembers are each refused under their own name', async () => {
    let index = 0;
    for (const value of NOT_A_BOUND) {
      index += 1;
      const byWidth = await asyncRefusal(() =>
        fanOut({ concurrency: value }, `widthHive${String(index)}`)({}, { ctx: ctxAs('u-1') }),
      );
      expect(byWidth.code).toBe('X_INVARIANT');
      expect(byWidth.cause).toContain('concurrency');
      expect(byWidth.fix).toContain('hive');
      const byFloor = await asyncRefusal(() =>
        fanOut({ minMembers: value }, `floorHive${String(index)}`)({}, { ctx: ctxAs('u-1') }),
      );
      expect(byFloor.cause).toContain('minMembers');
    }
  });

  test('a declared zero keeps meaning what it meant, which is one worker', async () => {
    // `Math.max(1, Math.min(0, n))` has always read `concurrency: 0` as "run it serially", so the
    // floor here is 0 and not 1: refusing a zero would be a new rule rather than this repair.
    const serial = fanOut({ concurrency: 0 }, 'serialHive');
    const result = await serial({}, { ctx: ctxAs('u-2') });
    expect(result.ok).toBe(3);
    expect(result.members.map((one) => one.index)).toEqual([0, 1, 2]);
  });

  test('an honest width still fans out — the non-vacuity half', async () => {
    const result = await fanOut({ concurrency: 2 }, 'honestHive')({}, { ctx: ctxAs('u-3') });
    expect(result.ok).toBe(3);
    expect(result.failed + result.skipped).toBe(0);
  });
});

// Unscreened, a `NaN` money ceiling won `derive`'s `tighterMoney` and capped no member's call.
describe('hive() screens its money ceiling where the app writes it', () => {
  test('a costPerCall.minor that is not a whole count is refused under the declared key', async () => {
    let index = 0;
    for (const minor of [...NOT_A_BOUND, -1]) {
      index += 1;
      const costly = hive({
        input: t.object({}),
        member: worker([]),
        split: () => [{ id: 'a' }],
        onMemberError: 'collect',
        policy: allow(),
        budget: { costPerCall: { minor, currency: 'USD' } },
      }).named(`costHive${String(index)}`);
      const error = await asyncRefusal(() => costly({}, { ctx: ctxAs('u-4') }));
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('budget.costPerCall.minor');
    }
  });
});
