// What tenant a job's body runs as. A job is server-authoritative work with no request behind it,
// so the org cannot be read off a caller — it is DECLARED, per job, and derived from that job's
// OWN input. A boot-supplied service actor was the alternative and is rejected: one identity shared
// by every job is the cross-tenant read this declaration exists to make impossible.

import type { Actor } from '@ultimat3/core';
import { assert, isUltimateError, renderFixShellArg, tryUseContext } from '@ultimat3/core';
import { assertRowTenant, ORG_COLUMN } from '@ultimat3/entity';
import { JobTenantRequiredError } from './errors';
import { JobTenantMismatchError } from './errors-tenant';

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

/**
 * The enqueue's half of the rule: a job whose payload names org A is refused when the enqueue says
 * org B — an explicit `tenantId`, the org `handle.as(actor, …)` stamped, or the AMBIENT actor's
 * org when one is present. It used to queue, and the run then acted as A for a caller in B.
 * `tenant: 'none'` declares no org, so there is nothing to disagree with. The ambient half alone
 * has one escape, entity's: a proven `crossTenant(reason, fn)` (`crossTenantAdmits`).
 */
export function refuseEnqueueTenant(
  job: string,
  declared: string | undefined,
  tenantId: string | undefined,
): void {
  if (declared === undefined) return;
  if (tenantId !== undefined && tenantId !== declared) {
    throw new JobTenantMismatchError({
      job,
      reason: `was enqueued for org "${tenantId}" while its payload names org "${declared}", so its run would act for an org the enqueuer is not in`,
      fix: `${job}.enqueue(input)   # from the org the payload names — an actor of "${declared}" — or with input naming "${tenantId}"`,
    });
  }
  const ambient = tryUseContext()?.actor?.orgId;
  if (ambient !== undefined && ambient !== declared && !crossTenantAdmits(job, declared)) {
    throw new JobTenantMismatchError({
      job,
      reason: `was enqueued by an actor of org "${ambient}" while its payload names org "${declared}"`,
      fix: `${job}.enqueue(input)   # from an actor of "${declared}", with input naming "${ambient}", or inside crossTenant('<why>', () => ${job}.enqueue(input)) by an actor holding tenancy:cross`,
    });
  }
}

/**
 * Whether an enclosing `crossTenant(reason, fn)` admits a payload naming `declared` — asked of
 * `@ultimat3/entity`'s own write guard, the one place that proof is read: the payload's org is a
 * tenant value the ambient actor is writing. Inside a proven scope the guard re-proves
 * `tenancy:cross` and passes (a swapped-in actor without it is `X_TENANCY_CROSS_DENIED`, thrown
 * through); outside, its mismatch is the answer `false`. Called only once the ambient org is known
 * to differ, so outside a scope it always disagrees. The explicit `tenantId` half is never admitted:
 * that row would be queued for one org and refused at its run, which reads no proof.
 */
function crossTenantAdmits(job: string, declared: string): boolean {
  try {
    assertRowTenant(job, ORG_COLUMN, 'enqueue', { [ORG_COLUMN]: declared });
    return true;
  } catch (error) {
    if (isUltimateError(error) && error.code === 'X_TENANCY_ACTOR_MISMATCH') return false;
    throw error;
  }
}

/**
 * The run's half, for a row queued before the enqueue refused it: the org the row was queued for
 * against the org its payload declares. Terminal — the same row disagrees on every attempt.
 */
export function refuseRunTenant(
  job: string,
  declared: string | undefined,
  queuedFor: string | undefined,
): void {
  if (declared === undefined || queuedFor === undefined || queuedFor === declared) return;
  throw new JobTenantMismatchError({
    job,
    reason: `was queued for org "${queuedFor}" while its payload names org "${declared}"`,
    fix: `x jobs list --name ${renderFixShellArg(job, '<job>')} --state dead --json   # this row is dead: re-enqueue it from an actor of the org its payload names, never x jobs retry it`,
  });
}
