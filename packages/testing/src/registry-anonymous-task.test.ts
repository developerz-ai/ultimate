// The between-files restore against real anonymous tasks. `resetTasks()` used to rewind the
// counter `task()` mints `anonymous-task-<n>` from, so a later file's anonymous task was minted
// under a name an EARLIER file's handle still held in the snapshot: the merge (keyed by name) kept
// one of the two, and the restore seated a name `task()` then refused as taken — an
// order-dependent `X_JOB_NAME_TAKEN` in whichever file happened to run next.

import { afterAll, describe, expect, test } from 'bun:test';
import { registeredTasks, resetTasks, restoreTasks, task } from '@ultimat3/jobs';
import { captureProcessRegistries, mergeSnapshots } from './registry-snapshot';

const anonymousTask = () => task({ cron: '0 3 * * *', tz: 'UTC', enqueue: () => [] });

describe('unit · anonymous tasks across a file boundary', () => {
  const inherited = registeredTasks();
  afterAll(() => restoreTasks(inherited));

  test('a reset never re-mints a name an earlier handle holds', () => {
    resetTasks();
    const first = anonymousTask();
    const older = captureProcessRegistries();

    // The next file: a neighbour's clear, then its own module-scope anonymous task.
    resetTasks();
    const second = anonymousTask();
    expect(second.name).not.toBe(first.name);

    const merged = mergeSnapshots(older, captureProcessRegistries());
    expect(merged.tasks).toContain(first);
    expect(merged.tasks).toContain(second);
  });

  test('a task declared after a restore is not refused as taken', () => {
    resetTasks();
    const seated = anonymousTask();
    const snapshot = captureProcessRegistries();
    resetTasks();
    restoreTasks(snapshot.tasks);

    const next = anonymousTask();
    expect(next.name).not.toBe(seated.name);
    expect(registeredTasks()).toEqual(expect.arrayContaining([seated, next]));
  });
});
