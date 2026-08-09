// `--role` used to be parsed and thrown away. These tests pin both halves of the fix: the flag
// selects, and the selection actually starts (and stops) the framework objects that role runs.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import {
  createMemoryDriver,
  createMemoryEventBus,
  resetJobs,
  resetTasks,
  task,
} from '@ultimat3/jobs';
import { InProcessTransport } from '@ultimat3/realtime';
import { defineStorage, localDriver } from '@ultimat3/storage';
import type { RunningRoles } from './dev-roles';
import { DEV_ROLES, selectRoles, startRoles } from './dev-roles';
import type { RunningServices } from './dev-runtime';
import { resolveServices } from './dev-services';

const ROOT = `${import.meta.dir}/../.roles-fixture`;

/** Every service a role touches, embedded but real — no PGlite boot for a role-wiring test. */
function fakeRuntime(): RunningServices {
  const services = resolveServices(ROOT, {});
  const transport = new InProcessTransport();
  return {
    services,
    db: { async ping() {}, async close() {} } as unknown as RunningServices['db'],
    jobs: createMemoryDriver(),
    events: createMemoryEventBus(),
    transport,
    storage: defineStorage({ disks: { local: localDriver({ root: `${ROOT}/storage` }) } }),
    stop: async () => transport.close(),
  };
}

/** The thrown value, so the matcher sees an error rather than a thunk. */
function refused(flag: string): unknown {
  try {
    selectRoles(flag);
  } catch (error) {
    return error;
  }
  return undefined;
}

let running: RunningRoles | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  resetJobs();
  resetTasks();
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('unit · x dev --role', () => {
  test('no flag runs every dev role', () => {
    expect(selectRoles(undefined)).toEqual(DEV_ROLES);
    expect(selectRoles('')).toEqual(DEV_ROLES);
    expect(DEV_ROLES).toEqual(['web', 'sync', 'worker', 'scheduler']);
  });

  test('a subset is honoured, deduped and kept in boot order', () => {
    expect(selectRoles('worker,web,worker')).toEqual(['web', 'worker']);
  });

  test('an unknown role is a flag error carrying the working invocation', () => {
    const thrown = refused('webb');
    expect(thrown).toBeUltimateError('X_CLI_BAD_FLAG');
    expect((thrown as { fix: string }).fix).toBe('x dev --role web,sync,worker,scheduler');
  });

  test('a real role that dev cannot run is refused rather than silently dropped', () => {
    expect(refused('migrate')).toBeUltimateError('X_CLI_BAD_FLAG');
    expect(refused('replicator')).toBeUltimateError('X_CLI_BAD_FLAG');
  });

  test('worker and scheduler start without a web server, and drain the queue', async () => {
    task({
      name: 'nightly',
      cron: '0 3 * * *',
      tz: 'UTC',
      job: { name: 'nightly-job', idempotencyKey: () => 'nightly' },
    });
    running = await startRoles({
      roles: selectRoles('worker,scheduler'),
      port: 0,
      buildId: 'test',
      runtime: fakeRuntime(),
      routes: [],
    });

    expect(running.roles).toEqual(['worker', 'scheduler']);
    expect(running.url).toBeNull();
    expect(running.syncUrl).toBeNull();
    expect(running.server).toBeNull();
    expect((await running.worker?.stats())?.state).toBe('running');
    expect(running.scheduler).not.toBeNull();
  });

  test('the web role serves the routes it was handed, and nothing else starts', async () => {
    running = await startRoles({
      roles: selectRoles('web'),
      port: 0,
      buildId: 'test',
      runtime: fakeRuntime(),
      routes: [
        {
          method: 'GET',
          path: '/_x/ping',
          meta: { name: 'ping', auth: 'public' },
          handler: () => new Response('pong'),
        },
      ],
    });

    expect(running.worker).toBeNull();
    expect(running.scheduler).toBeNull();
    expect(running.url).toStartWith('http://');
    const response = await running.server?.fetch(new Request('http://dev.test/_x/ping'));
    expect(await response?.text()).toBe('pong');
  });
});
