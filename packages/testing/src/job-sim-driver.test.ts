// The simulated worker's driver view: every call is decided before it is sent, a kill or a lost
// answer rejects with a planted `X_DB_UNAVAILABLE`, and every call reaches the one shared driver.

import { describe, expect, test } from 'bun:test';
import { memoryJobDriver } from '@ultimat3/jobs';
import type { SimDecision, SimOp } from './job-sim-driver';
import { isSimFault, SEND_AND_ANSWER, simDriver } from './job-sim-driver';

const request = (name: string, key: string) => ({
  name,
  queue: 'default',
  input: { key },
  idempotencyKey: key,
  maxAttempts: 3,
});

/** Hooks recording every decided op and every landed one; `plan` overrides a decision by call. */
const recording = (plan: Partial<Record<SimOp['call'], SimDecision>> = {}) => {
  const decided: SimOp[] = [];
  const landed: SimOp[] = [];
  return {
    decided,
    landed,
    hooks: {
      decide: (op: SimOp) => {
        decided.push(op);
        return plan[op.call] ?? SEND_AND_ANSWER;
      },
      landed: (op: SimOp) => {
        landed.push(op);
      },
    },
  };
};

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return expect.unreachable('the call resolved; a fault was expected');
};

describe('simDriver', () => {
  test('every queue and step call reaches the shared driver, each op named', async () => {
    const base = memoryJobDriver();
    const rec = recording();
    const sim = simDriver(base, rec.hooks);
    const view = sim.viewFor('w1');
    expect(view.name).toBe('sim:w1');
    expect(sim.viewFor('w1')).toBe(view);

    const one = await view.enqueue(request('a', 'k1'));
    const many = await view.enqueueMany([request('b', 'k2'), request('c', 'k3')]);
    expect(many).toHaveLength(2);
    const claimed = await view.claim({
      queues: ['default'],
      limit: 3,
      visibilityTimeoutMs: 1_000,
      workerId: 'ignored',
    });
    // The worker id is the view's own, whatever the caller passed.
    expect(claimed.map((job) => job.claimedBy)).toEqual(['w1', 'w1', 'w1']);
    const [first, second, third] = claimed;
    if (first === undefined || second === undefined || third === undefined) {
      return expect.unreachable('three claims');
    }
    expect(
      await view.heartbeat(first.id, {
        visibilityTimeoutMs: 1_000,
        workerId: 'w1',
        claim: first.claim,
      }),
    ).toBe(true);
    expect(await view.ack(first.id, { workerId: 'w1', claim: first.claim })).toBe(true);
    expect(await view.nack(second.id, { workerId: 'w1', claim: second.claim, delayMs: 0 })).toBe(
      true,
    );

    const record = {
      runId: one.runId,
      name: 's1',
      status: 'completed' as const,
      output: 1,
      startedAt: 1,
      attempts: 1,
    };
    await view.steps.put(record, { job: 'a', jobId: third.id, workerId: 'w1', claim: third.claim });
    expect(await base.steps.get(one.runId, 's1')).toMatchObject({ output: 1 });
    expect(await view.steps.get(one.runId, 's1')).toMatchObject({ status: 'completed' });
    expect(await view.steps.list(one.runId)).toHaveLength(1);
    await view.steps.del(one.runId, 's1');
    expect(await base.steps.get(one.runId, 's1')).toBeUndefined();
    await view.steps.put({ ...record, name: 's2' });
    await view.steps.clear(one.runId);
    expect(await base.steps.list(one.runId)).toEqual([]);

    expect(rec.decided.map((op) => op.call)).toEqual([
      'enqueue',
      'enqueueMany',
      'claim',
      'heartbeat',
      'ack',
      'nack',
      'put',
      'get',
      'list',
      'del',
      'put',
      'clear',
    ]);
    expect(rec.decided[1]?.names).toEqual(['b', 'c']);
    expect(rec.decided[4]).toEqual({ worker: 'w1', call: 'ack', jobId: first.id });
    expect(rec.decided[6]).toMatchObject({ step: 's1', status: 'completed', jobId: third.id });
    // A put made outside a claim names no job.
    expect(rec.decided[10]).not.toHaveProperty('jobId');
    expect(rec.landed).toHaveLength(rec.decided.length);
  });

  test('a view closing never closes the shared driver', async () => {
    const base = memoryJobDriver();
    const view = simDriver(base, recording().hooks).viewFor('w1');
    await view.enqueue(request('a', 'k1'));
    await view.close?.();
    expect((await base.stats()).find((row) => row.queue === 'default')?.ready).toBe(1);
  });

  test('a kill before send lands nothing, and every later call is refused undecided', async () => {
    const base = memoryJobDriver();
    const rec = recording({ enqueue: { before: 'kill', after: 'answer' } });
    const sim = simDriver(base, rec.hooks);
    const error = await rejection(sim.viewFor('w1').enqueue(request('a', 'k1')));
    expect(isSimFault(error)).toBe(true);
    expect((error as { code: string }).code).toBe('X_DB_UNAVAILABLE');
    expect(sim.isDead('w1')).toBe(true);
    expect(await base.stats()).toEqual([]);
    expect(rec.landed).toEqual([]);

    expect(isSimFault(await rejection(sim.viewFor('w1').steps.list('r')))).toBe(true);
    expect(rec.decided).toHaveLength(1);
    expect(sim.isDead('w2')).toBe(false);
  });

  test('a kill after send has landed the call and still rejects', async () => {
    const base = memoryJobDriver();
    const rec = recording({ enqueue: { before: 'send', after: 'kill' } });
    const sim = simDriver(base, rec.hooks);
    expect(isSimFault(await rejection(sim.viewFor('w1').enqueue(request('a', 'k1'))))).toBe(true);
    expect(sim.isDead('w1')).toBe(true);
    expect((await base.stats())[0]?.ready).toBe(1);
    expect(rec.landed.map((op) => op.call)).toEqual(['enqueue']);
  });

  test('a lost answer has landed, rejects, and leaves the worker alive', async () => {
    const base = memoryJobDriver();
    const sim = simDriver(base, recording({ enqueue: { before: 'send', after: 'lose' } }).hooks);
    const error = await rejection(sim.viewFor('w1').enqueue(request('a', 'k1')));
    expect(isSimFault(error)).toBe(true);
    expect((error as Error).message).toContain('was lost after it landed');
    expect(sim.isDead('w1')).toBe(false);
    expect((await base.stats())[0]?.ready).toBe(1);
  });

  test('a worker killed while parked at the yield sends nothing', async () => {
    const base = memoryJobDriver();
    let release: (decision: SimDecision) => void = () => undefined;
    const sim = simDriver(base, {
      decide: () =>
        new Promise<SimDecision>((resolve) => {
          release = resolve;
        }),
    });
    const parked = rejection(sim.viewFor('w1').enqueue(request('a', 'k1')));
    await Promise.resolve();
    sim.kill('w1');
    release(SEND_AND_ANSWER);
    expect(isSimFault(await parked)).toBe(true);
    expect(await base.stats()).toEqual([]);
  });

  test('isSimFault refuses an error it did not plant, and non-objects', () => {
    expect(isSimFault(new TypeError('x'))).toBe(false);
    expect(isSimFault('X_DB_UNAVAILABLE')).toBe(false);
    expect(isSimFault(null)).toBe(false);
  });
});
