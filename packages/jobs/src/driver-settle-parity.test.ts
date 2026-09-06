// The same question `driver-parity.test.ts` asks, for the two answers that changed here: a refused
// enqueue and a cancelled row. Split into its own file because that one is at the 500-line ceiling
// the `filesize` step enforces — one question, two files, never two answers.
//
// Each case asserts the memory driver's BEHAVIOUR and the pg statement that has to mean the same
// thing, in one test, so neither side can move alone: `driver-memory.ts` is what `x dev` and every
// test in this repo run against, and `driver-pg.ts` is what production runs against.

import { describe, expect, test } from 'bun:test';
import type { JobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import type { PgExecutor } from './driver-pg';
import { createPgDriver } from './driver-pg';
import { SQL_CANCEL } from './driver-pg-sql';

const claimOne = (driver: JobDriver): Promise<unknown> =>
  driver.claim({ queues: ['default'], limit: 1, visibilityTimeoutMs: 30_000, workerId: 'w1' });

describe('a refused enqueue REJECTS, in both', () => {
  /**
   * The divergence: `onConflict: 'error'` threw SYNCHRONOUSLY out of the memory driver's
   * `enqueue`, a method typed `Promise<EnqueueResult>`, where the pg driver's `async enqueue`
   * rejects. Two shapes caught by different code — a caller holding the promise and attaching
   * `.catch` on the next line never sees the sync throw, and a `void`-ed enqueue ends the Bun
   * process instead of settling. Exactly the divergence `claim({ queues: [] })` already carries a
   * rule for in this package's CLAUDE.md, one method along.
   */
  const duplicate = {
    name: 'duplicated',
    queue: 'default',
    input: {},
    idempotencyKey: 'duplicated:1',
    maxAttempts: 3,
    onConflict: 'error',
  } as const;

  test('the memory driver hands back a rejecting promise rather than throwing', async () => {
    const driver = createMemoryDriver();
    await driver.enqueue(duplicate);

    let pending: Promise<unknown> | undefined;
    let raised: unknown;
    try {
      pending = driver.enqueue(duplicate);
    } catch (error) {
      raised = error;
    }
    // The whole assertion: nothing left this call by the throwing path.
    expect(raised).toBeUndefined();
    if (pending === undefined) expect.unreachable('the memory driver threw instead of rejecting');
    await expect(pending).rejects.toThrow(/X_JOB_DUPLICATE/);
  });

  test('the pg driver refuses the same duplicate the same way', async () => {
    // `enqueue` inserts, reads back nothing on a conflict, then looks the live row up; the
    // executor answers that shape so the duplicate branch is the one under test.
    const executor: PgExecutor = {
      query: <R>(text: string): Promise<readonly R[]> =>
        Promise.resolve(
          (text.includes('insert') ? [] : [{ id: 'existing', run_id: 'run-existing' }]) as R[],
        ),
    };
    await expect(createPgDriver({ executor }).enqueue(duplicate)).rejects.toThrow(
      /X_JOB_DUPLICATE/,
    );
  });
});

describe('a cancelled job holds no lease either', () => {
  /**
   * `SQL_CANCEL` writes `visible_at = null, claimed_by = null` beside the state; the memory driver
   * patched `state` alone, so a cancelled row went on naming the worker that was running it and
   * carrying that attempt's lease deadline — the pair `x jobs show` prints, and the pair the claim
   * scan's lease-expiry branch reads to decide a row was abandoned. The defect `ack` and `nack`
   * were fixed for, one settle later.
   */
  test('cancel clears the lease the claim stamped, as SQL_CANCEL does', async () => {
    const driver = createMemoryDriver();
    const { id } = await driver.enqueue({
      name: 'runaway',
      queue: 'default',
      input: {},
      idempotencyKey: 'runaway:1',
      maxAttempts: 3,
    });
    await claimOne(driver);
    // The claim is what stamps them, so the test is only meaningful if it did.
    const introspect = driver.introspect;
    const claimed = await introspect?.job(id);
    expect(claimed?.claimedBy).toBe('w1');
    expect(typeof claimed?.visibleAt).toBe('number');

    // `cancel` is OPTIONAL on `JobIntrospection` — a driver may have no way to address one row —
    // and the memory driver is one that ships it. Asserted rather than optional-called: a `?.()`
    // that answered `undefined` would read here as a cancel that did nothing.
    if (introspect?.cancel === undefined) {
      expect.unreachable('the memory driver ships introspect.cancel');
    }
    const cancelled = await introspect.cancel(id, 'x jobs cancel');

    expect(cancelled?.state).toBe('cancelled');
    expect(cancelled?.lastError).toBe('x jobs cancel');
    expect(cancelled?.claimedBy).toBeUndefined();
    expect(cancelled?.visibleAt).toBeUndefined();
    // The pg half, in the same test, so neither side can move alone.
    expect(SQL_CANCEL).toContain('visible_at = null');
    expect(SQL_CANCEL).toContain('claimed_by = null');
  });
});
