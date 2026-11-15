// `/healthz` on the scrape port is the worker's, scheduler's and replicator's LIVENESS: it reads
// their loops' heartbeats, so a wedged loop — event loop alive, claim loop stuck — answers 503,
// where `/metrics` (what the chart probed) kept answering 200 for as long as the process lived.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { drain, resetLifecycle, resetListeners } from '@ultimat3/core';
import { LIVENESS_FLOOR_MS, type LoopHeartbeat, loopHeartbeat } from '@ultimat3/jobs';
import { type MetricsEndpoint, startMetricsEndpoint } from './metrics-endpoint';
import { livenessPayload } from './runtime-liveness';

let endpoint: MetricsEndpoint | undefined;
let at = 0;
let beat: LoopHeartbeat | undefined;

beforeEach(() => {
  resetLifecycle();
  at = 0;
  beat = loopHeartbeat('jobWorker', { tickMs: 250, now: () => at });
  beat.start();
  endpoint = startMetricsEndpoint({ port: 0, role: 'worker' });
});

afterEach(() => {
  beat?.stop();
  endpoint?.stop();
  endpoint = undefined;
  resetListeners();
  resetLifecycle();
});

const probe = async (path: string): Promise<Response> => fetch(`${endpoint?.url ?? ''}${path}`);

describe('unit · loop liveness on the scrape port', () => {
  test('200 while every loop stamps inside its bound, 503 once one is wedged past it', async () => {
    at = LIVENESS_FLOOR_MS;
    expect((await probe('/healthz')).status).toBe(200);
    at = LIVENESS_FLOOR_MS + 1;
    const wedged = await probe('/healthz');
    expect(wedged.status).toBe(503);
    // The verdict only: a loop name is topology, and this port is unauthenticated.
    expect(await wedged.text()).not.toContain('jobWorker');
    beat?.stamp();
    expect((await probe('/healthz')).status).toBe(200);
  });

  test('a stopped loop is not judged, and /readyz never reads loops', async () => {
    at = 10 * LIVENESS_FLOOR_MS;
    expect(livenessPayload().status).toBe(503);
    expect((await probe('/readyz')).status).toBe(503); // not ready: nothing marked it so
    beat?.stop();
    expect(livenessPayload().status).toBe(200);
  });

  test('a drained process is 503 whatever its loops say', async () => {
    await drain('test');
    expect(livenessPayload().status).toBe(503);
  });
});
