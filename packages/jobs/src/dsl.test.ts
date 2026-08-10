/**
 * Pins the `job` and `task` DSL surfaces. `job.test.ts`/`scheduler.test.ts` prove
 * the fluent methods behave correctly; this file proves the *shape* cannot
 * silently drift — every documented member still exists — and that `describe()`
 * on each handle is a thin binding to its projection function, never a second
 * implementation. A member renamed, dropped, or quietly reimplemented here
 * fails this test, not just a downstream consumer.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { nowMs } from './clock';
import { describeJob } from './describe';
import { resetJobDriver, setJobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import type { JobHandle } from './job';
import { job, resetJobs } from './job';
import { resetJobsFacade } from './outbox';
import type { TaskEnqueueEntry, TaskHandle } from './scheduler';
import { resetTasks, task } from './scheduler';

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

// The exact contract: `JobHandle<I>` (job.ts) — one flat interface, no separate
// "façade" split, because a job has exactly one surface: the queue. Kept in sync
// by hand on purpose — a silent drift here is exactly the regression this file
// exists to catch.
const JOB_MEMBERS = [
  'kind',
  'name',
  'queue',
  'retry',
  'concurrency',
  'timeoutMs',
  'input',
  'parse',
  'idempotencyKeyFor',
  'run',
  'enqueue',
  'as',
  'describe',
] as const;

const TASK_MEMBERS = [
  'kind',
  'name',
  'cron',
  'tz',
  'catchUp',
  'maxCatchUp',
  'entries',
  'enqueue',
  'describe',
] as const;

function defineJob(): JobHandle<OrgInput> {
  return job<OrgInput>({
    name: 'dslNotify',
    input: passthrough<OrgInput>(),
    idempotencyKey: ({ orgId }) => `dsl-notify:${orgId}`,
    retry: { attempts: 3 },
    run: () => Promise.resolve(),
  });
}

/** 2023-11-14T22:13:20Z — any fixed instant that is nowhere near the wall clock. */
const OCCURRENCE_MS = 1_700_000_000_000;

interface RecordingTask {
  readonly handle: TaskHandle;
  readonly entries: readonly TaskEnqueueEntry[];
  /** Every occurrence the handle handed to the declaration, in call order. */
  readonly seen: readonly number[];
}

function defineRecordingTask(name: string): RecordingTask {
  const notify = defineJob();
  const entries: readonly TaskEnqueueEntry[] = [[notify, { orgId: 'org-1' }]];
  const seen: number[] = [];
  const handle = task({
    name,
    cron: '0 3 * * *',
    tz: 'UTC',
    enqueue: (occurrenceMs) => {
      seen.push(occurrenceMs);
      return entries;
    },
  });
  return { handle, entries, seen };
}

beforeEach(() => {
  resetJobs();
  resetTasks();
  resetJobsFacade();
  resetJobDriver();
});

afterEach(() => {
  resetJobDriver();
  resetJobsFacade();
});

describe('the job DSL surface', () => {
  test('a built job handle carries every documented member', () => {
    const handle = defineJob();
    for (const member of JOB_MEMBERS) expect(handle).toHaveProperty(member);
  });

  test('.describe() delegates to describeJob() — the handle itself is the input', () => {
    const handle = defineJob();
    expect(handle.describe()).toEqual(describeJob(handle));
  });

  test('.enqueue() and .as() go through one path: the ambient jobs facade', async () => {
    const handle = defineJob();
    const driver = createMemoryDriver();
    setJobDriver(driver);

    await handle.enqueue({ orgId: 'org-1' });
    await handle.as({ orgId: 'org-2' }, { orgId: 'org-2' });

    const rows = (await driver.introspect?.list()) ?? [];
    expect(rows.length).toBe(2);
    // `.as()` enqueued with the actor's org as tenantId — proof it calls
    // `.enqueue()` rather than talking to the driver a second way.
    expect(rows.find((row) => row.idempotencyKey === 'dsl-notify:org-2')?.tenantId).toBe('org-2');
  });
});

describe('the task DSL surface', () => {
  test('a built task handle carries every documented member', () => {
    const notify = defineJob();
    const handle = task({
      name: 'dslDigest',
      cron: '0 3 * * *',
      tz: 'UTC',
      enqueue: () => [[notify, { orgId: 'org-1' }]],
    });
    for (const member of TASK_MEMBERS) expect(handle).toHaveProperty(member);
  });

  test('.entries(occurrenceMs) delegates to the declared enqueue(), occurrence and all', () => {
    const recorder = defineRecordingTask('dslDigest2');
    expect(recorder.handle.entries(OCCURRENCE_MS)).toBe(recorder.entries);
    // The occurrence reaches the declaration untouched: that argument is the only way a
    // payload can describe the occurrence being fired rather than the worker's wall clock.
    expect(recorder.seen).toEqual([OCCURRENCE_MS]);
  });

  test('.entries() with no occurrence defaults to now — the manual and describe() paths', () => {
    // `nowMs()` and never `Date.now()`: the default occurrence is this package's own reading of
    // the injected Clock, which the preload freezes, so this is one exact instant rather than a
    // window sampled around the assertion. A window would pass just as well if the default were
    // some other reading entirely.
    const frozen = nowMs();
    const recorder = defineRecordingTask('dslDigest2b');
    recorder.handle.entries();
    recorder.handle.describe();

    // Both paths, and neither is `OCCURRENCE_MS`: the default comes from the clock, not from the
    // argument the test above passed.
    expect(recorder.seen).toEqual([frozen, frozen]);
  });

  test('.enqueue() fires each entry through the job handle it declared, not a copy', async () => {
    const notify = defineJob();
    const driver = createMemoryDriver();
    setJobDriver(driver);

    const handle = task({
      name: 'dslDigest3',
      cron: '0 3 * * *',
      tz: 'UTC',
      enqueue: () => [[notify, { orgId: 'org-9' }]],
    });
    const fired = await handle.enqueue();

    expect(fired.length).toBe(1);
    expect(fired[0]?.job).toBe(notify.name);
    expect(fired[0]?.result.deduped).toBe(false);
    const rows = (await driver.introspect?.list()) ?? [];
    expect(rows[0]?.idempotencyKey).toBe('dsl-notify:org-9');
  });

  test('.describe() reports this handle own fields, not the definition defaults', () => {
    const notify = defineJob();
    const handle = task({
      name: 'dslDigest4',
      cron: '0 3 * * *',
      tz: 'America/Bogota',
      catchUp: 'run-once',
      maxCatchUp: 3,
      enqueue: () => [[notify, { orgId: 'org-1' }]],
    });
    expect(handle.describe()).toEqual({
      kind: 'task',
      name: 'dslDigest4',
      cron: '0 3 * * *',
      tz: 'America/Bogota',
      catchUp: 'run-once',
      maxCatchUp: 3,
      jobs: [notify.name],
    });
  });
});
