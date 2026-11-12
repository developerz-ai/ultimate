// `cronJob()`: one declaration, the job AND the task that fires it. The job is the handle; its
// `.schedule` is a real `task()` the scheduler walks, named `<job>.schedule`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { installJobDriver, resetJobDriver } from './adapter';
import { cronJob } from './cron-job';
import { memoryJobDriver } from './driver-memory';
import { registeredJobs, resetJobs } from './job';
import { resetJobsFacade } from './outbox';
import { registerJobs } from './register';
import { getTask, isTaskHandle, registeredTasks, resetTasks } from './task';

// 2026-07-26T03:00:00Z.
const OCCURRENCE = Date.UTC(2026, 6, 26, 3, 0, 0);

beforeEach(() => {
  resetJobs();
  resetTasks();
  resetJobDriver();
  resetJobsFacade();
});

afterEach(() => {
  resetJobDriver();
  resetJobsFacade();
});

const sweep = () =>
  cronJob({
    name: 'sweepLogs',
    cron: '0 3 * * *',
    tz: 'UTC',
    tenant: 'none',
    retry: { attempts: 2 },
    run: async () => 'swept',
  });

describe('cronJob', () => {
  test('one declaration registers the job and its schedule, named after it', () => {
    const handle = sweep();

    expect(handle.kind).toBe('job');
    expect(registeredJobs().map((job) => job.name)).toEqual(['sweepLogs']);
    expect(isTaskHandle(handle.schedule)).toBe(true);
    expect(handle.schedule.name).toBe('sweepLogs.schedule');
    expect(getTask('sweepLogs.schedule')).toBe(handle.schedule);
    expect(handle.schedule.describe()).toEqual({
      kind: 'task',
      name: 'sweepLogs.schedule',
      cron: '0 3 * * *',
      tz: 'UTC',
      catchUp: 'skip',
      maxCatchUp: 10,
      jobs: ['sweepLogs'],
    });
  });

  test('registering the job module — what defineApi({ jobs }) does — leaves the task scheduled', () => {
    const handle = sweep();
    registerJobs({ sweepLogs: handle });

    expect(registeredJobs()).toEqual([handle]);
    expect(registeredTasks()).toEqual([handle.schedule]);
  });

  test('no input: each occurrence enqueues {}, keyed by the job name', async () => {
    const handle = sweep();
    expect(handle.schedule.entries(OCCURRENCE)).toEqual([[handle, {}]]);
    expect(handle.idempotencyKeyFor({})).toBe('sweepLogs');

    installJobDriver(memoryJobDriver());
    const [fired] = await handle.schedule.enqueue();
    expect(fired?.job).toBe('sweepLogs');
    expect(fired?.result.deduped).toBe(false);
  });

  test('an input: each occurrence enqueues what payload() derives from its instant', () => {
    const digest = cronJob({
      name: 'sendDigest',
      cron: '0 3 * * *',
      tz: 'America/New_York',
      catchUp: 'run-once',
      input: t.object({ runDate: t.string }),
      payload: (occurrenceMs) => ({ runDate: new Date(occurrenceMs).toISOString().slice(0, 10) }),
      idempotencyKey: ({ runDate }) => `digest:${runDate}`,
      tenant: 'none',
      retry: { attempts: 3 },
      run: async ({ input }) => input.runDate,
    });

    expect(digest.schedule.entries(OCCURRENCE)).toEqual([[digest, { runDate: '2026-07-26' }]]);
    expect(digest.idempotencyKeyFor({ runDate: '2026-07-26' })).toBe('digest:2026-07-26');
    expect(digest.schedule.tz).toBe('America/New_York');
    expect(digest.schedule.catchUp).toBe('run-once');
  });

  test('an input with no payload is refused at declaration, naming the field', () => {
    const thrown = (() => {
      try {
        // A JS caller, or a cast: the type already requires `payload` beside `input`.
        cronJob({
          name: 'halfDeclared',
          cron: '0 3 * * *',
          tz: 'UTC',
          input: t.object({ id: t.string }),
          tenant: 'none',
          retry: { attempts: 1 },
          run: async () => undefined,
        } as unknown as Parameters<typeof cronJob>[0]);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    if (!isUltimateError(thrown)) return expect.unreachable('expected a coded refusal');
    expect(thrown.code).toBe('X_JOB_DECLARATION_INVALID');
    expect(thrown.cause).toContain('payload');
  });

  test('the task rules hold: a tz that is not an IANA zone is refused', () => {
    expect(() =>
      cronJob({
        name: 'offset',
        cron: '0 3 * * *',
        tz: '+02:00',
        tenant: 'none',
        retry: { attempts: 1 },
        run: async () => undefined,
      }),
    ).toThrow('X_INVARIANT');
  });
});
