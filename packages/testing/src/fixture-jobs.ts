// The `runJobs` fixture: a whole worker, in-process, driven by the frozen clock.
//
// A job test asserts the guarantees rather than the return value — a step replayed instead of
// re-run, a duplicate enqueue deduped, a `step.sleep('3d')` that parks the run instead of
// holding a connection — so the trace this returns is keyed by step name and counts executions.
// Nothing here polls or sleeps: a job becomes due only because `clock.advance()` said so.

import type { Actor, Ctx } from '@ultimat3/core';
import { assert, createContext } from '@ultimat3/core';
import type {
  AnyJobHandle,
  EnqueueResult,
  JobDriver,
  JobExecution,
  JobHandle,
  JobRecord,
  StepStatus,
} from '@ultimat3/jobs';
import { frozenNow } from './determinism';
import { frozenScheduler } from './frozen-scheduler';

export interface StepTally {
  /** Times the step body actually ran. A replay from storage does not count. */
  readonly executions: number;
  readonly attempts: number;
  readonly status: StepStatus;
}

/**
 * Cumulative for the life of the fixture, which is one test. A retry driven by
 * `clock.advance()` is a second drain, and "provision ran once, nudge ran twice" is a claim
 * about the whole run — a per-drain trace could not express it.
 */
export interface JobRunTrace {
  /**
   * Each run as the worker settled it. `executions[n].result` is what the BODY returned, on a
   * completed run — `{ skipped: true }` and "did the work" are otherwise one trace.
   */
  readonly executions: readonly JobExecution[];
  /** `trace.steps['welcome-email'].executions` — the assertion a job test is written around. */
  readonly steps: Readonly<Record<string, StepTally>>;
}

/** How a test files the row: the half of `handle.as(actor, input)` that reaches the queue. */
export interface JobEnqueueAs {
  /**
   * The ENQUEUER's tenant on the row — the limiter's bucket and the idempotency namespace, so one
   * key in two tenants is two jobs. Never the tenant the body runs under: that is the job's own
   * declaration (`tenant: (input) => input.orgId`), read off the input.
   */
  readonly tenantId?: string;
}

/** Who the worker is: what an app wires through `WorkerOptions.context()`. */
export interface JobDrainAs {
  /**
   * The identity the body runs as. Its ORG is replaced by the job's declared tenant, exactly as a
   * real worker's is (`jobRunActor`) — `tenant: 'none'` strips it. Absent is core's anonymous actor.
   */
  readonly actor?: Actor;
}

export interface RunJobsOptions extends JobEnqueueAs, JobDrainAs {}

/** `AsyncDisposable`: the fixture installs the ambient job driver and restores it after the test. */
export interface RunJobs extends AsyncDisposable {
  /** Enqueue and drain in one call — the common case. */
  <I>(handle: JobHandle<I>, input: I, options?: RunJobsOptions): Promise<JobRunTrace>;
  enqueue<I>(handle: JobHandle<I>, input: I, options?: JobEnqueueAs): Promise<EnqueueResult>;
  /** Claim and execute everything due at the current instant, until nothing is. */
  drain(options?: JobDrainAs): Promise<JobRunTrace>;
  /** Live jobs — ready, delayed, running or suspended — optionally for one job only. */
  depth(handle?: AnyJobHandle): Promise<number>;
  /** Live jobs claimable right now. `clock.advance()` is what turns delayed into due. */
  due(): Promise<number>;
  inFlight(): Promise<number>;
}

const WORKER_ID = 'test-worker';
const VISIBILITY_TIMEOUT_MS = 30_000;
const CLAIM_LIMIT = 64;
/**
 * Lease and slot renewals, every millisecond of TEST time — on the frozen clock, through
 * `frozenScheduler`, so any `clock.advance()` renews every running job once and the wall clock
 * renews nothing. A renewal is how a running body learns its row was cancelled (`x jobs cancel`,
 * an app's own cancel action): cancel, advance, and the drain settles. The LAPSE side of the lease
 * reads the same clock, so a renewal can never report a lease lost that `clock.advance()` did not.
 */
const RENEW_MS = 1;
/** A drain that has not settled in this many rounds is a runaway, not a slow queue. */
const MAX_ROUNDS = 100;
const LIVE_STATES: ReadonlySet<string> = new Set(['ready', 'delayed', 'running', 'suspended']);

const tallyOf = (executions: readonly JobExecution[]): Record<string, StepTally> => {
  const steps: Record<string, StepTally> = {};
  for (const execution of executions) {
    const replayed = new Set(execution.replayed);
    for (const step of execution.steps) {
      const previous = steps[step.name];
      const ran = replayed.has(step.name) ? 0 : 1;
      steps[step.name] = {
        executions: (previous?.executions ?? 0) + ran,
        attempts: step.attempts,
        status: step.status,
      };
    }
  }
  return steps;
};

