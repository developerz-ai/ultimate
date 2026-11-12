// What every `JobDriver`'s enqueue does past "insert or dedupe": debounce (`onConflict: 'replace'`),
// expiry (`expiresAt`, settled by the claim) and the backlog count `maxPending` reads. A driver that
// ignored any of them compiled, and ran a stale input, a worthless job, or an unbounded queue.
// Type-only imports: the barrel never loads `@ultimat3/jobs`.

import { expect } from 'bun:test';
import type { JobDriver, JobRecord } from '@ultimat3/jobs';
import type { JobDriverCheck } from './job-driver-checks';

let minted = 0;

/**
 * Instants no clock disagrees about. The test process's `Date` may be frozen by its preload while
 * the database answers its own `now()`, so "past" and "future" are the epoch and the year 9999.
 */
const LONG_AGO = 1;
const FAR_AHEAD = Date.UTC(9999, 0, 1);

/** A queue and a job name of this check's own, so checks sharing one store never see each other. */
const scope = (): { readonly queue: string; readonly name: string } => {
  minted += 1;
  const tag = `${process.pid.toString(36)}-e${minted.toString(36)}`;
  return { queue: `conformance-${tag}`, name: `conformance.job-${tag}` };
};

const claimOne = (
  driver: JobDriver,
  queue: string,
  onExhausted?: (rows: readonly JobRecord[]) => void,
) =>
  driver.claim({
    queues: [queue],
    limit: 10,
    visibilityTimeoutMs: 30_000,
    workerId: 'w-enqueue',
    ...(onExhausted === undefined ? {} : { onExhausted }),
  });

export const ENQUEUE_CHECKS: readonly JobDriverCheck[] = [
  {
    name: "onConflict: 'replace' gives a waiting holder the new input and runAt, never a running one",
    async run(driver) {
      const at = scope();
      const base = { name: at.name, queue: at.queue, idempotencyKey: 'debounced', maxAttempts: 3 };
      const first = await driver.enqueue({ ...base, input: { v: 1 }, runAt: FAR_AHEAD });
      // Delayed: nothing to claim yet.
      expect(await claimOne(driver, at.queue)).toEqual([]);
      const second = await driver.enqueue({
        ...base,
        input: { v: 2 },
        runAt: LONG_AGO,
        onConflict: 'replace',
      });
      expect({ id: second.id, deduped: second.deduped }).toEqual({ id: first.id, deduped: true });
      // The SAME row, now due, carrying the replacing input.
      const [taken] = await claimOne(driver, at.queue);
      expect(taken?.id).toBe(first.id);
      expect(taken?.input).toEqual({ v: 2 });
      // Running: past replacing. Answered as a dedupe, and the run keeps its input.
      const third = await driver.enqueue({ ...base, input: { v: 3 }, onConflict: 'replace' });
      expect({ id: third.id, deduped: third.deduped }).toEqual({ id: first.id, deduped: true });
      if (taken === undefined) return expect.unreachable('the replaced row was claimable');
      const by = { workerId: 'w-enqueue', claim: taken.claim, delayMs: 0, countsAsAttempt: false };
      expect(await driver.nack(taken.id, by)).toBe(true);
      const [again] = await claimOne(driver, at.queue);
      expect(again?.input).toEqual({ v: 2 });
    },
  },
  {
    name: 'a waiting row past its expiresAt is settled failed by the claim, reported, never run',
    async run(driver) {
      const at = scope();
      const base = { name: at.name, queue: at.queue, input: {}, maxAttempts: 3 };
      const lapsed = await driver.enqueue({
        ...base,
        idempotencyKey: 'lapsed',
        expiresAt: LONG_AGO,
      });
      const fresh = await driver.enqueue({
        ...base,
        idempotencyKey: 'fresh',
        expiresAt: FAR_AHEAD,
      });
      const buried: (readonly [string, string, string | undefined])[] = [];
      const report = (rows: readonly JobRecord[]): void => {
        for (const row of rows) buried.push([row.id, row.state, row.lastError]);
      };
      const taken = await claimOne(driver, at.queue, report);
      expect(taken.map((row) => row.id)).toEqual([fresh.id]);
      expect(buried).toEqual([[lapsed.id, 'failed', 'expired']]);
      // Settled for good: the next claim neither hands it out nor reports it again.
      buried.length = 0;
      expect(await claimOne(driver, at.queue, report)).toEqual([]);
      expect(buried).toEqual([]);
    },
  },
  {
    name: 'backlog counts the ready and delayed rows of one queue, no further than its cap',
    async run(driver) {
      if (driver.backlog === undefined) return expect.unreachable('the driver counts no backlog');
      const at = scope();
      const base = { name: at.name, queue: at.queue, input: {}, maxAttempts: 3 };
      await driver.enqueue({ ...base, idempotencyKey: 'a' });
      await driver.enqueue({ ...base, idempotencyKey: 'b' });
      await driver.enqueue({ ...base, idempotencyKey: 'c', runAt: FAR_AHEAD });
      expect(await driver.backlog(at.queue, 10)).toBe(3);
      await driver.claim({
        queues: [at.queue],
        limit: 1,
        visibilityTimeoutMs: 30_000,
        workerId: 'w-backlog',
      });
      // The running row no longer waits.
      expect(await driver.backlog(at.queue, 10)).toBe(2);
      expect(await driver.backlog(at.queue, 1)).toBe(1);
      expect(await driver.backlog(scope().queue, 10)).toBe(0);
    },
  },
];
