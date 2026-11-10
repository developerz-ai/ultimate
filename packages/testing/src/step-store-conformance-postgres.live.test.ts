// The step-store suite over the pg driver's `x_job_steps` store and a real Postgres
// (`TEST_DATABASE_URL`): the fenced checks claim real `x_jobs` rows, so `SQL_STEP_PUT`'s fence is
// what answers them. Every check writes runs and queues of its own, so they share one database.

import { afterAll, beforeAll, describe } from 'bun:test';
import { postgresJobDriver } from '@ultimat3/jobs';
import { jobsDatabase } from './lease-store-conformance-pg-fixture';
import { behavesLike } from './shared-examples';
import { stepStoreConformance } from './step-store-conformance';
import { testName } from './test-types';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';

describe.skipIf(adminUrl === '')(testName('live', 'the pg step store'), () => {
  const database = jobsDatabase(adminUrl, 'ultimate_step_conformance');
  beforeAll(database.open);
  afterAll(database.close);

  behavesLike(stepStoreConformance, () => postgresJobDriver({ executor: database.executor }));
});
