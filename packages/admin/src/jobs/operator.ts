// The one door from the jobs screens to the queue: the process's own driver, read per call — the
// boot installs it after `defineAdmin()` has run, and `x dev` swaps it — and its operator surface.
// A process with no driver, or one that ships no operator surface, is refused with the fix.

import { NotImplementedError } from '@ultimat3/core';
import {
  DriverUnavailableError,
  type JobDriver,
  type JobIntrospection,
  jobDriver,
} from '@ultimat3/jobs';

export interface JobsOperator {
  readonly driver: JobDriver;
  readonly introspect: JobIntrospection;
}

export function jobsOperator(): JobsOperator {
  const driver = jobDriver();
  if (driver === undefined) {
    throw new DriverUnavailableError({
      driver: 'none',
      cause: 'the jobs dashboard was asked for rows and this process installed no queue',
      fix: 'run the app through x dev or the container entry, which install the queue — or in a test: setJobDriver(createMemoryDriver())',
    });
  }
  if (driver.introspect === undefined) {
    throw new NotImplementedError({
      cause: `the operator surface of the "${driver.name}" jobs driver is not implemented: the driver has no introspect`,
      fix: 'call setJobDriver(createPgDriver()) at boot — the pg and memory drivers implement introspect',
    });
  }
  return { driver, introspect: driver.introspect };
}
