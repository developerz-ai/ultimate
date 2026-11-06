// `simulateJobs` finds what a seed plants: a duplicate claim racing a charge is caught within 20
// seeds and the seed it names replays it; a body reading state the simulation does not reset is
// `X_JOB_SIM_NONDETERMINISTIC`; a job whose effects all sit in steps holds its invariant.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { JobHandle } from '@ultimat3/jobs';
import { job, t } from '@ultimat3/jobs';
import type { SimulationState } from './job-simulate';
import { JOB_SIM_SEED_ENV, simulateJobs } from './job-simulate';
import { captureNetwork, mockFetch, restoreCapturedNetwork } from './sealed-network';

interface Order {
  readonly id: string;
}

let minted = 0;
const declare = (run: JobHandle<Order>['run']): JobHandle<Order> => {
  minted += 1;
  return job<Order>({
    name: `simulate-${String(minted)}`,
    input: t.object({ id: t.string }),
    tenant: 'none',
    idempotencyKey: (input) => `order:${input.id}`,
    retry: { attempts: 5, backoff: 'fixed', delay: 0, jitter: false },
    run,
  });
};

const charge = (id: string): Promise<Response> =>
  fetch(`https://pay.example/charge/${id}`, { method: 'POST' });

let network = captureNetwork();
beforeEach(() => {
  network = captureNetwork();
  mockFetch(/^https:\/\/pay\.example\//, () => new Response('{}'));
});
afterEach(() => {
  restoreCapturedNetwork(network);
  delete Bun.env[JOB_SIM_SEED_ENV];
});

const charged = (state: SimulationState, id: string): number =>
  state.effects.filter((effect) => effect.key === `network:POST pay.example/charge/${id}`).length;

const orders = (handle: JobHandle<Order>) =>
  ['a', 'b', 'c'].map((id) => ({ handle, input: { id } }));

const caught = async (run: Promise<unknown>): Promise<unknown> => {
  try {
    await run;
  } catch (error) {
    return error;
  }
  return expect.unreachable('the simulation found nothing');
};

describe('simulateJobs', () => {
  test('a duplicate claim racing a charge is found within 20 seeds, and its seed replays', async () => {
    const pay = declare(async ({ step, input }) => {
      await step.run('charge', async () => (await charge(input.id)).status);
    });
    const options = {
      jobs: orders(pay),
      workers: 2,
      faults: ['duplicate-claim'] as const,
      faultRate: 0.3,
      invariant: (state: SimulationState) =>
        ['a', 'b', 'c'].every((id) => charged(state, id) === 1),
    };
    const error = await caught(simulateJobs(options));
    expect(error).toBeUltimateError('X_JOB_SIM_INVARIANT');
    const seed = isUltimateError(error) ? Number(error.meta?.['seed']) : Number.NaN;
    expect(seed).toBeLessThanOrEqual(20);
    expect(isUltimateError(error) && error.fix).toStartWith(`x test job --seed ${seed} `);

    // The seed alone, as `x test job --seed <n>` hands it over: the same violation.
    Bun.env[JOB_SIM_SEED_ENV] = String(seed);
    const again = await caught(simulateJobs(options));
    expect(isUltimateError(again) && again.meta?.['seed']).toBe(seed);
  });

  test('the same race with no fault planted holds the invariant on every seed', async () => {
    const pay = declare(async ({ step, input }) => {
      await step.run('charge', async () => (await charge(input.id)).status);
    });
    const report = await simulateJobs({
      seeds: 20,
      jobs: orders(pay),
      faults: [],
      invariant: (state) => ['a', 'b', 'c'].every((id) => charged(state, id) === 1),
    });
    expect(report.seeds).toHaveLength(20);
  });

  test('under every fault kind, no run is left live and every done order was charged', async () => {
    const pay = declare(async ({ step, input }) => {
      await step.run('charge', async () => (await charge(input.id)).status);
    });
    const ids = new Map([
      ['job#1', 'a'],
      ['job#2', 'b'],
      ['job#3', 'c'],
    ]);
    const report = await simulateJobs({
      seeds: 5,
      jobs: orders(pay),
      invariant: (state) =>
        state.runs.every(
          (run) =>
            run.state === 'dead' ||
            (run.state === 'done' && charged(state, ids.get(run.id) ?? '') >= 1),
        ),
    });
    expect(report.seeds).toEqual([1, 2, 3, 4, 5]);
  });

  test('a body reading state the simulation does not reset is X_JOB_SIM_NONDETERMINISTIC', async () => {
    let calls = 0;
    const drifting = declare(async ({ step }) => {
      calls += 1;
      await step.run(`charge-${String(calls)}`, () => 'ok');
    });
    const error = await caught(
      simulateJobs({
        seeds: 1,
        faults: [],
        jobs: [{ handle: drifting, input: { id: 'a' } }],
        invariant: () => true,
      }),
    );
    expect(error).toBeUltimateError('X_JOB_SIM_NONDETERMINISTIC');
  });

  test('a refused option names itself', async () => {
    const pay = declare(async () => 'ok');
    const error = await caught(
      simulateJobs({
        faultRate: 2,
        jobs: [{ handle: pay, input: { id: 'a' } }],
        invariant: () => true,
      }),
    );
    expect(error).toBeUltimateError('X_INVARIANT');
  });
});
