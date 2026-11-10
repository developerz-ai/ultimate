// The lease-store suite over the pg driver's `x_job_leases` store and a real Postgres
// (`TEST_DATABASE_URL`): the memory run proves the checks, this one proves the statements meet
// them. Time passes by ageing `expires_at`: the database's `now()` is never raced.

import { afterAll, beforeAll, describe, expect } from 'bun:test';
import { postgresJobDriver } from '@ultimat3/jobs';
import { leaseStoreConformance } from './lease-store-conformance';
import { age, jobsDatabase } from './lease-store-conformance-pg-fixture';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';

describe.skipIf(adminUrl === '')(testName('live', 'the pg lease store'), () => {
  const database = jobsDatabase(adminUrl, 'ultimate_lease_conformance');
  beforeAll(database.open);
  afterAll(database.close);

  behavesLike(leaseStoreConformance, () => ({
    store:
      postgresJobDriver({ executor: database.executor }).leases ??
      expect.unreachable('the pg driver ships a lease store'),
    elapse: (ms) => age(database, 'x_job_leases', ['expires_at'], ms),
  }));
});
