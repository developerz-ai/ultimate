// The `JobDriver` contract as shared examples: `behavesLike(jobDriverConformance, () => driver)`
// runs every check in `job-driver-checks.ts` against a driver of your own, one test per check.
// The subject is called once per test — hand back a fresh driver, or one store with no rows a
// check could mistake for its own (each check claims only from a queue it named).

import { test } from 'bun:test';
import type { JobDriver } from '@ultimat3/jobs';
import { JOB_DRIVER_CHECKS } from './job-driver-checks';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export const jobDriverConformance: SharedExamples<JobDriver | Promise<JobDriver>> = sharedExamples(
  'a job driver',
  (subject) => {
    for (const check of JOB_DRIVER_CHECKS) {
      test(check.name, async () => {
        await check.run(await subject());
      });
    }
  },
);
