// Durable compensation through the real execution path (`jobWorker` → `executeJob`) on the memory
// driver: compensators run only once the run has failed FOR GOOD, last-in first-out, once each; a
// failing one is resumed by the unwind's own attempts; a crash on the final attempt still unwinds.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import {
  ctxOf,
  frozenClock,
  isUltimateError,
  registerErrorRetry,
  UltimateError,
} from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import type { JobDriver } from './driver';
import { LEASE_LAPSED_FINAL_ATTEMPT } from './driver';
import { memoryJobDriver } from './driver-memory';
import type { JobExecution } from './execute-result';
import type { JobRunArgs } from './job';
import { job, resetJobs } from './job';
import { enqueuedAttempts } from './retry';
import type { StepApi } from './steps';
import { jobWorker } from './worker';

const context = (): Ctx => ctxOf({ role: 'worker', buildId: 'test' });
const VISIBILITY_MS = 30_000;

// Foreign failures handed to the subject: test input, never its verdict.
const SHIP_DOWN = new TypeError('the carrier is down');
const REFUND_DOWN = new TypeError('the refund api is down');
const VENDOR_SILENT = new TypeError('the payout vendor hung up');
const declined = () =>
  new UltimateError({
    code: 'X_TEST_CARD_DECLINED',
    cause: 'the card was declined',
    fix: 'x jobs retry <id>',
  });

beforeEach(() => {
  // Idempotent: another file's `resetErrorRetry` cannot leave this suite reading an empty registry.
  registerErrorRetry({ X_TEST_CARD_DECLINED: 'terminal' });
});

afterEach(() => resetJobs());

interface Saga {
  readonly driver: JobDriver;
  readonly calls: string[];
  /** One worker pass; the clock moves past any backoff first. */
  tick(): Promise<readonly JobExecution[]>;
  row(): Promise<{ state: string; lastError?: string; attempt: number }>;
  stepStatuses(): Promise<Record<string, string>>;
  readonly clock: ReturnType<typeof frozenClock>;
  readonly jobId: string;
}

async function saga(
  options: {
    readonly attempts?: number;
    readonly compensates?: boolean;
    readonly run?: (args: JobRunArgs<{ id: string }>, calls: string[]) => Promise<void>;
  } = {},
): Promise<Saga> {
  const clock = frozenClock(1_760_000_000_000);
  const driver = memoryJobDriver({ clock });
  const calls: string[] = [];
  const handle = job<{ id: string }>({
    name: 'checkout',
    tenant: 'none',
    input: t.object({ id: t.string }),
    idempotencyKey: ({ id }) => `checkout:${id}`,
    retry: { attempts: options.attempts ?? 2, backoff: 'fixed', delay: 0, jitter: 'none' },
    compensates: options.compensates ?? true,
    run: async (args) => options.run?.(args, calls),
  });
  const { id: jobId } = await driver.enqueue({
    name: handle.name,
    queue: 'default',
    input: { id: 'o-1' },
    idempotencyKey: 'checkout:o-1',
    maxAttempts: enqueuedAttempts(handle.retry, handle.compensates),
  });
  const worker = jobWorker({
    driver,
    clock,
    context,
    pollIntervalMs: 0,
    visibilityTimeoutMs: VISIBILITY_MS,
    drainOnShutdown: false,
  });
  return {
    driver,
    calls,
    clock,
    jobId,
    tick: async () => {
      clock.advance(1);
      return worker.tick();
    },
    row: async () => {
      const record = await driver.introspect?.job(jobId);
      return {
        state: record?.state ?? 'missing',
        attempt: record?.attempt ?? -1,
        ...(record?.lastError === undefined ? {} : { lastError: record.lastError }),
      };
    },
    stepStatuses: async () => {
      const record = await driver.introspect?.job(jobId);
      const steps = await driver.steps.list(record?.runId ?? '');
      return Object.fromEntries(steps.map((step) => [step.name, step.status]));
    },
  };
}

/** Charge, reserve, ship — each undone in reverse when the run fails for good. */
const checkout =
  (ship: (attempt: number) => void, refund: () => void = () => undefined) =>
  async ({ step, attempt }: JobRunArgs<{ id: string }>, calls: string[]) => {
    await step.run('charge', () => calls.push('charge') && 'ch-1', {
      compensate: (charge) => {
        refund();
        calls.push(`refund:${charge}`);
      },
    });
    await step.run('reserve', () => calls.push('reserve') && 'rs-1', {
      compensate: (reservation) => {
        calls.push(`release:${reservation}`);
      },
    });
    await step.run('ship', () => {
      calls.push('ship');
      ship(attempt);
      return 'shipped';
    });
  };

