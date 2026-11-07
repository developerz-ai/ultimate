// A plain enqueue of a tenant-declaring job on a real Postgres: queued for the org its payload
// names, so the `(name, tenant, key)` idempotency index keeps two orgs' keys apart and `perTenant`
// counts the org — the memory driver's answer. Opt-in (`.job.`).

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { postgresJobDriver } from './driver-pg';
import { embeddedPg } from './embedded-pg-fixture';
import {
  perTenantCountsThePayloadOrg,
  twoOrgsOneKey,
  twoOrgsOneKeyMany,
} from './enqueue-tenant-fixture';
import { resetJobs } from './job';
import { resetJobsFacade } from './outbox';

beforeEach(async () => {
  await (await embeddedPg()).reset();
});

afterEach(() => {
  resetJobs();
  resetJobsFacade();
});

afterAll(async () => {
  await (await embeddedPg()).close();
});

const driver = async () => postgresJobDriver({ executor: (await embeddedPg()).executor });

test('two orgs, one idempotency key: two jobs (pg)', async () => twoOrgsOneKey(await driver()));

test('enqueueMany: two orgs, one key, two jobs (pg)', async () =>
  twoOrgsOneKeyMany(await driver()));

test('perTenant counts the payload org (pg)', async () => {
  expect(await perTenantCountsThePayloadOrg(await driver())).toEqual([]);
});
