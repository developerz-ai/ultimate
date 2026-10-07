// What `runJobs` says about ONE run beyond its steps: what the body returned, and who it ran as.
// A body that answers `{ skipped: true }` used to be observable only as "one step ran", and the
// worker was always core's anonymous actor — so a body that re-authorises its caller, or one whose
// enqueue is namespaced by tenant, had no test that could tell right from wrong.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { type Actor, assert, serviceActor, useContext } from '@ultimat3/core';
import {
  cancelJob,
  eventBus,
  type JobHandle,
  job,
  jobDriver,
  MAX_JOB_PAGE,
  publishEvent,
  resetJobDriver,
  t,
} from '@ultimat3/jobs';
import { advanceClock } from './determinism';
import { type RunJobs, testJobs } from './fixture-jobs';
import { testName } from './test-types';

interface Input {
  readonly id: string;
  readonly orgId: string;
}

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a2';

let minted = 0;
/** A job named uniquely per call: the registry is process-global and refuses a second seat. */
const declare = (
  tenant: 'none' | ((input: Input) => string),
  run: (input: Input) => unknown,
): JobHandle<Input> => {
  minted += 1;
  return job<Input>({
    name: `fixture-jobs-${String(minted)}`,
    input: t.object({ id: t.string, orgId: t.string }),
    tenant,
    idempotencyKey: (input) => `k:${input.id}`,
    retry: { attempts: 1, jitter: false },
    run: async ({ input }) => run(input),
  });
};

let runJobs: RunJobs | undefined;
const worker = async (): Promise<RunJobs> => {
  runJobs = await testJobs();
  return runJobs;
};

// `testJobs()` by hand is not disposed for anyone: hand the ambient driver back per test.
afterEach(async () => {
  await runJobs?.[Symbol.asyncDispose]();
  runJobs = undefined;
  resetJobDriver();
});

describe(testName('unit', "runJobs: the body's return value is on the trace"), () => {
  test('a completed run carries what its body returned', async () => {
    const skipping = declare('none', () => ({ skipped: true }));
    const trace = await (await worker())(skipping, { id: 'a', orgId: ORG });
    expect(trace.executions.map((run) => run.outcome)).toEqual(['completed']);
    expect(trace.executions[0]?.result).toEqual({ skipped: true });
  });

  test('a body that returns nothing has a result key holding undefined', async () => {
    const silent = declare('none', () => undefined);
    const [run] = (await (await worker())(silent, { id: 'a', orgId: ORG })).executions;
    expect(run !== undefined && 'result' in run).toBe(true);
    expect(run?.result).toBeUndefined();
  });

  test('a run that did not complete carries no result at all', async () => {
    const failing = declare('none', () => {
      assert(false, 'refused on purpose', 'nothing — this is a fixture');
    });
    const [run] = (await (await worker())(failing, { id: 'a', orgId: ORG })).executions;
    expect(run?.outcome).not.toBe('completed');
    expect(run !== undefined && 'result' in run).toBe(false);
  });

  test('the trace is cumulative: each run keeps its own result', async () => {
    const echo = declare('none', (input) => input.id);
    const jobs = await worker();
    await jobs(echo, { id: 'first', orgId: ORG });
    const trace = await jobs(echo, { id: 'second', orgId: ORG });
    expect(trace.executions.map((run) => run.result)).toEqual(['first', 'second']);
  });
});

describe(testName('unit', 'runJobs: the worker runs as the actor a test names'), () => {
  const seen: Actor[] = [];
  const whoAmI = (tenant: 'none' | ((input: Input) => string)): JobHandle<Input> =>
    declare(tenant, () => {
      seen.push(useContext().actor);
    });
  const robot = serviceActor({ id: 'billing-worker', orgId: OTHER_ORG, scopes: ['billing:run'] });

  test('with none named, the body runs as the anonymous worker under its declared tenant', async () => {
    seen.length = 0;
    await (await worker())(
      whoAmI((input) => input.orgId),
      { id: 'a', orgId: ORG },
    );
    expect(seen.map((actor) => [actor.kind, actor.orgId])).toEqual([['anonymous', ORG]]);
  });

  test('a named actor is who the body runs as — and the ORG is still the job’s own', async () => {
    seen.length = 0;
    const jobs = await worker();
    await jobs(
      whoAmI((input) => input.orgId),
      { id: 'a', orgId: ORG },
      { actor: robot },
    );
    // The identity is the worker's; the tenant is a fact about the WORK (`jobRunActor`), so the
    // org the actor arrived with never reaches the body.
    expect(seen.map((actor) => [actor.id, actor.orgId, actor.scopes])).toEqual([
      ['billing-worker', ORG, ['billing:run']],
    ]);
  });

  test("tenant: 'none' strips the named actor’s org rather than inheriting it", async () => {
    seen.length = 0;
    await (await worker())(whoAmI('none'), { id: 'a', orgId: ORG }, { actor: robot });
    expect(seen.map((actor) => [actor.id, actor.orgId])).toEqual([['billing-worker', undefined]]);
  });

  test('drain({ actor }) runs what an earlier enqueue queued, as that actor', async () => {
    seen.length = 0;
    const jobs = await worker();
    await jobs.enqueue(whoAmI('none'), { id: 'a', orgId: ORG });
    await jobs.drain({ actor: robot });
    expect(seen.map((actor) => actor.id)).toEqual(['billing-worker']);
  });
});

