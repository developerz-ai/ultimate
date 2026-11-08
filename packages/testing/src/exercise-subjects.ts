// The primitives an exercise pass drives, each as one call: every registered action, query and job,
// loaded on demand. A job is enqueued in the tenant it is called for, its input SEATED there first
// (`exercise-job-tenant.ts`): a drawn org is a random one, and the enqueue refuses it. It runs
// alone (`exercise-job-run.ts`): what it queues is left queued, as an action's is.

import type { Actor } from '@ultimat3/core';
import { renderCauseValue, renderFixShellArg, UltimateError } from '@ultimat3/core';
import type { AnyJobHandle, JobExecution } from '@ultimat3/jobs';
import { registeredJobs } from '@ultimat3/jobs';
import type { Policy } from '@ultimat3/policy';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { JobTenantBinding } from './exercise-job-tenant';
import { runJobAlone } from './exercise-job-run';
import { bindJobTenant } from './exercise-job-tenant';
import { withExerciseRequest } from './exercise-request';
import type { RunJobs } from './fixture-jobs';

/** `failure` set: the worker recorded one (a job's). Absent: answered, with `output`. */
export interface Answer {
  readonly failure?: unknown;
  readonly output?: unknown;
}

/** One primitive, as the pass drives it: the schema to draw from and the one call to make. */
export interface Subject {
  readonly kind: 'action' | 'query' | 'job';
  readonly name: string;
  readonly input: StandardSchemaV1;
  readonly policy: Policy | undefined;
  /** Every permission the policy references — what `x policy explain` matches grants against. */
  readonly permissions: readonly string[];
  /** A job's handle: what the crash proof kills at every step boundary once the control reached it. */
  readonly handle?: AnyJobHandle;
  /** A job's: `input` naming `tenant` wherever its declared `tenant(input)` reads the org. */
  seat?(input: unknown, tenant: string): JobTenantBinding;
  /** Resolves to the failure a worker recorded on the row (a job's), or what the call answered. */
  call(input: unknown, actor: Actor | null, tenant: string, jobs: RunJobs): Promise<Answer>;
}

/** `input` seated in `tenant` when the subject declares a seat and one exists; else as given. */
export const seatIn = (subject: Pick<Subject, 'seat'>, input: unknown, tenant: string): unknown => {
  const seat = subject.seat?.(input, tenant);
  return seat?.kind === 'seated' ? seat.input : input;
};

/**
 * Why a job whose org no input field moves is not run: the pass seats every primitive in a FRESH
 * tenant of its own, and a constant org is none of them. Seeding that one org instead would hand
 * every such job the same tenant — no fresh pair, no tenant proof — so it is reported, never run
 * in a tenant whose rows the pass did not seed. The repair is the declaration's.
 */
export function fixedTenant(name: string, declared: string | undefined) {
  const org = declared === undefined ? 'no org' : `org ${renderCauseValue(declared)}`;
  return {
    code: 'X_JOB_TENANT_MISMATCH',
    reason: `its tenant(input) answers ${org} whatever its input carries, so it cannot run in the fresh tenant the pass seeded for it`,
    fix: `tenant: (input) => input.orgId   # in job({ name: ${JSON.stringify(name)} })'s declaration: the org as input, so every enqueuer — this pass too — names it; then: x exercise ${renderFixShellArg(name, '<name>')} --json`,
  };
}

const ANSWERED: ReadonlySet<string> = new Set(['completed', 'suspended']);

/**
 * What a failed run hands the verdict. A run whose error carried a code is that code again, so
 * core's `exerciseDefect` judges it by the one rule an action's refusal meets: a coded refusal
 * under 500 is the job answering "no", a 5xx or an uncoded throw is a defect. The message alone
 * read every coded refusal — an app's 409 included — as an uncoded throw: X_CONTRACT_DEFECT.
 */
const jobFailure = (run: JobExecution | undefined): unknown => {
  if (run === undefined) return 'the job never ran';
  const message = run.error ?? `the run ended ${run.outcome}`;
  if (run.code === undefined) return message;
  return new UltimateError({
    code: run.code,
    cause: message,
    fix: `x errors explain ${renderFixShellArg(run.code, '<code>')} --json`,
  });
};

const jobSubject = (handle: AnyJobHandle): Subject => ({
  kind: 'job',
  name: handle.name,
  input: handle.input,
  policy: undefined,
  permissions: [],
  handle,
  seat: (input, tenant) => bindJobTenant(handle, input, tenant),
  call: async (input, actor, tenant, jobs) => {
    // Its own execution and nothing else: a drain of `jobs` ran what it queued (one child per row,
    // which the scale sweep read as the job's loop) and whatever an earlier call had left there.
    const own = await runJobAlone(handle, input, { actor, tenant }, jobs);
    // The worker's failure is on the row, never a throw: the attempt's error and its code.
    // Suspended is a body that ran and parked (`step.sleep`, `waitForEvent`): reached.
    return own !== undefined && ANSWERED.has(own.outcome)
      ? { output: own.result }
      : { failure: jobFailure(own) };
  },
});

export async function subjectsOf(): Promise<readonly Subject[]> {
  // On demand, as every fixture here loads them: the barrel stays off `action` and `query`.
  const { invoke, listActions } = await import('@ultimat3/action');
  const { listQueries, runQuery } = await import('@ultimat3/query');
  return [
    ...listActions().map(
      (target): Subject => ({
        kind: 'action',
        name: target.name,
        input: target.input,
        policy: target.policy,
        permissions: target.describe().permissions,
        call: async (input, actor) => ({
          output: await withExerciseRequest(target.name, actor, () =>
            invoke(target, input, { surface: 'http' }),
          ),
        }),
      }),
    ),
    ...listQueries().map(
      (target): Subject => ({
        kind: 'query',
        name: target.name,
        input: target.input,
        policy: target.policy,
        permissions: target.describe().permissions,
        call: async (input, actor) => ({
          output: await withExerciseRequest(target.name, actor, () =>
            runQuery(target, input, { surface: 'http' }),
          ),
        }),
      }),
    ),
    ...registeredJobs().map(jobSubject),
  ];
}
