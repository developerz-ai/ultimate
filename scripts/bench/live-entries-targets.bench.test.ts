// The targets bench as a regression test, by COUNT and never by time: picking a change's windows
// must not walk the node's whole entry table. A walk is what cost ~1.2 ms a change at 50k entries,
// with no stale window among them.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { benchTargets, targetsRig } from './live-entries-targets.bench';

let walks: ReturnType<typeof spyOn<Map<unknown, unknown>, 'values'>> | null = null;
afterEach(() => {
  walks?.mockRestore();
  walks = null;
});

describe('live-entries targets bench', () => {
  test('a change walks no Map of entries, however many the node holds', () => {
    const { entries } = targetsRig(5_000, 4);
    // Spied after the rig: building it is not the question.
    walks = spyOn(Map.prototype, 'values');
    const picked = entries.targets('comments');
    expect(walks).toHaveBeenCalledTimes(0);
    // The owing windows and nothing else: none of the 5,000 reads `comments`.
    expect(picked).toHaveLength(4);
    expect(picked.every((entry) => entry.stale)).toBe(true);
  });

  test('the script reports what it ran', () => {
    const result = benchTargets(10, 20, 2);
    expect(result).toMatchObject({ entries: 10, changes: 20, stale: 2, windowsPerChange: 2 });
    expect(result.targetsPerSecond).toBeGreaterThan(0);
  });
});
