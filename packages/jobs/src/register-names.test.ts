// `nameJobs` / `nameTasks`, the record form generated code calls: each handle is renamed in place
// to its export name and found under it, and the name it was declared under is no longer taken.

import { afterEach, describe, expect, test } from 'bun:test';
import { t } from '@ultimat3/schema';
import { getJob, job, nameJobs, resetJobs } from './job';
import { getTask, nameTasks, resetTasks, task } from './task';

afterEach(() => {
  resetJobs();
  resetTasks();
});

describe('nameJobs', () => {
  test('renames each handle to its export name and registers it there', () => {
    const handle = job<{ id: string }>({
      input: t.object({ id: t.string }),
      tenant: 'none',
      idempotencyKey: (input) => input.id,
      retry: { attempts: 1 },
      run: async () => undefined,
    });
    const before = handle.name;
    nameJobs({ sendDigest: handle });
    expect(handle.name).toBe('sendDigest');
    expect(getJob('sendDigest')).toBe(handle);
    expect(getJob(before)).toBeUndefined();
  });
});

describe('nameTasks', () => {
  test('renames each handle to its export name and registers it there', () => {
    const handle = task({ cron: '0 * * * *', tz: 'UTC', enqueue: () => [] });
    const before = handle.name;
    nameTasks({ hourlySweep: handle });
    expect(handle.name).toBe('hourlySweep');
    expect(getTask('hourlySweep')).toBe(handle);
    expect(getTask(before)).toBeUndefined();
  });
});