export async function createRunJobs(): Promise<RunJobs> {
  const jobs = await import('@ultimat3/jobs');
  const driver: JobDriver = jobs.createMemoryDriver();
  // Captured before the overwrite: the ambient driver is process-global, so without this the
  // next file to call `send()` enqueues into this test's dead queue instead of sending inline.
  const previous = jobs.jobDriver();
  jobs.setJobDriver(driver);
  // The same for the event bus `step.waitForEvent` reads: it is ambient and it STORES, so an
  // answer one test published resumed the next test's waiting run. A fresh bus per fixture, and
  // the process's own handed back with the driver.
  const previousBus = jobs.eventBus();
  jobs.setEventBus(jobs.createMemoryEventBus());
  const anonymousWorker = createContext({ role: 'worker' });
  const renewals = frozenScheduler();

  const introspect = (): NonNullable<JobDriver['introspect']> => {
    const found = driver.introspect;
    assert(
      found !== undefined,
      'the in-memory job driver lost its introspection surface',
      'runJobs reads queue state through driver.introspect — do not replace the driver inside a test',
    );
    return found;
  };

  // Walked by cursor: one `list()` answers a PAGE (`MAX_JOB_PAGE`), and a test that queued more
  // than a page of jobs must still see every one of them.
  const live = async (name?: string): Promise<readonly JobRecord[]> => {
    const rows: JobRecord[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await introspect().list({
        limit: jobs.MAX_JOB_PAGE,
        ...(name === undefined ? {} : { name }),
        ...(after === undefined ? {} : { after }),
      });
      rows.push(...page);
      const last = page[page.length - 1];
      if (last === undefined || page.length < jobs.MAX_JOB_PAGE) break;
      after = jobs.jobCursor(last);
    }
    return rows.filter((record) => LIVE_STATES.has(record.state));
  };

  const queues = (): readonly string[] => [
    ...new Set([jobs.DEFAULT_QUEUE, ...jobs.registeredJobs().map((handle) => handle.queue)]),
  ];

  /**
   * One pass, through a REAL worker's `tick()`: claim, admission — the in-process limiter and the
   * fleet slot `job.concurrency` holds, keyed or not — then the run. Calling `executeJob` on what
   * `claim()` answered skipped admission entirely, so `whenBusy: 'fail'` never refused and
   * `concurrency: 1` never waited under this fixture. Never `start()`ed: no timer, no registry
   * row, no shutdown hook — the frozen clock and the test decide when a pass happens.
   */
  const round = async (ctx: Ctx): Promise<readonly JobExecution[]> => {
    const worker = jobs.createWorker({
      driver,
      workerId: WORKER_ID,
      queues: queues(),
      // A whole batch per pass, as `claim({ limit })` was: two runs of one key are in flight
      // together only if one pass claims both.
      concurrency: CLAIM_LIMIT,
      visibilityTimeoutMs: VISIBILITY_TIMEOUT_MS,
      heartbeatIntervalMs: RENEW_MS,
      schedule: renewals.schedule,
      // A shed run is claimable on the next pass, not after a wait this clock would never reach.
      pollIntervalMs: 0,
      drainOnShutdown: false,
      context: () => ctx,
    });
    const executions = await worker.tick();
    // The worker PARKS a job no module registered — right for a fleet mid-deploy, where the pod
    // beside it may know the name, and silence in a test that forgot an import.
    const orphan = executions.find((run) => run.error === `no job registered as "${run.job}"`);
    assert(
      orphan === undefined,
      `queue holds job "${orphan?.job ?? ''}" but nothing registered it`,
      `import the module that declares job("${orphan?.job ?? ''}") from the test file — the registry is populated by the import, not by the queue`,
    );
    return executions;
  };

  /** Every execution this fixture has driven, because the trace is cumulative. */
  const history: JobExecution[] = [];

  const drain = async (options: JobDrainAs = {}): Promise<JobRunTrace> => {
    const ctx =
      options.actor === undefined
        ? anonymousWorker
        : createContext({ role: 'worker', actor: options.actor });
    for (let rounds = 0; rounds < MAX_ROUNDS; rounds += 1) {
      const batch = await round(ctx);
      if (batch.length === 0) return { executions: [...history], steps: tallyOf(history) };
      history.push(...batch);
    }
    assert(
      false,
      `runJobs.drain() ran ${MAX_ROUNDS} rounds without the queue settling`,
      'give the failing job a retry delay, or assert with runJobs.due() instead of draining a job that re-enqueues itself',
    );
  };

  const enqueue = async <I>(
    handle: JobHandle<I>,
    input: I,
    options: JobEnqueueAs = {},
  ): Promise<EnqueueResult> =>
    driver.enqueue({
      name: handle.name,
      queue: handle.queue,
      input,
      idempotencyKey: handle.idempotencyKeyFor(input),
      maxAttempts: handle.retry.attempts,
      ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
    });

  const enqueueThenDrain = async <I>(
    handle: JobHandle<I>,
    input: I,
    options: RunJobsOptions = {},
  ): Promise<JobRunTrace> => {
    await enqueue(handle, input, options);
    return drain(options);
  };

  return Object.assign(enqueueThenDrain, {
    enqueue,
    drain,
    depth: async (handle?: AnyJobHandle) => (await live(handle?.name)).length,
    due: async () =>
      (await live()).filter(
        (record) => record.state !== 'running' && record.runAt <= frozenNow().getTime(),
      ).length,
    inFlight: async () => (await live()).filter((record) => record.state === 'running').length,
    [Symbol.asyncDispose]: async (): Promise<void> => {
      await driver.close?.();
      renewals[Symbol.dispose]();
      jobs.setEventBus(previousBus);
      if (previous === undefined) jobs.resetJobDriver();
      else jobs.setJobDriver(previous);
    },
  });
}
