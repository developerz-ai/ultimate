// A finished attempt is not a cancelled one. A body that completed and whose `ack` landed leaves
// `ctx.signal` un-aborted, so a timer it armed — a log sink's flush, a deferred enqueue — still
// writes: no other attempt owns the run. An attempt that FAILED, or whose ack did not land, still
// aborts with `X_ABORTED`: the next attempt owns the run, and a write from here lands behind it.

import { afterAll, describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { abandonment, ctxOf, runWithContext } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { ClaimedJob, JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { executeJob } from './execute';
import type { JobRunArgs } from './job';
import { job, resetJobs } from './job';

const passthrough = <T>(): StandardSchemaV1<unknown, T> => ({
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value: unknown) => ({ value: value as T }),
  },
});

/** One claimed job and the ctx its body was handed. */
async function runOnce(
  run: (args: JobRunArgs<{ n: number }>) => Promise<unknown>,
  ack?: JobDriver['ack'],
): Promise<{ readonly outcome: Promise<string>; readonly ctx: () => Ctx | undefined }> {
  resetJobs();
  let seen: Ctx | undefined;
  const handle = job<{ n: number }>({
    tenant: 'none',
    name: 'settled-signal',
    input: passthrough<{ n: number }>(),
    idempotencyKey: ({ n }) => `settled-signal:${n}`,
    retry: { attempts: 3, jitter: 'none' },
    run: (args) => {
      seen = args.ctx;
      return run(args);
    },
  });
  const base = memoryJobDriver();
  const driver: JobDriver = ack === undefined ? base : { ...base, ack };
  await driver.enqueue({
    name: 'settled-signal',
    queue: 'default',
    input: { n: 1 },
    idempotencyKey: 'settled-signal:1',
    maxAttempts: 3,
  });
  const [claimed] = await driver.claim({
    queues: ['default'],
    limit: 1,
    visibilityTimeoutMs: 30_000,
    workerId: 'worker-test',
  });
  const outcome = executeJob({
    driver,
    claimed: claimed as ClaimedJob,
    handle,
    ctx: ctxOf({ role: 'worker', buildId: 'test' }),
  }).then((execution) => execution.outcome);
  return { outcome, ctx: () => seen };
}

afterAll(() => resetJobs());

describe("unit · a settled attempt's signal", () => {
  test('a completed attempt leaves ctx.signal un-aborted: a timer it armed still writes', async () => {
    let later: (() => void) | undefined;
    const fired = new Promise<ReturnType<typeof abandonment>>((resolve) => {
      later = () => resolve(abandonment());
    });
    const { outcome, ctx } = await runOnce(async () => {
      // A flush armed by the body, firing after the attempt settled — in the body's own context.
      setTimeout(() => later?.(), 0);
    });
    expect(await outcome).toBe('completed');
    expect(ctx()?.signal.aborted).toBe(false);
    expect(await fired).toBeUndefined();
  });

  test('a step a completed body never awaited is refused as ENDED, never as cancelled', async () => {
    let forgotten: Promise<unknown> | undefined;
    // The step finishes only once the attempt has settled: released below, after the outcome.
    let release: () => void = () => undefined;
    const late = new Promise<string>((resolve) => {
      release = () => resolve('done');
    });
    const { outcome } = await runOnce(({ step }) => {
      forgotten = step.run('forgotten', () => late);
      return Promise.resolve();
    });
    expect(await outcome).toBe('completed');
    release();
    const refusal: unknown = await forgotten?.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({ code: 'X_ABORTED' });
    expect(String((refusal as { cause?: unknown }).cause)).toContain('had already ended');
    expect(String((refusal as { fix?: unknown }).fix)).toContain('runToCompletion');
  });

  test('a failed attempt still aborts with X_ABORTED: the next attempt owns the run', async () => {
    const { outcome, ctx } = await runOnce(() => Promise.reject(new TypeError('boom')));
    expect(await outcome).toBe('retried');
    const seen = ctx();
    if (seen === undefined) return expect.unreachable('the body ran');
    expect(seen.signal.aborted).toBe(true);
    expect(runWithContext(seen, () => abandonment())?.code).toBe('X_ABORTED');
  });

  test('a completed body whose ack did not land aborts: the row is somebody else’s', async () => {
    const { outcome, ctx } = await runOnce(
      () => Promise.resolve(),
      () => Promise.resolve(false),
    );
    expect(await outcome).toBe('completed');
    expect(ctx()?.signal.aborted).toBe(true);
  });

  test('a completed body whose ack threw aborts too: the lease lapses and the queue re-delivers', async () => {
    const { outcome, ctx } = await runOnce(
      () => Promise.resolve(),
      () => Promise.reject(new TypeError('connection reset')),
    );
    await expect(outcome).rejects.toThrow('connection reset');
    expect(ctx()?.signal.aborted).toBe(true);
  });
});
