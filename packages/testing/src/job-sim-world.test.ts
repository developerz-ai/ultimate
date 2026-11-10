// The simulated world, seen from a body: its own enqueues go through its worker's view and are
// effects (a deduped one is not), a queue id in an effect is reported by its ordinal, and the
// ambient job driver the world installed is handed back on dispose.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { JobDriver } from '@ultimat3/jobs';
import { job, jobDriver, memoryJobDriver, t } from '@ultimat3/jobs';
import { installJobDriver, resetJobDriver } from '@ultimat3/jobs/adapter';
import type { SimOp } from './job-sim-driver';
import { SEND_AND_ANSWER } from './job-sim-driver';
import { openSimWorld } from './job-sim-world';
import { captureNetwork, mockFetch, restoreCapturedNetwork } from './sealed-network';

const child = job<{ id: string }>({
  name: 'simWorldChild',
  input: t.object({ id: t.string }),
  tenant: 'none',
  retry: { attempts: 3, backoff: 'fixed', delay: 0, jitter: 'none' },
  idempotencyKey: (input) => `child:${input.id}`,
  run: async () => undefined,
});

const parent = job<{ id: string }>({
  name: 'simWorldParent',
  input: t.object({ id: t.string }),
  tenant: 'none',
  retry: { attempts: 3, backoff: 'fixed', delay: 0, jitter: 'none' },
  idempotencyKey: (input) => `parent:${input.id}`,
  run: async ({ jobId, input }) => {
    await child.enqueue({ id: input.id });
    // The same key while the first is live: deduped, so not a second effect.
    await child.enqueue({ id: input.id });
    await child.enqueueMany([{ id: `${input.id}-x` }, { id: `${input.id}-y` }]);
    await fetch(`https://hook.example/done/${jobId}`, { method: 'POST' });
  },
});

let network = captureNetwork();
let priorDriver: JobDriver | undefined;
beforeEach(() => {
  priorDriver = jobDriver();
  network = captureNetwork();
  mockFetch(/^https:\/\/hook\.example\//, () => new Response('ok'));
});
afterEach(() => {
  restoreCapturedNetwork(network);
  if (priorDriver === undefined) resetJobDriver();
  else installJobDriver(priorDriver);
});

describe('openSimWorld', () => {
  test("a body's enqueues are its worker's effects, and ids are reported by ordinal", async () => {
    const ops: SimOp[] = [];
    await using world = await openSimWorld({
      seed: 7,
      decide: (op) => {
        ops.push(op);
        return SEND_AND_ANSWER;
      },
    });
    const queued = await world.enqueue(parent, { id: 'a' });
    expect(world.name(queued.id)).toBe('job#1');
    expect(world.name(queued.runId)).toBe('run#1');
    expect(world.name('not-a-queue-id')).toBe('not-a-queue-id');

    const ran = await world.tick('w1');
    expect(ran.map((execution) => execution.jobId)).toEqual([queued.id]);

    expect(world.effects()).toEqual([
      { key: 'enqueue:simWorldChild', worker: 'w1' },
      { key: 'enqueue:simWorldChild', worker: 'w1' },
      { key: 'enqueue:simWorldChild', worker: 'w1' },
      { key: 'network:POST hook.example/done/job#1', worker: 'w1' },
    ]);
    // The body's own enqueue went through w1's view, so the schedule decided it as w1's.
    const enqueues = ops.filter((op) => op.call === 'enqueue' || op.call === 'enqueueMany');
    expect(enqueues.map((op) => [op.worker, op.call])).toEqual([
      ['w1', 'enqueue'],
      ['w1', 'enqueue'],
      ['w1', 'enqueueMany'],
    ]);
    expect(enqueues[2]?.names).toEqual(['simWorldChild', 'simWorldChild']);
  });

  test('a dead worker is refused its enqueue, and the effect never lands', async () => {
    await using world = await openSimWorld({
      seed: 7,
      decide: (op) =>
        op.call === 'enqueue' && op.worker === 'w1'
          ? { before: 'kill', after: 'answer' }
          : SEND_AND_ANSWER,
    });
    await world.enqueue(parent, { id: 'b' });
    await world.tick('w1');
    expect(world.sim.isDead('w1')).toBe(true);
    expect(world.effects()).toEqual([]);
    const names = (await world.rows()).map((row) => row.name);
    expect(names).toEqual(['simWorldParent']);
  });

  test('the job driver installed before the world is the one installed after it', async () => {
    const outer = memoryJobDriver();
    installJobDriver(outer);
    {
      await using world = await openSimWorld({ seed: 1, decide: () => SEND_AND_ANSWER });
      expect(jobDriver()).not.toBe(outer);
      expect(world.sim.base).not.toBe(outer);
    }
    expect(jobDriver()).toBe(outer);
    await outer.close();
  });
});