describe(testName('unit', 'runJobs: the enqueuer’s tenant is on the row'), () => {
  const rows = async (name: string) => {
    const introspect = jobDriver()?.introspect;
    if (introspect === undefined) return expect.unreachable('the memory driver introspects');
    return introspect.list({ limit: MAX_JOB_PAGE, name });
  };

  test('tenantId files the row under that tenant, as handle.as(actor, input) does', async () => {
    const handle = declare('none', () => undefined);
    const jobs = await worker();
    await jobs.enqueue(handle, { id: 'a', orgId: ORG }, { tenantId: ORG });
    expect((await rows(handle.name)).map((row) => row.tenantId)).toEqual([ORG]);
  });

  test('one idempotency key in two tenants is two jobs; in one tenant it is one', async () => {
    const handle = declare('none', () => undefined);
    const jobs = await worker();
    const first = await jobs.enqueue(handle, { id: 'a', orgId: ORG }, { tenantId: ORG });
    const again = await jobs.enqueue(handle, { id: 'a', orgId: ORG }, { tenantId: ORG });
    const other = await jobs.enqueue(handle, { id: 'a', orgId: ORG }, { tenantId: OTHER_ORG });
    expect(again).toEqual({ ...first, deduped: true });
    expect(other.deduped).toBe(false);
    expect(await jobs.depth(handle)).toBe(2);
  });
});

describe(testName('unit', 'runJobs: each fixture has its own event bus'), () => {
  // The ambient bus is process-global and STORES what it is handed, so an answer one test
  // published was still there for the next test's `step.waitForEvent` — which then resumed on it.
  test('an event published under one fixture is not there for the next', async () => {
    const before = eventBus();
    const first = await testJobs();
    expect(eventBus()).not.toBe(before);
    await publishEvent('prompt.answered', { answer: 'yes' }, { correlationKey: 'run-1' });
    expect(eventBus().size()).toBe(1);
    await first[Symbol.asyncDispose]();
    // Handed back: the bus the process had, not a second fresh one and not the fixture's.
    expect(eventBus()).toBe(before);

    const second = await worker();
    expect(eventBus().size()).toBe(0);
    expect(await eventBus().list('prompt.answered')).toEqual([]);
    expect(second).toBeDefined();
  });

  test('a driver whose close() throws still hands back the bus and the driver', async () => {
    const busBefore = eventBus();
    const driverBefore = jobDriver();
    const fixture = await testJobs();
    const installed = jobDriver();
    if (installed === undefined) return expect.unreachable('testJobs installed no driver');
    spyOn(installed, 'close').mockImplementation(() => {
      throw new TypeError('driver close failed');
    });
    await expect(fixture[Symbol.asyncDispose]()).rejects.toThrow('driver close failed');
    expect(eventBus()).toBe(busBefore);
    expect(jobDriver()).toBe(driverBefore);
  });

  test('a waiting step resumes on the event its own test published', async () => {
    minted += 1;
    const waiter = job<Input>({
      name: `fixture-jobs-${String(minted)}`,
      input: t.object({ id: t.string, orgId: t.string }),
      tenant: 'none',
      idempotencyKey: (input) => `k:${input.id}`,
      retry: { attempts: 1, jitter: false },
      run: async ({ step, input }) =>
        step.waitForEvent('answer', 'prompt.answered', { match: input.id, timeout: '1h' }),
    });
    const jobs = await worker();
    await publishEvent('prompt.answered', { answer: 'yes' }, { correlationKey: 'a' });
    const trace = await jobs(waiter, { id: 'a', orgId: ORG });
    expect(trace.executions.map((run) => run.outcome)).toEqual(['completed']);
  });
});

