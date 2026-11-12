// What a debounce must survive besides a live holder: its OWN request published again (the outbox
// relay crashed before its mark), its holder finished in between, and a newer request's expiry —
// plus what `x jobs retry` must forget. A driver that re-ran a stale replace compiled and ran old
// input. Type-only imports from `@ultimat3/jobs`: the barrel never loads it.

import { expect } from 'bun:test';
import { finiteCount, uuidV7 } from '@ultimat3/core';
import type { JobDriver, JobRecord } from '@ultimat3/jobs';
import type { JobDriverCheck } from './job-driver-checks';

let minted = 0;

/** As `job-driver-checks-enqueue.ts`: instants the database's clock and a frozen one agree on. */
const LONG_AGO = 1;
const FAR_AHEAD = Date.UTC(9999, 0, 1);

/** A queue and a job name of this check's own, so checks sharing one store never see each other. */
const scope = (): { readonly queue: string; readonly name: string } => {
  minted += 1;
  const tag = `${process.pid.toString(36)}-d${minted.toString(36)}`;
  return { queue: `conformance-${tag}`, name: `conformance.job-${tag}` };
};

const claimAll = (
  driver: JobDriver,
  queue: string,
  extra: { visibilityTimeoutMs?: number; onExhausted?: (rows: readonly JobRecord[]) => void } = {},
) =>
  driver.claim({
    queues: [queue],
    limit: 10,
    visibilityTimeoutMs: finiteCount(
      'claimAll',
      'visibilityTimeoutMs',
      extra.visibilityTimeoutMs ?? 30_000,
    ),
    workerId: 'w-debounce',
    ...(extra.onExhausted === undefined ? {} : { onExhausted: extra.onExhausted }),
  });

