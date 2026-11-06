// `startDrillLoad` on its own clock and sleep: each sample is timed on the wall clock, ends no
// earlier than it started, and the lanes keep sending until `stop()`.

import { describe, expect, test } from 'bun:test';
import { startDrillLoad } from './drill-load';

describe('startDrillLoad with the wall clock', () => {
  test('samples are timed by performance.now and keep coming until stop', async () => {
    let sent = 0;
    const started = performance.now();
    const load = startDrillLoad({
      base: 'http://drill.invalid',
      targets: [{ method: 'GET', path: '/' }],
      lanes: 1,
      pauseMs: 1,
      requestBoundMs: 1_000,
      fetch: async () => {
        sent += 1;
        return new Response('ok');
      },
    });
    while (sent < 3) await Bun.sleep(1);
    const samples = await load.stop();
    expect(samples.length).toBeGreaterThanOrEqual(3);
    for (const sample of samples) {
      expect(sample.status).toBe(200);
      expect(sample.startedMs).toBeGreaterThanOrEqual(started);
      expect(sample.endedMs).toBeGreaterThanOrEqual(sample.startedMs);
    }
  });
});
