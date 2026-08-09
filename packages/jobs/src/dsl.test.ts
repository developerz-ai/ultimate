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
import { describeJob } from './describe';
import { resetJobDriver, setJobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import type { JobHandle } from './job';
import { job, resetJobs } from './job';
import { resetJobsFacade } from './outbox';
import { resetTasks, task } from './scheduler';

/** Minimal Standard Schema so these tests do not depend on ArkType's surface. */
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

  test('.entries() delegates to the declared enqueue() thunk verbatim', () => {
    const notify = defineJob();
    const entries: readonly (readonly [JobHandle<OrgInput>, OrgInput])[] = [
      [notify, { orgId: 'org-1' }],
    ];
    const handle = task({
      name: 'dslDigest2',
      cron: '0 3 * * *',
      tz: 'UTC',
      enqueue: () => entries,
    });
    expect(handle.entries()).toBe(entries);
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
