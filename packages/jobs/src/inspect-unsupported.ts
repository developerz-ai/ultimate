// The one guard every read and operator verb passes: the driver's operator surface, or a refusal
// naming the capability it lacks. A capability, not a stub — redis ships no `introspect` by design
// (no pause, registry or counters); pg and memory implement every member. `tenantJobs`, which all
// three ship, refuses through the same class when a hand-rolled driver lacks it.

import { UltimateError } from '@ultimat3/core';
import type { JobDriver } from './driver';
import type { JobIntrospection } from './introspection';

const FIX_HEAD =
  'postgresJobDriver({ executor })   # jobs: in apps/<app>/runtime.ts, or drop that field and the boot builds it over DATABASE_URL — the pg and memory drivers implement';

/** What each optional member is, for a cause; and the call that proves the fix took. */
const MEMBERS = {
  resolveStep: {
    where: "'s operator surface",
    lacks: 'it keeps no step records an operator can resolve',
    head: FIX_HEAD,
    proof: 'x jobs resolve-step <id> <step> --ran --output <json>',
  },
  tenantJobs: {
    where: '',
    lacks:
      "it has no tenant-fenced read of one job, so jobStatusFor/cancelJobFor cannot tell a tenant's row from another's",
    head: FIX_HEAD.replace('the pg and memory drivers', 'the pg, memory and redis drivers'),
    proof: 'bun test ./<the test of the query or action calling jobStatusFor/cancelJobFor>',
  },
} as const;

/**
 * The driver has no `introspect` — nothing to list, trace, retry or pause with — or lacks the one
 * optional member a verb needs (`member`): `resolveStep` on `introspect`, or `JobDriver.tenantJobs`.
 */
export class JobIntrospectionUnsupportedError extends UltimateError {
  constructor(input: { driver: string; member?: keyof typeof MEMBERS }) {
    const member = input.member === undefined ? undefined : MEMBERS[input.member];
    super({
      code: 'X_JOB_INTROSPECTION_UNSUPPORTED',
      cause:
        member === undefined
          ? `the "${input.driver}" jobs driver has no operator surface: it ships no introspect`
          : `the "${input.driver}" jobs driver${member.where} has no ${input.member}: ${member.lacks}`,
      fix:
        member === undefined
          ? `${FIX_HEAD} introspect — then: x jobs list --json`
          : `${member.head} ${input.member} — then: ${member.proof}`,
    });
  }
}

export function requireIntrospection(driver: JobDriver): JobIntrospection {
  if (driver.introspect === undefined) {
    throw new JobIntrospectionUnsupportedError({ driver: driver.name });
  }
  return driver.introspect;
}
