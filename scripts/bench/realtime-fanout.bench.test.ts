// The fan-out bench as a regression test, by COUNT and never by time — a loaded gate runner makes any
// timing claim flaky. A change on a table no window reads enters no window's lane, however many
// windows the node holds; entering every lane is what cost 34.6 ms a change at 10k.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { WindowLock } from '../../packages/realtime/src/window-lock';
import { benchFanout, deliverUnrelated, fanoutRig } from './realtime-fanout.bench';

let lanes: ReturnType<typeof spyOn<WindowLock, 'run'>> | null = null;
afterEach(() => {
  lanes?.mockRestore();
  lanes = null;
});

describe('realtime fan-out bench', () => {
  test('an unrelated change does not cost a lane per window', async () => {
    const registry = await fanoutRig(2_000);
    // Spied after the rig: every subscribe takes its window's lane, and that is not the question.
    lanes = spyOn(WindowLock.prototype, 'run');
    await deliverUnrelated(registry, 50);
    expect(lanes).toHaveBeenCalledTimes(0);
  });

  test('the script reports what it ran', async () => {
    const result = await benchFanout(10, 20);
    expect(result).toMatchObject({ windows: 10, changes: 20 });
    expect(result.changesPerSecond).toBeGreaterThan(0);
  });
});
