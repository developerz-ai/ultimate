// `partitions()` as declared: a job plus its `.schedule` task, daily in UTC unless told otherwise,
// and a run with no partitioned entity registered touches no database at all.

import { afterEach, describe, expect, test } from 'bun:test';
import { ctxOf, userActor } from '@ultimat3/core';
import { clearRegistry, entity, uuid } from '@ultimat3/entity';
import type { ClaimedJob } from './driver';
import { memoryJobDriver } from './driver-memory';
import { executeJob } from './execute';
import type { AnyJobHandle } from './job';
import { getJob, resetJobs } from './job';
import { DEFAULT_PARTITIONS_CRON, partitionedEntities, partitions } from './partitions';
import { getTask, resetTasks } from './task';

afterEach(() => {
  resetJobs();
  resetTasks();
  clearRegistry();
});

describe('partitions()', () => {
  test('a job and its daily UTC schedule, both registered under the declared name', () => {
    const maintain = partitions();
    expect(getJob('partitions')).toBe(maintain);
    expect(getTask('partitions.schedule')).toBe(maintain.schedule);
    expect(maintain.schedule.cron).toBe(DEFAULT_PARTITIONS_CRON);
    expect(maintain.schedule.tz).toBe('UTC');
    const hourly = partitions({ name: 'hourly-parts', cron: '5 * * * *', tz: 'Europe/Berlin' });
    expect(hourly.schedule.cron).toBe('5 * * * *');
    expect(hourly.schedule.tz).toBe('Europe/Berlin');
  });

  test('only entities declaring partitionBy are maintained; none means an empty report', async () => {
    entity('pt_plain', { columns: { id: uuid().primaryKey() } });
    expect(partitionedEntities()).toEqual([]);
    const maintain = partitions({ name: 'pt.partitions' }) as AnyJobHandle;
    const driver = memoryJobDriver();
    await driver.enqueue({
      name: maintain.name,
      queue: maintain.queue,
      input: {},
      idempotencyKey: maintain.name,
      maxAttempts: 1,
    });
    const [claimed] = await driver.claim({
      queues: [maintain.queue],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'w1',
    });
    const ctx = ctxOf({ role: 'worker', actor: userActor({ id: 'worker-1' }) });
    const execution = await executeJob({
      driver,
      claimed: claimed as ClaimedJob,
      handle: maintain,
      ctx,
    });
    expect(execution.result).toEqual({ tables: [] });
  });
});
