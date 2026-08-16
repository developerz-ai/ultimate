// Registration is where a job or a task stops being `anonymous-job-2` and becomes the name its
// source file already uses. What must hold: the exported binding IS the registered handle, a
// declared name outranks the export name, the same handle twice is one registration, and two
// different handles under one name are refused rather than merged.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { hasPrimitiveRegistrar, primitiveRegistrar, UltimateError } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { AnyJobHandle, JobHandle } from './job';
import { getJob, job, registeredJobs, resetJobs } from './job';
import { registerJobs, registerTasks } from './register';
import type { TaskHandle } from './task';
import { getTask, registeredTasks, resetTasks, task } from './task';

/** Minimal Standard Schema so these tests do not depend on the shipped provider's surface. */
function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

interface OrgInput {
  readonly orgId: string;
}

const anonymousJob = (): JobHandle<OrgInput> =>
  job<OrgInput>({
    tenant: 'none',
    input: passthrough<OrgInput>(),
    idempotencyKey: ({ orgId }) => `notify:${orgId}`,
    retry: { attempts: 3, backoff: 'exponential' },
    run: () => Promise.resolve(),
  });

const anonymousTask = (entries: readonly AnyJobHandle[] = []): TaskHandle =>
  task({
    cron: '0 3 * * *',
    tz: 'UTC',
    enqueue: () => entries.map((handle) => [handle, {}] as const),
  });

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof UltimateError ? error.code : `not-an-ultimate-error:${String(error)}`;
  }
};

beforeEach(() => {
  resetJobs();
  resetTasks();
});

afterEach(() => {
  resetJobs();
  resetTasks();
});

describe('registerJobs', () => {
  test('an anonymous job takes its export name, and the exported binding IS the registration', () => {
    const notifySubscribers = anonymousJob();
    expect(notifySubscribers.name).toMatch(/^anonymous-job-\d+$/);

    const registered = registerJobs({ notifySubscribers });

    expect(notifySubscribers.name).toBe('notifySubscribers');
    // The bug this file exists for: a differently-named copy would leave the app's own import
    // enqueueing under the positional id forever.
    expect(getJob('notifySubscribers')).toBe(notifySubscribers as AnyJobHandle);
    expect(registered).toEqual([notifySubscribers as AnyJobHandle]);
  });

  test('the old positional key is released, so nothing answers to it afterwards', () => {
    const notifySubscribers = anonymousJob();
    const positional = notifySubscribers.name;

    registerJobs({ notifySubscribers });

    expect(getJob(positional)).toBeUndefined();
    expect(registeredJobs().map((handle) => handle.name)).toEqual(['notifySubscribers']);
  });

  test('a declared name wins over the export name — it is a durable queue key', () => {
    const sendMail = job<OrgInput>({
      tenant: 'none',
      name: 'mail.send',
      input: passthrough<OrgInput>(),
      idempotencyKey: ({ orgId }) => `mail:${orgId}`,
      retry: { attempts: 2, backoff: 'fixed' },
      run: () => Promise.resolve(),
    });

    const registered = registerJobs({ sendMail });

    expect(sendMail.name).toBe('mail.send');
    expect(getJob('mail.send')).toBe(sendMail as AnyJobHandle);
    expect(getJob('sendMail')).toBeUndefined();
    expect(registered.map((entry) => entry.name)).toEqual(['mail.send']);
  });

  test('the same handle registered twice is one registration, not a duplicate', () => {
    const notifySubscribers = anonymousJob();

    registerJobs({ notifySubscribers });
    const again = registerJobs({ notifySubscribers });

    expect(again).toEqual([notifySubscribers as AnyJobHandle]);
    expect(registeredJobs()).toHaveLength(1);
  });

  test('a DIFFERENT handle under a taken name is X_JOB_DUPLICATE', () => {
    registerJobs({ notifySubscribers: anonymousJob() });

    expect(codeOf(() => registerJobs({ notifySubscribers: anonymousJob() }))).toBe(
      'X_JOB_DUPLICATE',
    );
  });

  test('only handles `job()` built register — a look-alike is not a job', () => {
    const lookAlike = { kind: 'job' as const, name: 'notifySubscribers' };

    expect(registerJobs({ lookAlike, helper: (id: string) => id })).toEqual([]);
    expect(registeredJobs()).toHaveLength(0);
  });

  test('registers in sorted export order, so the manifest never depends on import order', () => {
    const registered = registerJobs({
      sendInvite: anonymousJob(),
      onboardOrg: anonymousJob(),
      deliverDigest: anonymousJob(),
    });

    expect(registered.map((entry) => entry.name)).toEqual([
      'deliverDigest',
      'onboardOrg',
      'sendInvite',
    ]);
  });

  test('a registered job describes under its export name', () => {
    const notifySubscribers = anonymousJob();
    registerJobs({ notifySubscribers });

    expect(notifySubscribers.describe().name).toBe('notifySubscribers');
  });
});

