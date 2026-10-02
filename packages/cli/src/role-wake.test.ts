// Who holds the LISTEN session, and whether an operator can see it working. Only the worker role
// may subscribe; a client that cannot listen starts nothing; `queue_wake_live` is 1 only after a
// notification has crossed BOTH channels, and falls back to 0 the moment the wake stops.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
import { collectMetrics } from '@ultimat3/core';
import type { DbClient } from '@ultimat3/db';
import type { RunningRoles } from './role-start';
import { startRoles } from './role-start';
import { fixtureRuntime, resetDevRolesState } from './role-start-fixture';
import { startWorkerWake } from './role-wake';
import type { RunningServices } from './runtime-services';

const ROOT = `${import.meta.dir}/../.role-wake-fixture`;

let running: RunningRoles | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  resetDevRolesState();
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

/** A client that records every LISTEN and lets the test deliver a notification on a channel. */
function listeningDb(): {
  readonly db: DbClient;
  readonly channels: string[];
  readonly unlistened: string[];
  notify(channel: string): void;
} {
  const handlers = new Map<string, (payload: string) => void>();
  const channels: string[] = [];
  const unlistened: string[] = [];
  const db = {
    async query(): Promise<readonly never[]> {
      return [];
    },
    async one(): Promise<null> {
      return null;
    },
    async execute(): Promise<number> {
      return 0;
    },
    async ping(): Promise<void> {},
    async close(): Promise<void> {},
    async listen(
      channel: string,
      onNotify: (payload: string) => void,
      onListening?: () => void,
    ): Promise<{ unlisten(): Promise<void> }> {
      channels.push(channel);
      handlers.set(channel, onNotify);
      onListening?.();
      return {
        async unlisten(): Promise<void> {
          unlistened.push(channel);
        },
      };
    },
  };
  return {
    db,
    channels,
    unlistened,
    notify: (channel) => handlers.get(channel)?.(''),
  };
}

const wakeLive = (): number | undefined =>
  collectMetrics().metrics.find((metric) => metric.descriptor.name === 'queue_wake_live')?.points[0]
    ?.value;

/** Every pending microtask and the timers already due: the wake subscribes asynchronously. */
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const runtimeOver = (db: DbClient): RunningServices => ({
  ...fixtureRuntime(ROOT),
  db: db as RunningServices['db'],
});

describe('unit · the worker wake', () => {
  test('a client that cannot listen starts no wake', () => {
    const plain = { async query() {}, async close() {} } as unknown as DbClient;
    expect(startWorkerWake(plain)).toBeNull();
  });

  test('the gauge reads 1 only once a notification has crossed both channels, and 0 after stop', async () => {
    const fake = listeningDb();
    const wake = startWorkerWake(fake.db);
    if (wake === null) return expect.unreachable('a listening client starts a wake');
    await settled();
    expect(fake.channels.length).toBe(2);
    expect([wake.live(), wakeLive()]).toEqual([false, 0]);
    const [first, second] = fake.channels as [string, string];
    fake.notify(first);
    expect(wakeLive()).toBe(0);
    fake.notify(second);
    expect([wake.live(), wakeLive()]).toEqual([true, 1]);
    await wake.stop();
    expect(wakeLive()).toBe(0);
    expect([...fake.unlistened].sort()).toEqual([...fake.channels].sort());
  });

  test('stopping a wake that was already replaced does not silence the one that replaced it', async () => {
    const old = listeningDb();
    const next = listeningDb();
    const first = startWorkerWake(old.db);
    const second = startWorkerWake(next.db);
    await settled();
    for (const channel of next.channels) next.notify(channel);
    await first?.stop();
    expect(wakeLive()).toBe(1);
    await second?.stop();
    expect(wakeLive()).toBe(0);
  });
});

describe('unit · which role holds the session', () => {
  test('the worker role subscribes, and gives the session back when it stops', async () => {
    const fake = listeningDb();
    running = await startRoles({
      roles: ['worker'],
      port: 0,
      buildId: 'test',
      runtime: runtimeOver(fake.db),
      routes: [],
      env: {},
    });
    await settled();
    expect(fake.channels.length).toBe(2);
    await running.stop();
    running = undefined;
    expect(fake.unlistened.length).toBe(2);
  });

  test('a web and a scheduler pod hold no session', async () => {
    const fake = listeningDb();
    running = await startRoles({
      roles: ['web', 'scheduler'],
      port: 0,
      buildId: 'test',
      runtime: runtimeOver(fake.db),
      routes: [],
      env: {},
    });
    await settled();
    expect(fake.channels).toEqual([]);
  });

  test('a worker over a client that cannot listen starts, runs and stops on the poll alone', async () => {
    running = await startRoles({
      roles: ['worker'],
      port: 0,
      buildId: 'test',
      runtime: fixtureRuntime(ROOT),
      routes: [],
      env: {},
    });
    expect(running.worker).not.toBeNull();
    await running.stop();
    running = undefined;
  });
});
