// The scrape listener is the only socket `worker`, `scheduler` and `replicator` open, so it is where
// their `/healthz` and `/readyz` live. A replicator whose stream died must answer 503 on `/readyz`:
// the check slice 08 registered was read by nothing on a dedicated replicator pod.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  drain,
  markReady,
  registerReadinessCheck,
  resetLifecycle,
  resetListeners,
} from '@ultimat3/core';
import { type MetricsEndpoint, startMetricsEndpoint } from './metrics-endpoint';
import { watchReplicatorReadiness } from './role-replicator';

let endpoint: MetricsEndpoint | undefined;

beforeEach(() => {
  resetLifecycle();
  endpoint = startMetricsEndpoint({ port: 0, role: 'replicator' });
});

afterEach(() => {
  endpoint?.stop();
  endpoint = undefined;
  resetListeners();
  resetLifecycle();
});

const probe = async (path: string): Promise<Response> => fetch(`${endpoint?.url ?? ''}${path}`);

describe('unit · health on the scrape port', () => {
  test('/readyz follows the replicator check: 200 while running, 503 once the stream is down', async () => {
    markReady();
    const replicator = { running: true };
    const unregister = watchReplicatorReadiness(replicator);
    try {
      const ready = await probe('/readyz');
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ state: 'ready', ready: true, role: 'replicator' });
      replicator.running = false;
      expect((await probe('/readyz')).status).toBe(503);
    } finally {
      unregister();
    }
  });

  test('/readyz is 503 before the boot marked ready; /healthz answers 200 all the same', async () => {
    expect((await probe('/readyz')).status).toBe(503);
    expect((await probe('/healthz')).status).toBe(200);
  });

  test('the body is the verdict only — a check name never reaches an unauthenticated probe', async () => {
    markReady();
    const unregister = registerReadinessCheck('database', () => false);
    try {
      const body = await (await probe('/readyz')).text();
      expect(body).not.toContain('database');
      expect((await probe('/readyz')).headers.get('cache-control')).toBe('no-store');
    } finally {
      unregister();
    }
  });

  test('a drained process is 503 on both', async () => {
    markReady();
    await drain('test');
    expect((await probe('/healthz')).status).toBe(503);
    expect((await probe('/readyz')).status).toBe(503);
  });
});