describe('registerTasks', () => {
  test('an anonymous task takes its export name, on the exported binding itself', () => {
    const nightlyDigest = anonymousTask();
    expect(nightlyDigest.name).toMatch(/^anonymous-task-\d+$/);

    const registered = registerTasks({ nightlyDigest });

    expect(nightlyDigest.name).toBe('nightlyDigest');
    expect(getTask('nightlyDigest')).toBe(nightlyDigest);
    expect(registered).toEqual([nightlyDigest]);
    // The scheduler keys `lastFiredAt` and its occurrence lock off this name.
    expect(nightlyDigest.describe().name).toBe('nightlyDigest');
  });

  test('a declared name wins, and the export name never seats a second entry', () => {
    const nightlyDigest = task({
      name: 'digest.nightly',
      cron: '0 3 * * *',
      tz: 'UTC',
      enqueue: () => [],
    });

    registerTasks({ nightlyDigest });

    expect(nightlyDigest.name).toBe('digest.nightly');
    expect(getTask('nightlyDigest')).toBeUndefined();
    expect(registeredTasks()).toHaveLength(1);
  });

  test('the same handle twice is a no-op; a different one under the name is X_JOB_DUPLICATE', () => {
    const nightlyDigest = anonymousTask();

    registerTasks({ nightlyDigest });
    registerTasks({ nightlyDigest });
    expect(registeredTasks()).toHaveLength(1);

    expect(codeOf(() => registerTasks({ nightlyDigest: anonymousTask() }))).toBe('X_JOB_DUPLICATE');
  });

  test('only handles `task()` built register — a look-alike is not a task', () => {
    expect(
      registerTasks({ nightlyDigest: { kind: 'task' as const, name: 'nightlyDigest' } }),
    ).toEqual([]);
    expect(registeredTasks()).toHaveLength(0);
  });

  test("a task's job list follows the jobs' new names, because it reads the same handles", () => {
    const sendDigest = anonymousJob();
    const nightlyDigest = anonymousTask([sendDigest as AnyJobHandle]);

    registerJobs({ sendDigest });
    registerTasks({ nightlyDigest });

    expect(nightlyDigest.describe().jobs).toEqual(['sendDigest']);
  });
});

describe('one handle, one durable name', () => {
  test('a second export name for the same undeclared job handle is refused', () => {
    const handle = anonymousJob();

    registerJobs({ first: handle });

    // Without the guard the second pass finds `second` free, drops the `first` seat and rebinds —
    // so the lexically last alias silently decides the queue key every queued row was written to.
    expect(codeOf(() => registerJobs({ second: handle }))).toBe('X_JOB_DUPLICATE');
    expect(getJob('first')).toBe(handle as AnyJobHandle);
    expect(getJob('second')).toBeUndefined();
    expect(handle.name).toBe('first');
  });

  test('a second export name for the same undeclared task handle is refused', () => {
    const handle = anonymousTask();

    registerTasks({ nightly: handle });

    expect(codeOf(() => registerTasks({ alsoNightly: handle }))).toBe('X_JOB_DUPLICATE');
    expect(getTask('nightly')).toBe(handle);
    expect(getTask('alsoNightly')).toBeUndefined();
  });

  test('re-registering under the SAME export name stays idempotent', () => {
    const handle = anonymousJob();

    registerJobs({ first: handle });
    registerJobs({ first: handle });

    expect(registeredJobs()).toEqual([handle as AnyJobHandle]);
  });

  test('two jobs declaring one name collide at job(), before either can seat the other out', () => {
    const declared = (): JobHandle<OrgInput> =>
      job<OrgInput>({
        tenant: 'none',
        name: 'send-digest',
        input: passthrough<OrgInput>(),
        idempotencyKey: ({ orgId }) => `digest:${orgId}`,
        retry: { attempts: 3, backoff: 'exponential' },
        run: () => Promise.resolve(),
      });
    const first = declared();

    expect(codeOf(declared)).toBe('X_JOB_DUPLICATE');
    expect(getJob('send-digest')).toBe(first as AnyJobHandle);
  });

  test('two tasks declaring one name collide at task(), not silently at registration', () => {
    const declared = (): TaskHandle =>
      task({ name: 'nightly', cron: '0 3 * * *', tz: 'UTC', enqueue: () => [] });
    const first = declared();

    expect(codeOf(declared)).toBe('X_JOB_DUPLICATE');
    expect(getTask('nightly')).toBe(first);
  });
});

describe('the registrar announcement', () => {
  test('job and task registrars resolve from core after importing the package', () => {
    expect(hasPrimitiveRegistrar('job')).toBe(true);
    expect(hasPrimitiveRegistrar('task')).toBe(true);
    // Identity, not merely presence: `defineApi({ jobs })` must reach THIS registry, not a copy.
    expect(primitiveRegistrar('job')).toBe(registerJobs);
    expect(primitiveRegistrar('task')).toBe(registerTasks);
  });

  test('the announced registrar names a job exactly as the direct call does', () => {
    const onboardOrg = anonymousJob();

    primitiveRegistrar('job')({ onboardOrg });

    expect(getJob('onboardOrg')).toBe(onboardOrg as AnyJobHandle);
  });
});
