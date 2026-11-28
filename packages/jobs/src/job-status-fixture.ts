// A tenant's read and cancel of ONE job, written once over a harness and run on every driver:
// memory (`job-status.test.ts`), Postgres (`job-status-pg.job.test.ts`) and Redis
// (`job-status-redis.live.test.ts`). The property each scenario holds: another tenant's row, a row
// queued for no tenant and a row nobody queued are the same answer, and none of them is touched.

import { expect, test } from 'bun:test';
import type { JobDriver } from './driver';
import { cancelJobFor, jobStatusFor } from './job-status';

export interface JobStatusHarness {
  /** A store with no rows a scenario could mistake for its own. */
  driver(): Promise<JobDriver>;
}

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const QUEUE = 'status';
/** An id of the right shape that nobody queued. */
const NO_SUCH_JOB = '019ff1c5-0000-7000-8000-00000000dead';
const SECRET = 'sk_live_do_not_show';

const enqueue = (driver: JobDriver, key: string, tenantId?: string) =>
  driver.enqueue({
    name: 'report.build',
    queue: QUEUE,
    input: { secret: SECRET },
    idempotencyKey: key,
    maxAttempts: 3,
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    enqueuedBy: 'user-1',
    ...(tenantId === undefined ? {} : { tenantId }),
  });

const claim = (driver: JobDriver) =>
  driver.claim({ queues: [QUEUE], limit: 10, visibilityTimeoutMs: 30_000, workerId: 'w-status' });

export function jobStatusScenarios(label: string, harness: JobStatusHarness): void {
  test(`${label}: the tenant reads its own job, and nothing but the status fields`, async () => {
    const driver = await harness.driver();
    const { id } = await enqueue(driver, 'own', ORG_A);
    const status = await jobStatusFor(driver, { jobId: id, tenantId: ORG_A });
    expect(status).toMatchObject({ id, name: 'report.build', state: 'ready', attempt: 0 });
    expect(status?.maxAttempts).toBe(3);
    expect(Object.keys(status ?? {}).sort()).toEqual([
      'attempt',
      'createdAt',
      'id',
      'maxAttempts',
      'name',
      'progress',
      'runAt',
      'state',
      'updatedAt',
    ]);
    expect(JSON.stringify(status)).not.toContain(SECRET);
    expect(Number.isNaN(Date.parse(status?.createdAt ?? ''))).toBe(false);
  });

  test(`${label}: another tenant's job answers exactly what a missing one does`, async () => {
    const driver = await harness.driver();
    const { id } = await enqueue(driver, 'theirs', ORG_A);
    const foreign = await jobStatusFor(driver, { jobId: id, tenantId: ORG_B });
    const missing = await jobStatusFor(driver, { jobId: NO_SUCH_JOB, tenantId: ORG_B });
    expect(foreign).toBeUndefined();
    expect(foreign).toEqual(missing);
  });

  test(`${label}: a job queued for no tenant is unreachable from any tenant`, async () => {
    const driver = await harness.driver();
    const { id } = await enqueue(driver, 'nobody');
    expect(await jobStatusFor(driver, { jobId: id, tenantId: ORG_A })).toBeUndefined();
    expect(await cancelJobFor(driver, { jobId: id, tenantId: ORG_A })).toBeUndefined();
    expect((await claim(driver)).map((row) => row.id)).toEqual([id]);
  });

  test(`${label}: a name in the query is part of the fence`, async () => {
    const driver = await harness.driver();
    const { id } = await enqueue(driver, 'named', ORG_A);
    const query = { jobId: id, tenantId: ORG_A };
    expect(await jobStatusFor(driver, { ...query, name: 'other.job' })).toBeUndefined();
    expect(await cancelJobFor(driver, { ...query, name: 'other.job' })).toBeUndefined();
    expect((await jobStatusFor(driver, { ...query, name: 'report.build' }))?.state).toBe('ready');
  });

  test(`${label}: an empty name names no job, on status and cancel alike`, async () => {
    const driver = await harness.driver();
    const { id } = await enqueue(driver, 'empty-name', ORG_A);
    const query = { jobId: id, tenantId: ORG_A, name: '' };
    expect(await jobStatusFor(driver, query)).toBeUndefined();
    expect(await cancelJobFor(driver, query)).toBeUndefined();
    expect((await claim(driver)).map((row) => row.id)).toEqual([id]);
  });

  test(`${label}: cancelling another tenant's job is a no-op answering undefined`, async () => {
    const driver = await harness.driver();
    const { id } = await enqueue(driver, 'not-yours', ORG_A);
    expect(await cancelJobFor(driver, { jobId: id, tenantId: ORG_B })).toBeUndefined();
    expect(await cancelJobFor(driver, { jobId: NO_SUCH_JOB, tenantId: ORG_B })).toBeUndefined();
    expect((await jobStatusFor(driver, { jobId: id, tenantId: ORG_A }))?.state).toBe('ready');
    expect((await claim(driver)).map((row) => row.id)).toEqual([id]);
  });

  test(`${label}: the tenant cancels its own waiting job, which is never claimed`, async () => {
    const driver = await harness.driver();
    const { id } = await enqueue(driver, 'stop-me', ORG_A);
    const cancelled = await cancelJobFor(driver, { jobId: id, tenantId: ORG_A, reason: 'mine' });
    expect(cancelled?.state).toBe('cancelled');
    expect(await claim(driver)).toEqual([]);
    // The key is free again: the same work may be asked for anew.
    expect((await enqueue(driver, 'stop-me', ORG_A)).deduped).toBe(false);
  });

  test(`${label}: cancelling a running job stops its worker's lease`, async () => {
    const driver = await harness.driver();
    const { id } = await enqueue(driver, 'running', ORG_A);
    const [held] = await claim(driver);
    if (held === undefined) return expect.unreachable('the fresh row was claimable');
    expect((await cancelJobFor(driver, { jobId: id, tenantId: ORG_A }))?.state).toBe('cancelled');
    const by = { visibilityTimeoutMs: 30_000, workerId: 'w-status', claim: held.claim };
    expect(await driver.heartbeat(id, by)).toBe(false);
    expect(await driver.ack(id, { workerId: 'w-status', claim: held.claim })).toBe(false);
  });

  test(`${label}: a finished job is answered as it ended, never rewritten`, async () => {
    const driver = await harness.driver();
    const { id } = await enqueue(driver, 'done', ORG_A);
    const [held] = await claim(driver);
    if (held === undefined) return expect.unreachable('the fresh row was claimable');
    expect(await driver.ack(id, { workerId: 'w-status', claim: held.claim })).toBe(true);
    const answer = await cancelJobFor(driver, { jobId: id, tenantId: ORG_A });
    expect([answer?.state, answer?.attempt]).toEqual(['done', 1]);
  });

  test(`${label}: an id of no uuid shape, or an empty tenant, names no row`, async () => {
    const driver = await harness.driver();
    const { id } = await enqueue(driver, 'shape', ORG_A);
    expect(await jobStatusFor(driver, { jobId: 'not-a-uuid', tenantId: ORG_A })).toBeUndefined();
    expect(
      await jobStatusFor(driver, { jobId: id.toUpperCase(), tenantId: ORG_A }),
    ).toBeUndefined();
    expect(await cancelJobFor(driver, { jobId: 'job-1', tenantId: ORG_A })).toBeUndefined();
    expect(await jobStatusFor(driver, { jobId: id, tenantId: '' })).toBeUndefined();
  });
}
