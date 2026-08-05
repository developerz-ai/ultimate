// The `runJobs` fixture: a whole worker, in-process, driven by the frozen clock.
//
// A job test asserts the guarantees rather than the return value — a step replayed instead of
// re-run, a duplicate enqueue deduped, a `step.sleep('3d')` that parks the run instead of
// holding a connection — so the trace this returns is keyed by step name and counts executions.
// Nothing here polls or sleeps: a job becomes due only because `clock.advance()` said so.

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
  readonly executions: readonly JobExecution[];
  /** `trace.steps['welcome-email'].executions` — the assertion a job test is written around. */
  readonly steps: Readonly<Record<string, StepTally>>;
}

/** `AsyncDisposable`: the fixture installs the ambient job driver and restores it after the test. */
export interface RunJobs extends AsyncDisposable {
  /** Enqueue and drain in one call — the common case. */
  <I>(handle: JobHandle<I>, input: I): Promise<JobRunTrace>;
  enqueue<I>(handle: JobHandle<I>, input: I): Promise<EnqueueResult>;
  /** Claim and execute everything due at the current instant, until nothing is. */
  drain(): Promise<JobRunTrace>;
  /** Live jobs — ready, delayed, running or suspended — optionally for one job only. */
  depth(handle?: AnyJobHandle): Promise<number>;
  /** Live jobs claimable right now. `clock.advance()` is what turns delayed into due. */
  due(): Promise<number>;
  inFlight(): Promise<number>;
}

const WORKER_ID = 'test-worker';
const VISIBILITY_TIMEOUT_MS = 30_000;
const CLAIM_LIMIT = 64;
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
  const ctx = createContext({ role: 'worker' });

  const introspect = (): NonNullable<JobDriver['introspect']> => {
    const found = driver.introspect;
    assert(
      found !== undefined,
      'the in-memory job driver lost its introspection surface',
      'runJobs reads queue state through driver.introspect — do not replace the driver inside a test',
    );
    return found;
  };

  const live = async (name?: string): Promise<readonly JobRecord[]> => {
    const rows = await introspect().list({ limit: 1000, ...(name === undefined ? {} : { name }) });
    return rows.filter((record) => LIVE_STATES.has(record.state));
  };

  const queues = (): readonly string[] => [
    ...new Set([jobs.DEFAULT_QUEUE, ...jobs.registeredJobs().map((handle) => handle.queue)]),
  ];

  const round = async (): Promise<readonly JobExecution[]> => {
    const claimed = await driver.claim({
      queues: queues(),
      limit: CLAIM_LIMIT,
      visibilityTimeoutMs: VISIBILITY_TIMEOUT_MS,
      workerId: WORKER_ID,
    });
    const executions: JobExecution[] = [];
    for (const job of claimed) {
      const handle = jobs.getJob(job.name);
      assert(
        handle !== undefined,
        `queue holds job "${job.name}" but nothing registered it`,
        `import the module that declares job("${job.name}") from the test file — the registry is populated by the import, not by the queue`,
      );
      executions.push(await jobs.executeJob({ driver, claimed: job, handle, ctx }));
    }
    return executions;
  };

  /** Every execution this fixture has driven, because the trace is cumulative. */
  const history: JobExecution[] = [];

  const drain = async (): Promise<JobRunTrace> => {
    for (let rounds = 0; rounds < MAX_ROUNDS; rounds += 1) {
      const batch = await round();
      if (batch.length === 0) return { executions: [...history], steps: tallyOf(history) };
      history.push(...batch);
    }
    assert(
      false,
      `runJobs.drain() ran ${MAX_ROUNDS} rounds without the queue settling`,
      'give the failing job a retry delay, or assert with runJobs.due() instead of draining a job that re-enqueues itself',
    );
  };

  const enqueue = async <I>(handle: JobHandle<I>, input: I): Promise<EnqueueResult> =>
    driver.enqueue({
      name: handle.name,
      queue: handle.queue,
      input,
      idempotencyKey: handle.idempotencyKeyFor(input),
      maxAttempts: handle.retry.attempts,
    });

  const enqueueThenDrain = async <I>(handle: JobHandle<I>, input: I): Promise<JobRunTrace> => {
    await enqueue(handle, input);
    return drain();
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
      if (previous === undefined) jobs.resetJobDriver();
      else jobs.setJobDriver(previous);
    },
  });
}
