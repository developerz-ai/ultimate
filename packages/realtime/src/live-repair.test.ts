// The node's sweep is bounded: a bus reconnect reaches every node at once, and each re-reads every
// window it holds — `REPAIR_WIDTH` at a time, never all of them against the pool together.

import { describe, expect, test } from 'bun:test';
import type { LiveEntries } from './live-entries';
import type { FanoutDeps } from './live-fanout';
import { REPAIR_WIDTH, repairEveryWindow } from './live-repair';

/** Entries whose lane only counts how many run at once: the repair inside it is not under test. */
const countingEntries = (count: number) => {
  let active = 0;
  let widest = 0;
  const entry = {
    lock: {
      run: async () => {
        active += 1;
        widest = Math.max(widest, active);
        await Promise.resolve();
        await Promise.resolve();
        active -= 1;
        return 1;
      },
    },
  };
  const entries = { values: () => Array.from({ length: count }, () => entry).values() };
  return { entries: entries as unknown as LiveEntries, widest: () => widest };
};

describe('unit · repairEveryWindow', () => {
  test('re-reads at most REPAIR_WIDTH windows at once, and every one of them', async () => {
    const { entries, widest } = countingEntries(REPAIR_WIDTH * 4);
    const sent = await repairEveryWindow({} as unknown as FanoutDeps, entries);
    expect(sent).toBe(REPAIR_WIDTH * 4);
    expect(widest()).toBe(REPAIR_WIDTH);
  });
});