export const DEBOUNCE_CHECKS: readonly JobDriverCheck[] = [
  {
    name: 'a replace published again never overwrites the newer replace that landed after it',
    async run(driver) {
      const at = scope();
      const base = { name: at.name, queue: at.queue, idempotencyKey: 'fenced', maxAttempts: 3 };
      const holder = await driver.enqueue({ ...base, input: { v: 1 }, runAt: FAR_AHEAD });
      // Two staged rows, in staged order — the outbox mints each id at stage time.
      const older = uuidV7();
      const newer = uuidV7();
      const replace = { ...base, onConflict: 'replace' as const };
      await driver.enqueue({ ...replace, id: older, input: { v: 2 }, runAt: FAR_AHEAD });
      await driver.enqueue({ ...replace, id: newer, input: { v: 3 }, runAt: LONG_AGO });
      // The relay publishing each a second time — `older` LAST, the order a lapsed relay lease
      // allows: answered as the dedupe it is, and nothing moved.
      for (const [id, v] of [
        [newer, 3],
        [older, 2],
      ] as const) {
        const repeat = await driver.enqueue({ ...replace, id, input: { v }, runAt: 1 });
        expect({ id: repeat.id, deduped: repeat.deduped }).toEqual({
          id: holder.id,
          deduped: true,
        });
      }
      const taken = await claimAll(driver, at.queue);
      expect(taken.map((row) => [row.id, row.input])).toEqual([[holder.id, { v: 3 }]]);
    },
  },
  {
    name: 'a replace published again after its holder finished inserts no second, stale run',
    async run(driver) {
      const at = scope();
      const base = { name: at.name, queue: at.queue, idempotencyKey: 'finished', maxAttempts: 3 };
      const replace = { ...base, onConflict: 'replace' as const };
      const stale = uuidV7();
      const holder = await driver.enqueue({ ...replace, input: { v: 1 }, runAt: LONG_AGO });
      const landed = uuidV7();
      await driver.enqueue({ ...replace, id: landed, input: { v: 2 }, runAt: LONG_AGO });
      const [taken] = await claimAll(driver, at.queue);
      if (taken === undefined) return expect.unreachable('the holder was claimable');
      expect(taken.input).toEqual({ v: 2 });
      expect(await driver.ack(taken.id, { workerId: 'w-debounce', claim: taken.claim })).toBe(true);
      // The landed replace, published again, and one staged before the holder was ever made.
      for (const id of [landed, stale]) {
        const repeat = await driver.enqueue({ ...replace, id, input: { v: 0 }, runAt: LONG_AGO });
        expect({ id: repeat.id, deduped: repeat.deduped }).toEqual({
          id: holder.id,
          deduped: true,
        });
      }
      expect(await claimAll(driver, at.queue)).toEqual([]);
      // A NEW request after the run is new work, as it always was.
      const fresh = await driver.enqueue({ ...replace, input: { v: 4 }, runAt: LONG_AGO });
      expect(fresh.deduped).toBe(false);
    },
  },
  {
    name: "a replace takes the newer request's expiresAt, or its absence",
    async run(driver) {
      const at = scope();
      const replace = {
        name: at.name,
        queue: at.queue,
        maxAttempts: 3,
        onConflict: 'replace' as const,
        runAt: LONG_AGO,
      };
      // Lapsed at first, then the newer request says the work is worth something until 9999.
      const revived = await driver.enqueue({ ...replace, idempotencyKey: 'a', input: { v: 1 } });
      await driver.enqueue({ ...replace, idempotencyKey: 'a', input: { v: 2 }, expiresAt: 1 });
      await driver.enqueue({
        ...replace,
        idempotencyKey: 'a',
        input: { v: 3 },
        expiresAt: FAR_AHEAD,
      });
      // Never expiring at first, then the newer request is already worthless.
      const lapsed = await driver.enqueue({ ...replace, idempotencyKey: 'b', input: { v: 1 } });
      await driver.enqueue({ ...replace, idempotencyKey: 'b', input: { v: 2 }, expiresAt: 1 });
      // A third key: an expiry, then a newer request with none at all clears it.
      const cleared = await driver.enqueue({
        ...replace,
        idempotencyKey: 'c',
        input: { v: 1 },
        expiresAt: 1,
      });
      await driver.enqueue({ ...replace, idempotencyKey: 'c', input: { v: 2 } });
      const buried: string[] = [];
      const taken = await claimAll(driver, at.queue, {
        onExhausted: (rows) => buried.push(...rows.map((row) => row.id)),
      });
      expect(taken.map((row) => row.id).sort()).toEqual([revived.id, cleared.id].sort());
      expect(buried).toEqual([lapsed.id]);
    },
  },
  {
    name: 'x jobs retry forgets an expiry: a requeued row runs instead of being buried again',
    async run(driver) {
      const requeue = driver.introspect?.requeue;
      // A driver without the operator surface has no retry to check.
      if (requeue === undefined) return;
      const at = scope();
      const { id } = await driver.enqueue({
        name: at.name,
        queue: at.queue,
        input: {},
        idempotencyKey: 'expired',
        maxAttempts: 3,
        expiresAt: LONG_AGO,
      });
      expect(await claimAll(driver, at.queue)).toEqual([]);
      await requeue(id);
      const taken = await claimAll(driver, at.queue);
      expect(taken.map((row) => row.id)).toEqual([id]);
    },
  },
  {
    name: 'x jobs retry forgets an onSettled debt: a requeued row is not re-told its old ending',
    async run(driver) {
      const requeue = driver.introspect?.requeue;
      const debt = driver.settleDebt;
      if (requeue === undefined || debt === undefined) return;
      const at = scope();
      const { id } = await driver.enqueue({
        name: at.name,
        queue: at.queue,
        input: {},
        idempotencyKey: 'owed',
        maxAttempts: 1,
      });
      const [first] = await claimAll(driver, at.queue);
      if (first === undefined) return expect.unreachable('the row was claimable');
      const by = { workerId: 'w-debounce', claim: first.claim, owesSettle: true };
      expect(await driver.ack(id, by)).toBe(true);
      await requeue(id);
      // Claimed with no lease to speak of, then buried by the next claim: an ending no settle wrote,
      // so whatever debt the row still carries is the old run's.
      await claimAll(driver, at.queue, { visibilityTimeoutMs: 0 });
      await claimAll(driver, at.queue);
      expect(await debt.takeLost([{ name: at.name, graceMs: 0 }], 10)).toEqual([]);
    },
  },
];
