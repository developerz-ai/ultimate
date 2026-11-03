// What a joiner costs the fence, counted over a real one, and that the bookkeeping leaves nothing
// behind. Through the stack: `tiers-read-after-bust.test.ts`.

import { describe, expect, test } from 'bun:test';
import { singleFlight } from '@ultimat3/core';
import type { CacheFence } from './fence';
import { markInvalidated, sampleFence } from './fence';
import { tag } from './tags';
import { leadingLoads } from './tier-leading';

const counted = (fence: CacheFence) => {
  const counts = { isValid: 0, covers: [] as number[] };
  const wrapped: CacheFence = {
    isValid: () => {
      counts.isValid += 1;
      return fence.isValid();
    },
    cover: (scope) => {
      counts.covers.push(scope.tags?.length ?? 0);
      fence.cover(scope);
    },
  };
  return { counts, wrapped };
};

describe('leadingLoads', () => {
  test('repeat tagged joiners ask once and cover nothing', () => {
    const loads = leadingLoads();
    const { counts, wrapped } = counted(sampleFence({ key: 'leading:a' }));
    loads.lead('leading:a', wrapped, [tag('leadinga')]);
    for (let reader = 0; reader < 2_000; reader += 1) {
      expect(loads.overtaken('leading:a', [tag('leadinga')])).toBe(false);
    }
    expect(counts.isValid).toBe(0);
    expect(counts.covers).toEqual([]);
  });

  test('a new tag is covered once, even from many joiners', () => {
    const loads = leadingLoads();
    const { counts, wrapped } = counted(sampleFence({ key: 'leading:b' }));
    loads.lead('leading:b', wrapped, undefined);
    for (let reader = 0; reader < 100; reader += 1) {
      expect(loads.overtaken('leading:b', [tag('leadingb')])).toBe(false);
    }
    expect(counts.covers).toEqual([1]);
    expect(counts.isValid).toBe(1);
  });

  test('one fence walk per move of the generation, not per joiner', () => {
    const loads = leadingLoads();
    const { counts, wrapped } = counted(sampleFence({ key: 'leading:c' }));
    loads.lead('leading:c', wrapped, undefined);
    markInvalidated({ key: 'leading:unrelated' });
    for (let reader = 0; reader < 100; reader += 1) loads.overtaken('leading:c', undefined);
    expect(counts.isValid).toBe(1);
  });

  test('a mark it covers is seen, and a tag it only just heard of reaches back to the sample', () => {
    const byKey = leadingLoads();
    byKey.lead('leading:d', sampleFence({ key: 'leading:d' }), undefined);
    markInvalidated({ key: 'leading:d' });
    expect(byKey.overtaken('leading:d', undefined)).toBe(true);

    const byTag = leadingLoads();
    byTag.lead('leading:e', sampleFence({ key: 'leading:e' }), undefined);
    expect(byTag.overtaken('leading:e', undefined)).toBe(false);
    markInvalidated({ tags: [tag('leadinge')] });
    expect(byTag.overtaken('leading:e', undefined)).toBe(false);
    expect(byTag.overtaken('leading:e', [tag('leadinge')])).toBe(true);
  });

  test('a load wedged past its deadline leaves no entry: the size follows the flight', async () => {
    const loads = leadingLoads();
    const timers: (() => void)[] = [];
    const flight = singleFlight({
      deadlineMs: 1,
      schedule: (fn) => {
        timers.push(fn);
        return () => undefined;
      },
      released: (key) => {
        loads.release(key);
      },
    });
    for (let wedged = 0; wedged < 50; wedged += 1) {
      const key = `leading:wedged:${wedged}`;
      void flight.run(key, () => {
        loads.lead(key, sampleFence({ key }), undefined);
        return new Promise<string>(() => undefined);
      });
    }
    expect(loads.size).toBe(50);
    for (const fire of timers) fire();
    expect(loads.size).toBe(0);
    expect(flight.size).toBe(0);
  });
});
