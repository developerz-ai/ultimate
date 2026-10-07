// The keyed-concurrency scenarios, written ONCE over a harness and run twice: on the memory driver
// (`keyed-concurrency.test.ts`, an injected clock) and on the pg driver against a real Postgres
// (`keyed-concurrency.job.test.ts`, the database's own clock). Two workers, one shared store, and
// every interleaving a keyed cap can get wrong — the failure case first in each.

import { expect, test } from 'bun:test';
import type { Clock, Ctx } from '@ultimat3/core';
import { ctxOf } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { KeyedConcurrency } from './concurrency';
import type { JobDriver, JobRecord } from './driver';
import type { JobHandle, JobRunArgs } from './job';
import { job } from './job';
import { jobLeaseKey } from './leases';
import type { RetryPolicy } from './retry';
import type { Worker } from './worker';
import { jobWorker } from './worker';

export interface KeyedHarness {
  /** The ONE store both workers of a scenario share, empty at the start of each test. */
  driver(): Promise<JobDriver>;
  /** Time passing as the queue and the lease table see it. Nothing is cleaned up by this. */
  elapse(driver: JobDriver, ms: number): Promise<void>;
  /** The clock the workers read, when the harness injects one. */
  readonly clock?: Clock;
}

export interface AccountInput {
  readonly account: string;
}

/** How long a claim and a slot live. Short, because the pg harness can only wait it out. */
export const TTL_MS = 30_000;

const context = (): Ctx => ctxOf({ role: 'worker', buildId: 'test' });

export function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

interface Gate {
  readonly passed: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open = (): void => undefined;
  const passed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { passed, open: () => open() };
}

export interface Probe {
  readonly handle: JobHandle<AccountInput>;
  /** Bodies running right now, and the most that ever ran at once. */
  active(): number;
  peak(): number;
  /** Every body invocation, in order: the account and what the body was handed. */
  readonly calls: { readonly account: string; readonly finalAttempt: boolean }[];
  /** Resolves when `count` bodies have STARTED. */
  started(count: number): Promise<void>;
  /** Lets every held body finish, now and from here on. */
  release(): void;
}

let minted = 0;

/** A keyed job whose body parks until released, counting what ran beside what. */
export function accountJob(options: {
  readonly concurrency?: KeyedConcurrency<AccountInput> | number;
  readonly retry?: RetryPolicy;
  readonly hold?: boolean;
  readonly body?: (args: JobRunArgs<AccountInput>) => Promise<unknown>;
}): Probe {
  minted += 1;
  let active = 0;
  let peak = 0;
  let open = options.hold !== true;
  const hold = gate();
  const calls: Probe['calls'] = [];
  const waiters: { readonly count: number; readonly resolve: () => void }[] = [];
  const handle = job<AccountInput>({
    name: `keyed-account-${minted}`,
    tenant: 'none',
    input: passthrough<AccountInput>(),
    idempotencyKey: ({ account }) => `account:${account}`,
    retry: options.retry ?? { attempts: 1, jitter: false },
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    async run(args) {
      calls.push({ account: args.input.account, finalAttempt: args.finalAttempt });
      active += 1;
      peak = Math.max(peak, active);
      for (const waiter of waiters) if (calls.length >= waiter.count) waiter.resolve();
      try {
        if (!open) await hold.passed;
        await options.body?.(args);
      } finally {
        active -= 1;
      }
    },
  });
  return {
    handle,
    active: () => active,
    peak: () => peak,
    calls,
    started: (count) =>
      calls.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push({ count, resolve });
          }),
    release() {
      open = true;
      hold.open();
    },
  };
}

export function workerOn(harness: KeyedHarness, driver: JobDriver, workerId: string): Worker {
  return jobWorker({
    driver,
    workerId,
    // One slot each, so two workers claiming "at the same instant" take one run apiece.
    concurrency: 1,
    visibilityTimeoutMs: TTL_MS,
    // Never fires inside a test: a held run's slot is renewed by nothing, which is what a
    // killed worker looks like to the lease table.
    heartbeatIntervalMs: 3_600_000,
    pollIntervalMs: 0,
    context,
    drainOnShutdown: false,
    ...(harness.clock === undefined ? {} : { clock: harness.clock }),
  });
}