describe(testName('unit', 'runJobs: a pass is a real worker’s, caps included'), () => {
  interface Account {
    readonly id: string;
    readonly accountId: string;
  }

  // `whenBusy: 'fail'` is decided by the worker's ADMISSION, before a body runs — a fixture that
  // claimed and called `executeJob` itself skipped it, and a test of `X_JOB_KEY_BUSY` had to
  // hand-build two workers to see the refusal its own job declares.
  test("two runs on one key under whenBusy 'fail': the second settles X_JOB_KEY_BUSY", async () => {
    minted += 1;
    const ran: string[] = [];
    const sync = job<Account>({
      name: `fixture-jobs-keyed-${String(minted)}`,
      input: t.object({ id: t.string, accountId: t.string }),
      tenant: 'none',
      idempotencyKey: (input) => `sync:${input.id}`,
      concurrency: { key: (input) => input.accountId, limit: 1, whenBusy: 'fail' },
      retry: { attempts: 1, jitter: false },
      run: async ({ input, step }) => {
        await step.run('sync', () => {
          ran.push(input.id);
        });
      },
    });
    const jobs = await worker();
    await jobs.enqueue(sync, { id: 'first', accountId: 'acct-1' });
    const trace = await jobs(sync, { id: 'second', accountId: 'acct-1' });
    expect(trace.executions.map((run) => run.outcome)).toEqual(['completed', 'refused']);
    expect(trace.executions[1]?.error).toContain('X_JOB_KEY_BUSY');
    // Refused before its body: only the run holding the key did the work.
    expect(ran).toEqual(['first']);
    expect(await jobs.depth(sync)).toBe(0);
  });

  test('a queued job nothing registered is refused by name, never parked in silence', async () => {
    const jobs = await worker();
    await jobDriver()?.enqueue({
      name: 'fixture-jobs-nobody',
      queue: 'default',
      input: {},
      idempotencyKey: 'nobody',
      maxAttempts: 1,
    });
    const refused = await jobs.drain().catch((error: unknown) => error);
    expect(refused).toBeUltimateError('X_INVARIANT');
    expect((refused as { cause?: string }).cause).toContain('fixture-jobs-nobody');
  });
});

describe(testName('unit', 'runJobs: a running body hears its cancel'), () => {
  // A body learns its row was cancelled from the lease renewal that misses it. The fixture's worker
  // renews ON THE TEST CLOCK, so a cancel test needs no hand-built worker and no wall-clock wait:
  // cancel, advance, and the next renewal is the one that hears it.
  test('enqueue, cancel while running: the body observes the abort and the outcome is recorded', async () => {
    const intervals = spyOn(globalThis, 'setInterval');
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let heard: unknown;
    const held = declare('none', async () => {
      const { signal } = useContext();
      started();
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      heard = signal.reason;
      signal.throwIfAborted();
    });
    const jobs = await worker();
    const { id } = await jobs.enqueue(held, { id: 'a', orgId: ORG });
    let trace: Awaited<ReturnType<RunJobs['drain']>>;
    try {
      const draining = jobs.drain();
      await running;
      expect(await jobs.inFlight()).toBe(1);

      await cancelJob(jobDriver() ?? expect.unreachable('runJobs installed no driver'), id);
      // Nothing renews until time passes: the run is still running, its cancel not yet heard.
      await new Promise((resolve) => setImmediate(resolve));
      expect(heard).toBeUndefined();
      advanceClock(1);
      trace = await draining;
      // No real interval was armed for the lease, the slot or anything else this drain ran.
      expect(intervals).not.toHaveBeenCalled();
    } finally {
      intervals.mockRestore();
      advanceClock(-1);
    }

    expect(heard).toBeUltimateError('X_JOB_LEASE_LOST');
    // The attempt failed on the abort; the ROW stays the operator's `cancelled` — the worker's own
    // settle is fenced on `running` and matches nothing.
    expect(trace.executions.map((run) => [run.jobId, run.outcome])).toEqual([
      [id, 'dead-lettered'],
    ]);
    expect((await jobDriver()?.introspect?.job(id))?.state).toBe('cancelled');
    expect(await jobs.inFlight()).toBe(0);
  });
});
