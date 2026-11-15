// The one guard every read and operator verb passes: the installed driver's operator surface, or
// a refusal naming the capability it lacks. A capability, not a stub — the redis driver keeps no
// pause, worker registry or counters, so it ships no `introspect` by design; the pg and memory
// drivers implement every member of it.

import { UltimateError } from '@ultimat3/core';
import type { JobDriver } from './driver';
import type { JobIntrospection } from './introspection';

const FIX_HEAD =
  'postgresJobDriver({ executor })   # jobs: in apps/<app>/runtime.ts, or drop that field and the boot builds it over DATABASE_URL — the pg and memory drivers implement';

/**
 * The driver has no `introspect` — nothing to list, trace, retry or pause with — or its surface
 * lacks the one optional member a verb needs (`member`).
 */
export class JobIntrospectionUnsupportedError extends UltimateError {
  constructor(input: { driver: string; member?: 'resolveStep' }) {
    super({
      code: 'X_JOB_INTROSPECTION_UNSUPPORTED',
      cause:
        input.member === undefined
          ? `the "${input.driver}" jobs driver has no operator surface: it ships no introspect`
          : `the "${input.driver}" jobs driver's operator surface has no ${input.member}: it keeps no step records an operator can resolve`,
      fix:
        input.member === undefined
          ? `${FIX_HEAD} introspect — then: x jobs list --json`
          : `${FIX_HEAD} resolveStep — then: x jobs resolve-step <id> <step> --ran --output <json>`,
    });
  }
}

export function requireIntrospection(driver: JobDriver): JobIntrospection {
  if (driver.introspect === undefined) {
    throw new JobIntrospectionUnsupportedError({ driver: driver.name });
  }
  return driver.introspect;
}
