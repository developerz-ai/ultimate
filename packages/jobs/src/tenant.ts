// What tenant a job's body runs as. A job is server-authoritative work with no request behind it,
// so the org cannot be read off a caller — it is DECLARED, per job, and derived from that job's
// OWN input. A boot-supplied service actor was the alternative and is rejected: one identity shared
// by every job is the cross-tenant read this declaration exists to make impossible.

import type { Actor } from '@ultimat3/core';
import { assert } from '@ultimat3/core';
import { JobTenantRequiredError } from './errors';

/** The literal a job spells when it belongs to no tenant. */
export const NO_JOB_TENANT = 'none';

/**
 * Either the org this job's input names, or the explicit statement that it names none. There is no
 * third spelling and no default: a job that declared neither used to run with whatever ambient
 * context the worker happened to have, which was none — so `@ultimat3/entity`'s tenant guard read
 * no actor, derived no predicate and accepted a caller-named tenant unchecked.
 */
export type JobTenant<I> = ((input: I) => string) | typeof NO_JOB_TENANT;

/**
 * Runtime backstop for generated code and JS callers; TS already forbids omitting it. The mirror of
 * `idempotencyKey`'s backstop, and refused at `job()` for the same reason — the earliest point at
 * which the mistake is decidable is the declaration, not the first claim.
 */
export function assertJobTenant(job: string, tenant: unknown): void {
  if (typeof tenant === 'function' || tenant === NO_JOB_TENANT) return;
  throw new JobTenantRequiredError({ job });
}

/**
 * The org one run acts under: `undefined` for `'none'`, which is what makes a tenant-scoped read
 * inside such a job fail closed with `X_TENANCY_ACTOR_ORG_REQUIRED` rather than read somebody's
 * rows by accident.
 *
 * An empty answer is refused here rather than carried: `''` is not a tenant, and an actor holding
 * one would satisfy the guard's `orgId !== undefined` check while matching no row's `org_id`.
 * `assert` and not a code of its own, exactly as `idempotencyKeyFor`'s empty-key refusal is — the
 * declaration is wrong in both cases and the repair is the same edit.
 */
export function jobTenantFor<I>(job: string, tenant: JobTenant<I>, input: I): string | undefined {
  if (tenant === NO_JOB_TENANT) return undefined;
  const orgId = tenant(input);
  assert(
    typeof orgId === 'string' && orgId.length > 0,
    `job "${job}" tenant() returned an empty tenant, so the run would carry an org no row can match`,
    `return the org id from job("${job}").tenant — tenant: (input) => input.orgId — or declare tenant: 'none' if this job touches no tenant-scoped table`,
  );
  return orgId;
}

/**
 * The actor the run's ambient context carries. The identity itself is whoever the app wired into
 * `WorkerOptions.context()` — this changes only the ORG, because the tenant is a fact about the
 * WORK and not about which process claimed it. `'none'` strips the org rather than leaving one
 * behind: a job that declared no tenant must not inherit the worker's.
 */
export function jobRunActor(actor: Actor, orgId: string | undefined): Actor {
  if (actor.orgId === orgId) return actor;
  return Object.freeze({ ...actor, orgId });
}
