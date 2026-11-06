// The probe's bound and the sampler's defaults: a server that never answers is `null` within the
// bound rather than a hang, and a sampler built with no clock or sleep of its own still samples on
// the wall clock, each sample timed from its `zero`.

import { describe, expect, test } from 'bun:test';
import { probeStatus, sampleStatus } from './drill-probe';

describe('probeStatus', () => {
  test('a server that accepts and never answers is null once the bound passes', async () => {
    const parked = Promise.withResolvers<Response>();
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => parked.promise });
    try {
      const started = performance.now();
      expect(await probeStatus(`http://127.0.0.1:${String(server.port)}/readyz`, 50)).toBeNull();
      expect(performance.now() - started).toBeLessThan(5_000);
    } finally {
      parked.resolve(new Response(null, { status: 200 }));
      server.stop(true);
    }
  });
});

describe('sampleStatus', () => {
  test('with no clock or sleep given, samples on the wall clock from zero', async () => {
    const answers = [503, 200];
    let probes = 0;
    const zero = performance.now();
    const sampler = sampleStatus({
      url: 'http://unused',
      everyMs: 1,
      boundMs: 1,
      zero,
      probe: async () => {
        probes += 1;
        return answers[Math.min(probes, answers.length) - 1] ?? null;
      },
    });
    while (probes < 3) await Bun.sleep(1);
    const samples = await sampler.stop();
    expect(samples.length).toBeGreaterThanOrEqual(3);
    expect(samples.slice(0, 3).map((sample) => sample.status)).toEqual([503, 200, 200]);
    for (const sample of samples) {
      expect(sample.atMs).toBeGreaterThanOrEqual(0);
      expect(sample.atMs).toBeLessThan(60_000);
    }
  });
});
