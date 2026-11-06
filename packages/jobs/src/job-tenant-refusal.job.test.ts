// The run's tenant refusal on a real Postgres: a row queued for org B whose payload names org A is
// dead on its first attempt, its body never run — the memory driver's answer. Opt-in (`.job.`).

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { postgresJobDriver } from './driver-pg';
import { embeddedPg } from './embedded-pg-fixture';
import { resetJobs } from './job';
import { runOfForeignRow } from './job-tenant-fixture';

beforeEach(async () => {
  await (await embeddedPg()).reset();
});

afterEach(() => resetJobs());

afterAll(async () => {
  await (await embeddedPg()).close();
});

test('a row queued for another org is refused at its run (pg)', async () => {
  const pg = await embeddedPg();
  const { outcome, error, ran } = await runOfForeignRow(
    postgresJobDriver({ executor: pg.executor }),
  );
  expect(outcome).toBe('dead-lettered');
  expect(error).toContain('X_JOB_TENANT_MISMATCH');
  expect(ran).toEqual([]);
});
