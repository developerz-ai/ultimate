// `importRows()` through the real execution path — enqueued, claimed and run by `executeJob`, which
// is the frame that installs the run's tenant and its step store. Two guarantees: a run killed
// mid-file resumes at its checkpoint with exact row counts, and `tenant: 'none'` FAILS CLOSED on a
// tenant-scoped write instead of writing one file's rows into whichever org they name.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, userActor } from '@ultimat3/core';
import { clearRegistry, entity, memoryRepo, tableFor, text, uuid } from '@ultimat3/entity';
import { t } from '@ultimat3/schema';
import { installJobDriver, resetJobDriver } from './adapter';
import type { ClaimedJob, JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { DriverUnavailableError } from './errors';
import { executeJob } from './execute';
import type { JobExecution } from './execute-result';
import { encodeExportPage } from './export-format';
import { memoryExportSink } from './export-sink';
import type { ImportReport } from './import';
import { importRows } from './import';
import { memoryImportSource } from './import-source';
import type { AnyJobHandle } from './job';
import { resetJobs } from './job';

const people = entity('import_job_people', {
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), name: text({ max: 40 }) },
  indexes: [{ on: ['orgId', 'id'], unique: true }],
});
type Person = typeof people.$row;

const ORG = '00000000-0000-7000-8000-0000000000b1';
const idAt = (n: number): string =>
  `00000000-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`;
const FILE = encodeExportPage({
  subject: 'people',
  format: 'csv',
  columns: ['id', 'name'],
  records: Array.from({ length: 30 }, (_, n) => ({ id: idAt(n), name: `person ${n}` })),
  header: true,
});
const KEY = `imports/${ORG}/people.csv`;
const Input = t.object({ orgId: t.uuid });

let driver: JobDriver;
let table: ReturnType<typeof tableFor<Person, typeof people.$columns>>;

/** One import whose `handle` writes the rows into a tenant-scoped table. */
const declare = (name: string, tenant: 'none' | ((input: { orgId: string }) => string)) => {
  const pages: number[] = [];
  let blipOn: number | undefined;
  const handle = importRows<{ id: string; name: string }, { orgId: string }>({
    name,
    input: Input,
    tenant,
    source: () => memoryImportSource({ [KEY]: FILE }),
    key: ({ orgId }) => `imports/${orgId}/people.csv`,
    format: 'csv',
    columns: ['id', 'name'],
    schema: t.object({ id: t.uuid, name: t.string }),
    handle: async ({ rows, input }) => {
      await table.upsertAll(
        rows.map((row) => ({ ...row, orgId: input.orgId })),
        { onConflict: ['orgId', 'id'] },
      );
      pages.push(rows.length);
      if (blipOn === pages.length - 1) {
        blipOn = undefined;
        // INPUT to the code under test — a page dying after its write — never this test's verdict.
        throw new DriverUnavailableError({ driver: 'db', cause: 'blip', fix: 'retry' });
      }
    },
    errors: { sink: () => memoryExportSink(), prefix: ({ orgId }) => `imports/${orgId}/errors` },
    batch: 8,
    pageBytes: 512,
    maxRecordBytes: 256,
    retry: { attempts: 3, backoff: 'fixed', delay: 0, jitter: 'none' },
  });
  return {
    handle: handle as AnyJobHandle,
    pages,
    blip: (page: number) => {
      blipOn = page;
    },
  };
};

/** Enqueue once, then claim and execute until the run settles, as a worker would. */
const runToEnd = async (handle: AnyJobHandle): Promise<JobExecution[]> => {
  const tenantId = handle.tenantFor({ orgId: ORG });
  await driver.enqueue({
    name: handle.name,
    queue: handle.queue,
    input: { orgId: ORG },
    idempotencyKey: `${handle.name}:${KEY}`,
    ...(tenantId === undefined ? {} : { tenantId }),
    maxAttempts: 3,
  });
  const executions: JobExecution[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [claimed] = await driver.claim({
      queues: [handle.queue],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'w1',
    });
    if (claimed === undefined) break;
    const ctx = ctxOf({ role: 'worker', actor: userActor({ id: 'worker-1' }) });
    executions.push(await executeJob({ driver, claimed: claimed as ClaimedJob, handle, ctx }));
  }
  return executions;
};

beforeEach(() => {
  resetJobs();
  table = tableFor(people, memoryRepo(people, []));
  driver = memoryJobDriver();
  installJobDriver(driver);
});

afterEach(() => {
  resetJobDriver();
});

afterAll(() => {
  resetJobs();
  clearRegistry();
});

describe('importRows run by executeJob', () => {
  test('killed mid-file, it resumes at its checkpoint and lands every row exactly once', async () => {
    const declared = declare('people-import-resume', ({ orgId }) => orgId);
    declared.blip(2);
    const executions = await runToEnd(declared.handle);

    expect(executions.map((run) => run.outcome)).toEqual(['retried', 'completed']);
    // A 512-byte page holds ten rows, handed over as 8 then 2. The third call — page 1's first
    // batch — dies after its write: page 0 replays from storage, and only those 8 run twice.
    expect(declared.pages).toEqual([8, 2, 8, 8, 2, 8, 2]);
    expect(declared.pages.reduce((total, n) => total + n, 0)).toBe(30 + 8);
    expect(executions[1]?.replayed).toEqual(['stat', 'page:0']);
    expect(executions[1]?.result as ImportReport).toMatchObject({ rows: 30, rejected: 0 });
    const stored = await table.where({ orgId: ORG }).all();
    expect(stored).toHaveLength(30);
  });

  test("tenant: 'none' fails closed on a tenant-scoped write", async () => {
    const declared = declare('people-import-none', 'none');
    const executions = await runToEnd(declared.handle);

    expect(executions.at(-1)?.outcome).not.toBe('completed');
    expect(executions.at(-1)?.error).toContain('X_TENANCY_ACTOR_ORG_REQUIRED');
    expect(declared.pages).toEqual([]);
  });
});