describe('compensation runs only when the run has failed for good', () => {
  test('a retryable failure on attempt 1 runs no compensator; attempt 2 succeeds', async () => {
    const run = await saga({
      run: checkout((attempt) => {
        if (attempt === 1) throw SHIP_DOWN;
      }),
    });
    expect((await run.tick())[0]?.outcome).toBe('retried');
    expect(run.calls).toEqual(['charge', 'reserve', 'ship']);
    expect((await run.tick())[0]?.outcome).toBe('completed');
    expect(run.calls).toEqual(['charge', 'reserve', 'ship', 'ship']);
    expect(Object.keys(await run.stepStatuses()).sort()).toEqual(['charge', 'reserve', 'ship']);
  });

  test('failed for good: every compensator once, last-in first-out, then the dead letter', async () => {
    const run = await saga({
      run: checkout(() => {
        throw SHIP_DOWN;
      }),
    });
    expect((await run.tick())[0]?.outcome).toBe('retried');
    const [last] = await run.tick();
    expect(last?.outcome).toBe('dead-lettered');
    expect(run.calls).toEqual(['charge', 'reserve', 'ship', 'ship', 'release:rs-1', 'refund:ch-1']);
    // The original failure stays the row's error; the unwind is visible in its steps.
    expect(await run.row()).toMatchObject({ state: 'dead' });
    expect((await run.row()).lastError).toContain('the carrier is down');
    expect(await run.stepStatuses()).toMatchObject({
      unwinding: 'completed',
      'compensate:reserve': 'completed',
      'compensate:charge': 'completed',
      ship: 'failed',
    });
    expect(await run.tick()).toEqual([]);
  });

  test('a terminal code on attempt 1 unwinds at once', async () => {
    const run = await saga({
      attempts: 3,
      run: checkout(() => {
        throw declined();
      }),
    });
    expect((await run.tick())[0]?.outcome).toBe('dead-lettered');
    expect(run.calls.slice(-2)).toEqual(['release:rs-1', 'refund:ch-1']);
  });

  test('a job without compensates enqueues with its own attempts and never unwinds', async () => {
    const run = await saga({ compensates: false, run: async () => undefined });
    const record = await run.driver.introspect?.job(run.jobId);
    expect(record?.maxAttempts).toBe(2);
  });
});

describe('a failing compensator', () => {
  test('is resumed on the next attempt; completed compensators are not re-run', async () => {
    let refunds = 0;
    const run = await saga({
      attempts: 1,
      run: checkout(
        () => {
          throw SHIP_DOWN;
        },
        () => {
          refunds += 1;
          if (refunds === 1) throw REFUND_DOWN;
        },
      ),
    });
    // Attempt 1 failed for good, released the reservation, and the refund threw: handed back.
    expect((await run.tick())[0]?.outcome).toBe('retried');
    expect(await run.row()).toMatchObject({ state: 'ready' });
    expect((await run.row()).lastError).toContain('the carrier is down');
    // Attempt 2 is past the policy: it replays to the first incomplete step, then unwinds.
    expect((await run.tick())[0]?.outcome).toBe('dead-lettered');
    expect(run.calls).toEqual(['charge', 'reserve', 'ship', 'release:rs-1', 'refund:ch-1']);
    expect((await run.row()).lastError).toContain('the carrier is down');
  });

  test('past the unwind attempts it is dead with X_JOB_COMPENSATION_FAILED naming the step', async () => {
    const run = await saga({
      attempts: 1,
      run: checkout(
        () => {
          throw SHIP_DOWN;
        },
        () => {
          throw REFUND_DOWN;
        },
      ),
    });
    const outcomes: string[] = [];
    for (let pass = 0; pass < 5; pass += 1) {
      for (const execution of await run.tick()) outcomes.push(execution.outcome);
    }
    expect(outcomes).toEqual(['retried', 'retried', 'dead-lettered']);
    const { state, lastError } = await run.row();
    expect(state).toBe('dead');
    expect(lastError).toContain('X_JOB_COMPENSATION_FAILED');
    expect(lastError).toContain('"charge"');
    // The reservation was released once: its completed compensator replayed on every attempt.
    expect(run.calls.filter((call) => call.startsWith('release'))).toEqual(['release:rs-1']);
  });
});

