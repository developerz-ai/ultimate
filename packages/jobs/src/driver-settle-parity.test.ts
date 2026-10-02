// The same question `driver-parity.test.ts` asks, for the two answers that changed here: a refused
// enqueue and a cancelled row. Split into its own file because that one is at the 500-line ceiling
// the `filesize` step enforces — one question, two files, never two answers.
//
// Each case asserts the memory driver's BEHAVIOUR and the pg statement that has to mean the same
// thing, in one test, so neither side can move alone: `driver-memory.ts` is what `x dev` and every
// test in this repo run against, and `driver-pg.ts` is what production runs against.

import { describe, expect, test } from 'bun:test';
import type { JobDriver, NackOptions } from './driver';
import { nackState } from './driver';
import { createMemoryDriver } from './driver-memory';
import type { PgExecutor } from './driver-pg';
import { createPgDriver } from './driver-pg';
import { SQL_CANCEL, SQL_NACK } from './driver-pg-sql';

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

describe('a nack that FAILS the row files it `failed`, in both', () => {
  /**
   * `fail: true` is the terminal state that is not a dead letter — `whenBusy: 'fail'` over a busy
   * concurrency key. Each driver wrote the state out as its own three-way, so a fourth branch
   * could land in one and not the other: a `fail` the pg driver read as `ready` re-claims a
   * refused run forever, while every test here — on the memory driver — stays green.
   */
  const refused: NackOptions = {
    workerId: 'w1',
    claim: 1,
    delayMs: 0,
    error: 'X_JOB_KEY_BUSY',
    countsAsAttempt: false,
    fail: true,
  };

  test('the memory driver settles it failed, uncounted, unclaimable and out of the dead letters', async () => {
    const driver = createMemoryDriver();
    const { id } = await driver.enqueue({
      name: 'refused',
      queue: 'default',
      input: {},
      idempotencyKey: 'refused:1',
      maxAttempts: 3,
    });
    await claimOne(driver);
    await driver.nack(id, refused);

    const row = await driver.introspect?.job(id);
    expect(row?.state).toBe('failed');
    expect(row?.attempt).toBe(0);
    expect(row?.claimedBy).toBeUndefined();
    expect(await claimOne(driver)).toEqual([]);
    expect(await driver.introspect?.deadLetters()).toEqual([]);
  });

  test('the pg driver binds the same state into SQL_NACK', async () => {
    const calls: { readonly text: string; readonly params: readonly unknown[] }[] = [];
    const executor: PgExecutor = {
      query: <R>(text: string, params: readonly unknown[]): Promise<readonly R[]> => {
        calls.push({ text, params });
        return Promise.resolve([]);
      },
    };
    await createPgDriver({ executor }).nack('job-1', refused);

    expect(calls).toEqual([
      {
        text: SQL_NACK,
        // id, state, counted, delay, error, the CLAIMER, stack, then retried/failed/dead, the
        // duration and the CLAIM: a refusal is one `failed` in its job's bucket, written by the
        // same statement.
        params: ['job-1', 'failed', false, 0, 'X_JOB_KEY_BUSY', 'w1', null, 0, 1, 0, 0, 1],
      },
    ]);
  });

  test('one reading decides every nack: dead letter over fail, fail over park, else ready', () => {
    expect(
      nackState({ workerId: 'w1', claim: 1, delayMs: 0, deadLetter: true, fail: true, park: true }),
    ).toBe('dead');
    expect(nackState({ workerId: 'w1', claim: 1, delayMs: 0, fail: true, park: true })).toBe(
      'failed',
    );
    expect(nackState({ workerId: 'w1', claim: 1, delayMs: 0, park: true })).toBe('suspended');
    expect(nackState({ workerId: 'w1', claim: 1, delayMs: 0 })).toBe('ready');
  });
});

describe('a queued payload is what JSON carries, in both', () => {
  /**
   * The pg driver binds `JSON.stringify(request.input ?? null)`, so a queued payload is a JSON
   * value by construction. The memory driver kept the LIVE object: a `Date` stayed a `Date`, an
   * `undefined` member stayed a key, and a non-enumerable property — a `.sealed()` entity column
   * on a row handed in as input — stayed readable. A job reading any of them passed on memory and
   * failed on Postgres, which is the one divergence a test suite on the memory driver cannot see.
   */
  const live = (): Record<string, unknown> => {
    const input: Record<string, unknown> = {
      at: new Date('2026-10-01T00:00:00.000Z'),
      missing: undefined,
      nested: { keep: 1, drop: undefined },
    };
    Object.defineProperty(input, 'sealed', { value: 'ciphertext', enumerable: false });
    return input;
  };
  const stored = { at: '2026-10-01T00:00:00.000Z', nested: { keep: 1 } };

  test('the memory driver stores the JSON form, and hands that to the claim', async () => {
    const driver = createMemoryDriver();
    const input = live();
    const { id } = await driver.enqueue({
      name: 'payload',
      queue: 'default',
      input,
      idempotencyKey: 'payload:1',
      maxAttempts: 1,
    });
    // Mutating the caller's object after the enqueue must not reach the queued row either.
    input['at'] = 'mutated';

    expect((await driver.introspect?.job(id))?.input).toEqual(stored);
    const [claimed] = (await claimOne(driver)) as readonly { input: unknown }[];
    expect(claimed?.input).toEqual(stored);
    expect(Object.hasOwn(claimed?.input as object, 'sealed')).toBe(false);
    expect(Object.hasOwn(claimed?.input as object, 'missing')).toBe(false);
  });

  test('the pg driver binds the same JSON text', async () => {
    const calls: (readonly unknown[])[] = [];
    const executor: PgExecutor = {
      query: <R>(_text: string, params: readonly unknown[]): Promise<readonly R[]> => {
        calls.push(params);
        return Promise.resolve([{ id: 'job-1', run_id: 'run-1' }] as R[]);
      },
    };
    await createPgDriver({ executor }).enqueue({
      name: 'payload',
      queue: 'default',
      input: live(),
      idempotencyKey: 'payload:1',
      maxAttempts: 1,
    });

    expect(JSON.parse(String(calls[0]?.[3]))).toEqual(stored);
  });

  test('an absent payload is JSON null in both, never undefined', async () => {
    const driver = createMemoryDriver();
    const { id } = await driver.enqueue({
      name: 'payload',
      queue: 'default',
      input: undefined,
      idempotencyKey: 'payload:none',
      maxAttempts: 1,
    });
    expect((await driver.introspect?.job(id))?.input).toBeNull();
  });
});
