// The replicator role hands its replicator a heartbeat and judges it while the role runs: a change
// whose publish never returns turns `/healthz` (`runtime-liveness.ts`) 503 past the bound, a quiet
// feed never does, and a stopped role is not judged.

import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { resetLifecycle } from '@ultimat3/core';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import { LIVENESS_FLOOR_MS, staleLoops } from '@ultimat3/jobs';
import type { Replicator, ReplicatorOptions } from '@ultimat3/realtime/server';
import { InProcessTransport } from '@ultimat3/realtime/server';
import { startReplicator } from './role-replicator';
import type { DevServices } from './runtime-bindings';
import { livenessPayload } from './runtime-liveness';

const services: DevServices = {
  root: '/tmp',
  stateDir: '/tmp/x-replicator-liveness-test',
  db: { name: 'db', mode: 'external', url: 'postgres://app:pw@localhost:5432/app', detail: 'env' },
  events: { name: 'events', mode: 'embedded', url: 'inproc://events', detail: 'in-process' },
  storage: { name: 'storage', mode: 'embedded', url: 'file:///tmp/s', detail: 'local' },
};

beforeEach(() => {
  jest.useFakeTimers();
  clearRegistry();
  resetLifecycle();
  entity('post', { columns: { id: uuid().primaryKey(), title: text() } });
});

afterEach(() => {
  jest.useRealTimers();
  clearRegistry();
  resetLifecycle();
});

const holder = (): {
  create: (options: ReplicatorOptions) => Replicator;
  seen: () => ReplicatorOptions;
} => {
  let seen: ReplicatorOptions | undefined;
  const replicator: Replicator = {
    start: async () => true,
    stop: async () => undefined,
    running: true,
    lastLsn: () => null,
    stats: () => ({ published: 0, skipped: 0, outOfOrder: 0, restarts: 0, failure: null }),
    retryDelayMs: () => 1,
  };
  return {
    create: (options) => {
      seen = options;
      return replicator;
    },
    seen: () => seen ?? expect.unreachable('the role never built its replicator'),
  };
};

describe('unit · replicator liveness', () => {
  test('a pass held open past the bound is 503; a quiet feed and a stopped role are 200', async () => {
    const fake = holder();
    const transport = new InProcessTransport();
    const running = await startReplicator({
      services,
      env: { DATABASE_URL: services.db.url },
      transport,
      dev: false,
      create: fake.create,
    });
    try {
      const heartbeat = fake.seen().heartbeat ?? expect.unreachable('no heartbeat handed over');
      jest.advanceTimersByTime(10 * LIVENESS_FLOOR_MS);
      expect(livenessPayload().status).toBe(200);
      heartbeat.enter();
      jest.advanceTimersByTime(LIVENESS_FLOOR_MS + 1);
      expect(staleLoops().map((loop) => loop.name)).toEqual(['realtime.replicator']);
      expect(livenessPayload().status).toBe(503);
    } finally {
      await running.stop();
      await transport.close();
    }
    expect(livenessPayload().status).toBe(200);
  });
});