let enqueued = 0;

/** Straight onto the driver, each with its own idempotency key — two runs of ONE account. */
export async function enqueueRun(
  driver: JobDriver,
  probe: Probe,
  account: string,
): Promise<string> {
  enqueued += 1;
  const result = await driver.enqueue({
    name: probe.handle.name,
    queue: 'default',
    input: { account },
    idempotencyKey: `run:${enqueued}`,
    maxAttempts: probe.handle.retry.attempts,
  });
  return result.id;
}

export async function rowOf(driver: JobDriver, id: string): Promise<JobRecord> {
  const row = await driver.introspect?.job(id);
  if (row === undefined) return expect.unreachable(`no job ${id} in the ${driver.name} driver`);
  return row;
}

const keyed = (whenBusy?: 'wait' | 'fail'): KeyedConcurrency<AccountInput> => ({
  key: ({ account }) => account,
  limit: 1,
  ...(whenBusy === undefined ? {} : { whenBusy }),
});

/** The scenarios. Each registers under `label` so a red one names the driver it is red on. */
export function keyedConcurrencyScenarios(label: string, harness: KeyedHarness): void {
  test(`${label}: two workers claiming two runs of one key at the same instant never overlap`, async () => {
    const driver = await harness.driver();
    const probe = accountJob({ concurrency: keyed(), hold: true });
    const first = await enqueueRun(driver, probe, 'acct-1');
    const second = await enqueueRun(driver, probe, 'acct-1');
    const a = workerOn(harness, driver, 'worker-a');
    const b = workerOn(harness, driver, 'worker-b');

    const ticks = [a.tick(), b.tick()];
    await probe.started(1);
    // Both claims have settled their slot question by the time either tick can resolve: the
    // loser was handed back, the winner is parked in its body.
    const waiting = await Promise.race(ticks);
    expect(waiting).toEqual([]);
    expect(probe.active()).toBe(1);

    // `'wait'`: the run that lost the key is still claimable and has burned NO attempt.
    const rows = [await rowOf(driver, first), await rowOf(driver, second)];
    const lost = rows.find((row) => row.state !== 'running');
    expect(lost?.state).toBe('ready');
    expect(lost?.attempt).toBe(0);
    expect(lost?.lastError).toBeUndefined();

    probe.release();
    await Promise.all(ticks);
    // The slot is free again, so the next pass runs the one that waited.
    await harness.elapse(driver, 1);
    const rest = [...(await a.tick()), ...(await b.tick())];
    expect(rest.map((execution) => execution.outcome)).toEqual(['completed']);
    expect(probe.peak()).toBe(1);
    expect(probe.calls.map((call) => call.account)).toEqual(['acct-1', 'acct-1']);
  });

  test(`${label}: different keys run together`, async () => {
    const driver = await harness.driver();
    const probe = accountJob({ concurrency: keyed(), hold: true });
    await enqueueRun(driver, probe, 'acct-1');
    await enqueueRun(driver, probe, 'acct-2');
    const a = workerOn(harness, driver, 'worker-a');
    const b = workerOn(harness, driver, 'worker-b');

    const ticks = [a.tick(), b.tick()];
    await probe.started(2);
    expect(probe.active()).toBe(2);
    probe.release();
    const done = (await Promise.all(ticks)).flat();
    expect(done.map((execution) => execution.outcome)).toEqual(['completed', 'completed']);
  });

  test(`${label}: whenBusy 'fail' settles the second run failed, without running its body`, async () => {
    const driver = await harness.driver();
    const probe = accountJob({
      concurrency: keyed('fail'),
      hold: true,
      retry: { attempts: 3, jitter: false, delay: 1 },
    });
    await enqueueRun(driver, probe, 'acct-1');
    const second = await enqueueRun(driver, probe, 'acct-1');
    const a = workerOn(harness, driver, 'worker-a');
    const b = workerOn(harness, driver, 'worker-b');

    const holding = a.tick();
    await probe.started(1);
    const refused = await b.tick();

    expect(refused.map((execution) => execution.outcome)).toEqual(['refused']);
    expect(refused[0]?.error).toContain('X_JOB_KEY_BUSY');
    const row = await rowOf(driver, second);
    expect(row.state).toBe('failed');
    expect(row.lastError).toContain('X_JOB_KEY_BUSY');
    expect(row.lastError).toContain(`x jobs ls --name ${probe.handle.name} --state running --json`);
    // No attempt ran, so none is counted — and three were allowed: it is not a retryable failure.
    expect(row.attempt).toBe(0);
    expect(await driver.introspect?.deadLetters()).toEqual([]);
    expect((await b.stats()).refused).toBe(1);
    expect((await b.stats()).deadLettered).toBe(0);

    probe.release();
    await holding;
    // Terminal: with the key free again and time passed, nothing claims the refused run.
    await harness.elapse(driver, 5_000);
    expect([...(await a.tick()), ...(await b.tick())]).toEqual([]);
    expect((await rowOf(driver, second)).state).toBe('failed');
    expect(probe.calls).toHaveLength(1);
  });

  test(`${label}: a holder that dies frees its key by lease expiry, with no cleanup call`, async () => {
    const driver = await harness.driver();
    // Two attempts: the orphaned run is re-delivered, where a lease that lapsed on a row's LAST
    // attempt is buried by the claim and would leave the key with nobody to take it.
    const probe = accountJob({
      concurrency: keyed(),
      hold: true,
      retry: { attempts: 2, jitter: false },
    });
    await enqueueRun(driver, probe, 'acct-1');
    await enqueueRun(driver, probe, 'acct-1');
    const dead = workerOn(harness, driver, 'worker-dead');
    const next = workerOn(harness, driver, 'worker-next');
    const leaseKey = jobLeaseKey(probe.handle.name, 'acct-1');

    // `dead` claims a run, takes the key and never renews, releases or settles: a SIGKILL.
    const orphaned = dead.tick();
    await probe.started(1);
    expect(await driver.leases?.held(leaseKey)).toBe(1);

    // Inside the TTL the key is still held, so the survivor waits.
    await harness.elapse(driver, TTL_MS / 2);
    expect(await next.tick()).toEqual([]);
    expect(probe.calls).toHaveLength(1);

    // Past it, nothing was cleaned up — and the survivor takes the key.
    await harness.elapse(driver, TTL_MS);
    const taking = next.tick();
    await probe.started(2);
    expect(await driver.leases?.holders(leaseKey)).toEqual([
      expect.stringMatching(/^worker-next:/),
    ]);

    probe.release();
    await Promise.all([orphaned, taking]);
  });

  test(`${label}: under 'fail', a redelivered run is never failed by its own leftover slot`, async () => {
    const driver = await harness.driver();
    const probe = accountJob({ concurrency: keyed('fail') });
    const id = await enqueueRun(driver, probe, 'acct-1');
    const leaseKey = jobLeaseKey(probe.handle.name, 'acct-1');
    // The slot the run's previous claim took, still live: released a moment after a nack and
    // expiring a moment after the job's own lease, it is what a redelivery finds.
    const leftover = await driver.leases?.acquire(leaseKey, 1, TTL_MS, `worker-gone:${id}`);
    expect(leftover).toBeDefined();
    const worker = workerOn(harness, driver, 'worker-a');

    expect(await worker.tick()).toEqual([]);
    const row = await rowOf(driver, id);
    expect(row.state).toBe('ready');
    expect(row.attempt).toBe(0);

    // The leftover lapses like any slot, and the same run then takes the key and runs.
    await harness.elapse(driver, TTL_MS + 1_000);
    expect((await worker.tick()).map((execution) => execution.outcome)).toEqual(['completed']);
    expect(probe.calls).toHaveLength(1);
  });
}
