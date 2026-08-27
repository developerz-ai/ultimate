// `--role` used to be parsed and thrown away. These tests pin both halves of the fix: the flag
// selects, and the selection actually starts (and STOPS) the framework objects that role runs.
// What a started role then does is elsewhere, one file per question: who is calling
// (`dev-roles-identity.test.ts`) and what its responses admit (`dev-roles-csp.test.ts`).

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
import { METRICS_PATH } from '@ultimat3/core';
import type { OutboxRecord, OutboxStore } from '@ultimat3/jobs';
import { job, t, task } from '@ultimat3/jobs';
import type { RunningRoles } from './dev-roles';
import { DEV_ROLES, SELECTABLE_ROLES, selectRoles, startRoles } from './dev-roles';
import { fixtureRuntime, resetDevRolesState } from './dev-roles-fixture';

const ROOT = `${import.meta.dir}/../.roles-fixture`;

/**
 * Hand the loop back until nothing is queued but the work this test is holding. A macrotask turn,
 * not a duration: the teardown's other awaits are all already-settled promises, so one turn is
 * everything it can do without the pass — and a sleep would be asserting how long that took.
 */
const scheduled = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const fakeRuntime = (): ReturnType<typeof fixtureRuntime> => fixtureRuntime(ROOT);

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
  resetDevRolesState();
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

  test('migrate is refused rather than silently dropped: it is a command, not a process', () => {
    expect(refused('migrate')).toBeUltimateError('X_CLI_BAD_FLAG');
  });

  test('replicator is selectable but never default — it takes the database its own slot', () => {
    expect(refused('replicator')).toBeUndefined();
    expect(selectRoles('replicator')).toEqual(['replicator']);
    expect(SELECTABLE_ROLES).toEqual(['web', 'sync', 'worker', 'scheduler', 'replicator']);
    expect(DEV_ROLES).not.toContain('replicator');
  });

  test('the replicator sorts last, after the transport it publishes to', () => {
    expect(selectRoles('replicator,sync')).toEqual(['sync', 'replicator']);
  });

  test('worker and scheduler start without a web server, and drain the queue', async () => {
    // `enqueue: () => [[handle, input]]`, not `job: { name, idempotencyKey }` — `TaskDefinition`
    // has carried entries rather than a single job name since `task()` learned catch-up, and the
    // handle has to be built OUTSIDE `enqueue`: that callback runs on every describe, and `job()`
    // refuses a second registration under the same name. Same shape as `cmd-tasks.test.ts`.
    const nightlyJob = job({
      name: 'nightly-job',
      input: t.object({}),
      tenant: 'none' as const,
      idempotencyKey: () => 'nightly',
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });
    task({
      name: 'nightly',
      cron: '0 3 * * *',
      tz: 'UTC',
      enqueue: () => [[nightlyJob, {}]],
    });
    running = await startRoles({
      roles: selectRoles('worker,scheduler'),
      port: 0,
      buildId: 'test',
      runtime: fakeRuntime(),
      env: {},
      routes: [],
    });

    expect(running.roles).toEqual(['worker', 'scheduler']);
    expect(running.url).toBeNull();
    expect(running.syncUrl).toBeNull();
    expect(running.server).toBeNull();
    expect((await running.worker?.stats())?.state).toBe('running');
    expect(running.scheduler).not.toBeNull();

    // …and is still scrapable. `worker` opens no HTTP socket at all, so without the metrics
    // listener the `queue_depth` HPA in `docker/helm` has nowhere to read from and sits at
    // `<unknown>` forever — which is what it did.
    const scrape = await fetch(`${running.metricsUrl}${METRICS_PATH}`);
    expect(scrape.status).toBe(200);
    expect(await scrape.text()).toContain('# TYPE queue_depth gauge');
  });

  /**
   * `OutboxRelay.stop()` waits out the pass in flight — a publish and the `markPublished` behind
   * it are one pass, and a teardown that returns between them closed the database under the row it
   * was about to mark. That join is only as good as the `await`, and both teardown paths here
   * called it in statement position, which is a promise the boot dropped on the floor.
   */
  test('stopping the worker role joins the outbox pass instead of returning underneath it', async () => {
    const events: string[] = [];
    const gate = Promise.withResolvers<void>();
    const claimed = Promise.withResolvers<void>();
    let claims = 0;
    const record: OutboxRecord = {
      id: 'row-1',
      job: 'staged-job',
      queue: 'default',
      input: {},
      idempotencyKey: 'staged-job:1',
      maxAttempts: 1,
      runAt: 0,
      stagedAt: 0,
    };
    const outbox: OutboxStore = {
      async stage() {},
      async commit() {
        return [];
      },
      async rollback() {},
      async claim() {
        claims += 1;
        // One gated pass. A later tick must not re-enter it — `stop()` clears the interval first,
        // so a second claim only ever happens if the pass this test holds was never joined.
        if (claims > 1) return [];
        claimed.resolve();
        await gate.promise;
        return [record];
      },
      async markPublished() {
        events.push('marked');
      },
      async pendingCount() {
        return 0;
      },
    };

    const started = await startRoles({
      roles: selectRoles('worker'),
      port: 0,
      buildId: 'test',
      runtime: { ...fakeRuntime(), outbox },
      env: {},
      routes: [],
    });

    // No sleep: the relay's own poll resolves this, and until it does there is no pass to join.
    await claimed.promise;
    const stopping = started.stop().then(() => {
      events.push('stopped');
    });
    // Everything the teardown can reach without the pass has now run. Releasing the pass here is
    // what makes the order an assertion about a dependency rather than about a duration.
    await scheduled();
    gate.resolve();
    await stopping;

    expect(events).toEqual(['marked', 'stopped']);
  });

  test('the web role serves the routes it was handed, and nothing else starts', async () => {
    running = await startRoles({
      roles: selectRoles('web'),
      port: 0,
      buildId: 'test',
      runtime: fakeRuntime(),
      env: {},
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

  test('the sync role reports the socket it bound, not the port that was asked for', async () => {
    running = await startRoles({
      roles: selectRoles('sync'),
      // The bug: `port + 1` turned an ephemeral request into a request for port 1, and the
      // reported url was built from the number rather than read from the listener.
      port: 0,
      buildId: 'test',
      runtime: fakeRuntime(),
      env: {},
      routes: [],
    });

    const url = new URL(running.syncUrl ?? '');
    expect(url.protocol).toBe('ws:');
    expect(Number.parseInt(url.port, 10)).toBeGreaterThan(1);
  });

  test('a role that cannot bind rejects instead of handing back a half-started set', async () => {
    // Occupy the port the sync role will ask for, so `startSync` is the step that throws and the
    // web role started before it is the one the unwind has to give back.
    const blocker = Bun.serve({ port: 0, fetch: () => new Response('taken') });

    await expect(
      startRoles({
        roles: selectRoles('web,sync'),
        // `Server.port` is `number | undefined` — a unix-socket server has none. This one is TCP.
        port: (blocker.port ?? expect.unreachable('the blocker opened no TCP port')) - 1,
        // Explicit, because `port` is not 0 here: the fixed 9090 would make this test fail on
        // whichever machine already runs a Prometheus, for a reason that is not the one under test.
        metricsPort: 0,
        buildId: 'test',
        runtime: fakeRuntime(),
        env: {},
        routes: [],
      }),
    ).rejects.toThrow();

    blocker.stop(true);
  });
});
