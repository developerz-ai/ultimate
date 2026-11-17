// `recordSteps`, behind `toEmitSteps`: runs a job body against a step API that records names
// instead of persisting outputs. The body gets the arguments the worker hands it (`execute.ts`),
// so a job written against the documented surface runs here exactly as it reads.

import { ctxOf, runWithContext } from '@ultimat3/core';
import type { JobRunArgs, RetryPolicy, StepApi, StepOutput } from '@ultimat3/jobs';
import { isFinalAttempt, JobTimeoutError } from '@ultimat3/jobs';
import { TestJobExpectedError } from './errors';
import { PRELOAD_CLOCK } from './fixture-jobs';

/** A `job()` handle, structurally: `retry` is absent only on a hand-written look-alike. */
export interface JobLike {
  readonly name?: string;
  readonly retry?: RetryPolicy;
  run(args: JobRunArgs<unknown>): Promise<unknown>;
}

export const isJob = (value: unknown): value is JobLike =>
  typeof value === 'object' && value !== null && typeof Reflect.get(value, 'run') === 'function';

/** `step.waitForEvent`'s documented default, when the call names no `timeout`. */
const WAIT_DEFAULT = '24h';

/** The one answer a recorder can give a wait: no event came, so the timeout branch runs. */
async function timedOut(
  jobName: string,
  name: string,
  event: string,
  options: { readonly timeout?: string | number; readonly required?: boolean },
): Promise<undefined> {
  if (options.required !== true) return undefined;
  // The worker's own refusal for a required wait that timed out, so the body ends as it would.
  // `@ultimat3/time` is dynamic-only from this package's barrel (CLAUDE.md).
  const timeout = options.timeout ?? WAIT_DEFAULT;
  const timeoutMs =
    typeof timeout === 'number' ? timeout : (await import('@ultimat3/time')).parseDuration(timeout);
  throw new JobTimeoutError({
    job: jobName,
    step: name,
    timeoutMs,
    fix: `step.waitForEvent('${name}', '${event}', { timeout: '1h' })   # recordSteps delivers no event: drop required: true, or drive the run with runJobs and publish "${event}"`,
  });
}

/**
 * Runs the job with a recording step API, so the assertion is on the sequence, not the effects.
 * Typed as `StepApi`, so a member the real API gains is a compile error here rather than a
 * TypeError in a caller's test. `sleep` is not a step in the sequence; `waitForEvent` is.
 */
export async function recordSteps(job: unknown, input: unknown = {}): Promise<readonly string[]> {
  if (!isJob(job)) throw new TestJobExpectedError();
  const jobName = job.name ?? 'recordSteps';
  const names: string[] = [];
  // Never aborted: the recorder imposes no ceiling, and the run is never cancelled.
  const signal = new AbortController().signal;
  const step: StepApi = {
    run: async <T>(name: string, body: (signal: AbortSignal) => Promise<T> | T) => {
      names.push(name);
      // Passed through, not round-tripped through JSON: the matcher asserts names, not outputs.
      return (await body(signal)) as StepOutput<T>;
    },
    sleep: async () => undefined,
    waitForEvent: async (name, event, options) => {
      names.push(name);
      return timedOut(jobName, name, event, options);
    },
  };
  // The worker's shape: a `role: 'worker'` ctx on the frozen clock the `runJobs` fixture uses,
  // installed as the AMBIENT context too — the ctx a body is handed and the one entity's tenant
  // guard reads are one object, as in `execute.ts`.
  const ctx = ctxOf({ role: 'worker', clock: PRELOAD_CLOCK });
  const runId = `record-steps:${jobName}`;
  await runWithContext(ctx, () =>
    job.run({
      input,
      step,
      ctx,
      attempt: 1,
      finalAttempt: job.retry === undefined ? true : isFinalAttempt(job.retry, 1),
      progress: () => undefined,
      jobId: runId,
      runId,
    }),
  );
  return names;
}
