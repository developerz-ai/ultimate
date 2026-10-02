// The WORKER's half of a claim-time burial, written once over a harness and run on both drivers
// (`driver-parity-lifecycle.test.ts`, `driver-pg-lifecycle.job.test.ts`): a row the claim settles
// has no body and no settle, so the claim round is the only thing that can count it, log it and
// tell the job — and until it listened, a buried row ended in silence.

import { expect, test } from 'bun:test';
import type { JobDriver } from './driver';
import { LEASE_LAPSED_FINAL_ATTEMPT } from './driver';
import type { OperatorHarness } from './operator-surface-fixture';
import {
  enqueueItem,
  itemJob,
  operatorOf,
  rowOf,
  TTL_MS,
  workerOn,
} from './operator-surface-fixture';
import type { JobSettled } from './settled';

/** `attempts` passes by workers that die holding the row, each lease left to lapse. */
async function dieHolding(
  harness: OperatorHarness,
  driver: JobDriver,
  attempts: number,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const claimed = await driver.claim({
      queues: ['default'],
      limit: 5,
      visibilityTimeoutMs: TTL_MS,
      workerId: `doomed-${attempt}`,
    });
    expect(claimed.map((row) => row.attempt)).toEqual([attempt]);
    await harness.elapse(driver, TTL_MS + 1);
  }
}

export function workerExhaustedScenarios(label: string, harness: OperatorHarness): void {
  test(`${label}: the worker whose pass buries a row counts it and tells the job, once`, async () => {
    const driver = await harness.driver();
    const settled: JobSettled<unknown>[] = [];
    let ran = 0;
    const handle = itemJob({
      run: () => {
        ran += 1;
        return Promise.resolve();
      },
      retry: { attempts: 3, jitter: false },
      onSettled: (ending) => {
        settled.push(ending);
        return Promise.resolve();
      },
    });
    const id = await enqueueItem(driver, handle);
    await dieHolding(harness, driver, 3);

    const worker = workerOn(harness, driver, 'survivor');
    // The fourth tick: nothing to run, one row to bury.
    expect(await worker.tick()).toEqual([]);

    expect(ran).toBe(0);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      outcome: 'dead-lettered',
      jobId: id,
      attempt: 3,
      error: LEASE_LAPSED_FINAL_ATTEMPT,
    });
    expect((await worker.stats()).deadLettered).toBe(1);
    expect((await operatorOf(driver).deadLetters()).map((dead) => dead.id)).toEqual([id]);

    // Buried once, so announced once: later passes find nothing.
    await worker.tick();
    expect(settled).toHaveLength(1);
    expect((await worker.stats()).deadLettered).toBe(1);
  });

  test(`${label}: a job declaring retry.deadLetter false is DROPPED by the burial, never dead-lettered`, async () => {
    const driver = await harness.driver();
    const settled: JobSettled<unknown>[] = [];
    const handle = itemJob({
      run: () => Promise.resolve(),
      retry: { attempts: 2, jitter: false, deadLetter: false },
      onSettled: (ending) => {
        settled.push(ending);
        return Promise.resolve();
      },
    });
    const id = await enqueueItem(driver, handle);
    await dieHolding(harness, driver, 2);

    const worker = workerOn(harness, driver, 'survivor');
    expect(await worker.tick()).toEqual([]);

    // "Do not keep": the row is `failed`, out of the dead-letter queue, as a nack would leave it.
    expect(await rowOf(driver, id)).toMatchObject({
      state: 'failed',
      attempt: 2,
      lastError: LEASE_LAPSED_FINAL_ATTEMPT,
    });
    expect(await operatorOf(driver).deadLetters()).toEqual([]);
    expect(settled.map((ending) => ending.outcome)).toEqual(['dropped']);
    const stats = await worker.stats();
    expect([stats.deadLettered, stats.dropped]).toEqual([0, 1]);
    const totals = (await operatorOf(driver).counterTotals(0)).find(
      (entry) => entry.job === handle.name,
    );
    expect(totals).toMatchObject({ dead: 0, failed: 1 });
  });
}
