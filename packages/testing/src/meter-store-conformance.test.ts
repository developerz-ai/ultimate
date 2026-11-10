// The meter-store suite over `@ultimat3/action`'s `memoryMeterStore()`, and the proof it can fail: a
// draw that reads, awaits, then writes — the overshoot the atomic draw exists to close.

import { describe, expect, test } from 'bun:test';
import { memoryMeterStore } from '@ultimat3/action';
import type { MeterDrawResult, MeterStore } from '@ultimat3/action/adapter';
import { METER_STORE_CHECKS, meterStoreConformance } from './meter-store-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

describe(testName('unit', 'the memory meter store'), () => {
  behavesLike(meterStoreConformance, () => memoryMeterStore());
});

/** Correct alone: one draw at a time sees the count it adds to. In parallel, every one sees zero. */
const readThenWrite = (): MeterStore => {
  const counts = new Map<string, number>();
  const inner = memoryMeterStore();
  return {
    scope: 'process',
    claimWarning: (key, start) => inner.claimWarning(key, start),
    releaseWarning: (key, start) => inner.releaseWarning(key, start),
    async draw(request): Promise<MeterDrawResult> {
      const id = JSON.stringify([request.subject, request.meter, request.period]);
      const used = counts.get(id) ?? 0;
      await Promise.resolve();
      if (used + 1 > request.limit) return { allowed: false, used, warned: false };
      counts.set(id, used + 1);
      return { allowed: true, used: used + 1, warned: false };
    },
  };
};

const check = (name: string) => {
  const found = METER_STORE_CHECKS.find((each) => each.name.includes(name));
  if (found === undefined) return expect.unreachable(`no conformance check named ${name}`);
  return found;
};

describe(testName('unit', 'a meter store that is not atomic fails conformance'), () => {
  test('read-await-write counts sequentially and overshoots the race', async () => {
    await check('counts up to the limit').run(readThenWrite());
    await expect(check('parallel draws at the edge').run(readThenWrite())).rejects.toThrow();
  });

  test('every check has a name of its own', () => {
    const names = METER_STORE_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