describe('a crash on the final attempt still unwinds', () => {
  test('the lapsed lease is re-offered, the unwind runs, and the row ends dead', async () => {
    const run = await saga({ attempts: 1, run: checkout(() => undefined) });
    // The worker dies holding attempt 1: its body never settles, its lease lapses.
    const claimed = await run.driver.claim({
      queues: ['default'],
      limit: 1,
      visibilityTimeoutMs: VISIBILITY_MS,
      workerId: 'dead-worker',
    });
    expect(claimed[0]?.attempt).toBe(1);
    await run.driver.steps.put({
      runId: claimed[0]?.runId ?? '',
      name: 'charge',
      status: 'completed',
      output: 'ch-1',
      startedAt: 1,
      attempts: 1,
    });
    run.clock.advance(VISIBILITY_MS + 1);
    const [unwound] = await run.tick();
    expect(unwound?.attempt).toBe(2);
    expect(unwound?.outcome).toBe('dead-lettered');
    // Replayed to the first incomplete step (`reserve`), which never ran: only `charge` undone.
    expect(run.calls).toEqual(['refund:ch-1']);
    expect(await run.row()).toMatchObject({ state: 'dead', lastError: LEASE_LAPSED_FINAL_ATTEMPT });
  });

  test('a lapse on every unwind attempt buries the row, with unwinding visible', async () => {
    const run = await saga({ attempts: 1 });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const [held] = await run.driver.claim({
        queues: ['default'],
        limit: 1,
        visibilityTimeoutMs: VISIBILITY_MS,
        workerId: `dying-${attempt}`,
      });
      expect(held?.attempt).toBe(attempt);
      if (attempt === 2) {
        await run.driver.steps.put({
          runId: held?.runId ?? '',
          name: 'unwinding',
          status: 'completed',
          output: { error: LEASE_LAPSED_FINAL_ATTEMPT },
          startedAt: 1,
          attempts: 1,
        });
      }
      run.clock.advance(VISIBILITY_MS + 1);
    }
    expect(await run.tick()).toEqual([]);
    expect(await run.row()).toMatchObject({ state: 'dead' });
    expect(await run.stepStatuses()).toMatchObject({ unwinding: 'completed' });
  });
});

describe('x jobs retry of an unwound run continues the unwind, never the forward path', () => {
  test('the requeued run replays its compensators and dies again without shipping', async () => {
    const run = await saga({
      attempts: 1,
      run: checkout(() => {
        throw SHIP_DOWN;
      }),
    });
    expect((await run.tick())[0]?.outcome).toBe('dead-lettered');
    await run.driver.introspect?.requeue(run.jobId);
    expect((await run.tick())[0]?.outcome).toBe('dead-lettered');
    expect(run.calls.filter((call) => call === 'ship')).toEqual(['ship']);
    expect(run.calls.filter((call) => call.startsWith('refund'))).toEqual(['refund:ch-1']);
  });
});

describe('the names compensation writes are reserved', () => {
  const refused = async (body: (step: StepApi) => Promise<unknown>): Promise<unknown> => {
    let thrown: unknown;
    const run = await saga({
      compensates: false,
      attempts: 3,
      run: async ({ step }) => {
        try {
          await body(step);
        } catch (error) {
          thrown = error;
          throw error;
        }
      },
    });
    // Terminal: the declaration is the same on every attempt.
    expect((await run.tick())[0]?.outcome).toBe('dead-lettered');
    return thrown;
  };

  for (const [label, body] of [
    ['run unwinding', (step) => step.run('unwinding', () => 1)],
    ['run compensate:x', (step) => step.run('compensate:x', () => 1)],
    ['sleep unwinding', (step) => step.sleep('unwinding', '1s')],
    [
      'waitForEvent compensate:y',
      (step) => step.waitForEvent('compensate:y', 'e', { schema: t.object({}) }),
    ],
  ] as const satisfies readonly (readonly [string, (step: StepApi) => Promise<unknown>])[]) {
    test(`step.${label} is X_JOB_DECLARATION_INVALID`, async () => {
      const error = await refused(body);
      expect(isUltimateError(error) && error.code).toBe('X_JOB_DECLARATION_INVALID');
    });
  }

  test('compensate on a job without compensates: true is refused at the call', async () => {
    const error = await refused((step) =>
      step.run('charge', () => 1, { compensate: () => undefined }),
    );
    expect(isUltimateError(error) && error.code).toBe('X_JOB_DECLARATION_INVALID');
    expect(isUltimateError(error) && error.fix).toContain('compensates: true');
  });
});

describe('an unknown once step with a compensator stops the unwind', () => {
  test('dead at once with both named: undoing what may not have happened is a person call', async () => {
    const run = await saga({
      attempts: 3,
      run: async ({ step }, calls) => {
        await step.run('charge', () => 'ch-1', {
          compensate: () => {
            calls.push('refund');
          },
        });
        await step.run(
          'payout',
          () => {
            throw VENDOR_SILENT;
          },
          { once: true, compensate: () => calls.push('claw-back') },
        );
      },
    });
    // Attempt 1: the vendor call threw — retried, as any failure is.
    expect((await run.tick())[0]?.outcome).toBe('retried');
    // Attempt 2: the once step is unknown (terminal), and its compensator cannot be run blind.
    expect((await run.tick())[0]?.outcome).toBe('dead-lettered');
    expect(run.calls).toEqual([]);
    const { lastError } = await run.row();
    expect(lastError).toContain('X_JOB_COMPENSATION_FAILED');
    expect(lastError).toContain('X_STEP_OUTCOME_UNKNOWN');
    expect(lastError).toContain('"payout"');

    // A person resolves it (did not run), retries: the unwind skips it and refunds the charge.
    await run.driver.introspect?.resolveStep?.(run.jobId, 'payout', { ran: false });
    await run.driver.introspect?.requeue(run.jobId);
    expect((await run.tick())[0]?.outcome).toBe('dead-lettered');
    expect(run.calls).toEqual(['refund']);
  });
});
