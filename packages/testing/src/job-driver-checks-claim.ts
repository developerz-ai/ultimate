// What every `JobDriver`'s claim answers besides its rows: when an empty claim's next row falls
// due (`onEmpty` — what an idle worker rests on) and the run's steps on each claimed row (`steps`).
// A driver that skipped either compiled and cost a round trip, or a minute of pickup latency.
// Type-only imports: the barrel never loads `@ultimat3/jobs`.

import { expect } from 'bun:test';
import type { ClaimOptions, JobDriver } from '@ultimat3/jobs';
import type { JobDriverCheck } from './job-driver-checks';

let minted = 0;

/** A queue and a job name of this check's own, so checks sharing one store never see each other. */
const scope = (): { readonly queue: string; readonly name: string } => {
  minted += 1;
  const tag = `${process.pid.toString(36)}-c${minted.toString(36)}`;
  return { queue: `conformance-${tag}`, name: `conformance.job-${tag}` };
};

/** One claim on `queue`, and what its `onEmpty` was told — `'untold'` when it was not called. */
async function claimHearing(
  driver: JobDriver,
  queue: string,
  extra: Partial<ClaimOptions> = {},
): Promise<{ readonly taken: number; readonly told: number | null | 'untold' }> {
  let told: number | null | 'untold' = 'untold';
  const claimed = await driver.claim({
    queues: [queue],
    limit: 10,
    visibilityTimeoutMs: 30_000,
    workerId: 'w-horizon',
    onEmpty: (dueInMs) => {
      told = dueInMs;
    },
    ...extra,
  });
  return { taken: claimed.length, told };
}

/** Slack for the database's clock against this process's, and for the statement's own time. */
const SKEW_MS = 2_000;

export const CLAIM_ANSWER_CHECKS: readonly JobDriverCheck[] = [
  {
    name: 'an empty claim says when its next row is due: none, a delayed row, a held lease',
    async run(driver) {
      const at = scope();
      expect(await claimHearing(driver, at.queue)).toEqual({ taken: 0, told: null });
      // Delayed on the DRIVER's clock — a nack's delay — never this process's `Date`.
      await driver.enqueue({
        name: at.name,
        queue: at.queue,
        input: {},
        idempotencyKey: 'later',
        maxAttempts: 3,
      });
      const [taken] = await driver.claim({
        queues: [at.queue],
        limit: 1,
        visibilityTimeoutMs: 30_000,
        workerId: 'w-delay',
      });
      if (taken === undefined) return expect.unreachable('the row is claimable');
      const by = { workerId: 'w-delay', claim: taken.claim, delayMs: 30_000 };
      expect(await driver.nack(taken.id, by)).toBe(true);
      const delayed = await claimHearing(driver, at.queue);
      expect(delayed.taken).toBe(0);
      expect(delayed.told).toBeGreaterThan(30_000 - SKEW_MS);
      expect(delayed.told).toBeLessThanOrEqual(30_000 + SKEW_MS);

      const held = scope();
      await driver.enqueue({
        name: held.name,
        queue: held.queue,
        input: {},
        idempotencyKey: 'now',
        maxAttempts: 3,
      });
      // A claim that TOOK something is not empty: nothing is told.
      expect(await claimHearing(driver, held.queue, { visibilityTimeoutMs: 20_000 })).toEqual({
        taken: 1,
        told: 'untold',
      });
      const lease = await claimHearing(driver, held.queue);
      expect(lease.taken).toBe(0);
      expect(lease.told).toBeGreaterThan(20_000 - SKEW_MS);
      expect(lease.told).toBeLessThanOrEqual(20_000 + SKEW_MS);
    },
  },
  {
    name: "a claimed row carries its run's steps: none on a first attempt, the written ones after",
    async run(driver) {
      const at = scope();
      await driver.enqueue({
        name: at.name,
        queue: at.queue,
        input: {},
        idempotencyKey: 'stepped',
        maxAttempts: 3,
      });
      const ask = { queues: [at.queue], limit: 1, visibilityTimeoutMs: 30_000, workerId: 'w-s' };
      const [first] = await driver.claim(ask);
      if (first === undefined) return expect.unreachable('the row is claimable');
      expect(first.steps).toEqual([]);
      const by = { workerId: 'w-s', claim: first.claim };
      await driver.steps.put(
        {
          runId: first.runId,
          name: 'charge',
          status: 'completed',
          output: { cents: 1200 },
          startedAt: 1_000,
          completedAt: 2_000,
          attempts: 1,
        },
        { job: at.name, jobId: first.id, ...by },
      );
      expect(await driver.nack(first.id, { ...by, delayMs: 0 })).toBe(true);
      const [second] = await driver.claim(ask);
      expect(second?.steps).toEqual([
        {
          runId: first.runId,
          name: 'charge',
          status: 'completed',
          output: { cents: 1200 },
          startedAt: 1_000,
          completedAt: 2_000,
          attempts: 1,
        },
      ]);
    },
  },
];
