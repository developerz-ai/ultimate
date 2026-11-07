// The primitives an exercise pass drives, each as one call: every registered action, query and job,
// loaded on demand. A job is enqueued in the tenant it is called for, its input SEATED there first
// (`exercise-job-tenant.ts`): a drawn org is a random one, and the enqueue refuses it.

import type { Actor } from '@ultimat3/core';
import { renderCauseValue, renderFixShellArg } from '@ultimat3/core';
import type { AnyJobHandle, JobExecution } from '@ultimat3/jobs';
import { registeredJobs } from '@ultimat3/jobs';
import type { Policy } from '@ultimat3/policy';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { JobTenantBinding } from './exercise-job-tenant';
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

const statusOfJobFailure = (run: JobExecution | undefined): string =>
  run === undefined ? 'the job never ran' : (run.error ?? `the run ended ${run.outcome}`);

const jobSubject = (handle: AnyJobHandle): Subject => ({
  kind: 'job',
  name: handle.name,
  input: handle.input,
  policy: undefined,
  permissions: [],
  handle,
  seat: (input, tenant) => bindJobTenant(handle, input, tenant),
  call: async (input, actor, tenant, jobs) => {
    const queued = await jobs.enqueue(handle, input, { tenantId: tenant });
    const trace = await jobs.drain(actor === null ? {} : { actor });
    const own = trace.executions.find((run) => run.jobId === queued.id);
    // The worker's failure is a string on the row, never a throw: it is the attempt's error.
    // Suspended is a body that ran and parked (`step.sleep`, `waitForEvent`): reached.
    return own !== undefined && ANSWERED.has(own.outcome)
      ? { output: own.result }
      : { failure: statusOfJobFailure(own) };
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
