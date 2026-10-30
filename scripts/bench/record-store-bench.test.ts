// The record-store bench as a regression test: the counts it reports are the claims the 29.2.0
// CHANGELOG and docs/history/realtime.md make — a reader told of a record it does not show, a
// throttle that lets a burst through, or a poll that hands out new arrays fails here.

import { describe, expect, test } from 'bun:test';
import { runScenarios, type ScenarioResult } from './record-store-bench';

describe('record-store bench', () => {
  test('notifications and new arrays are what the docs claim', async () => {
    const results = await runScenarios();
    const by = (name: string): ScenarioResult | undefined => results.find((r) => r.name === name);
    expect(by('board')).toMatchObject({ bumps: 200, newArrays: 200, perReader: '200/0' });
    expect(by('run-page')).toMatchObject({ bumps: 80, newArrays: 80, perReader: '20/20/20/20/0' });
    expect(by('board-throttled')).toMatchObject({ bumps: 21, newArrays: 21 });
    expect(by('run-page-big-store')).toMatchObject({ bumps: 800 });
    expect(by('poll')).toMatchObject({ bumps: 100, newArrays: 0 });
  });
});
