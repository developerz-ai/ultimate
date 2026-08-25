// One `exportRows()` pass: the paging, its durable checkpoints, and the three properties that make
// this a framework feature rather than a loop an app writes.
//
//   1. RESUMABLE — a killed attempt restarts at the page it stopped on, not at the top.
//   2. REPLAY-SAFE — a page that runs twice REWRITES its part; the artifact cannot gain a row.
//   3. STREAMING — a page is written before the next one is read, so the heap holds a page and
//      never the dataset. The interleaving assertion below fails on any rewrite that buffers.

import { beforeEach, describe, expect, test } from 'bun:test';
import { type Ctx, createContext, isUltimateError } from '@ultimat3/core';
import { entity, memoryRepo, tableFor, text, uuid } from '@ultimat3/entity';
import { t } from '@ultimat3/schema';
import { JobAbortedError } from './errors';
import { exportRows } from './export';
import { exportManifestKey, exportPartKey, memoryExportSink } from './export-sink';
import { resetJobs } from './job';
import { createMemoryStepStore, createStepRunner, type StepStore } from './steps';

const rows = entity('export_pass_rows', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), title: text({ max: 40 }) },
});

type Row = typeof rows.$row;

const ORG = '00000000-0000-7000-8000-0000000000a1';
const RUN_ID = 'run-export-1';

const SEED: Row[] = Array.from({ length: 10 }, (_, index) => ({
  id: `00000000-0000-7000-8000-0000000000${String(index).padStart(2, '0')}`,
  orgId: ORG,
  title: `row ${index}`,
}));

const ctx: Ctx = createContext();

interface Harness {
  readonly store: StepStore;
  readonly sink: ReturnType<typeof memoryExportSink>;
  /** Completed steps at the moment of each `put`. Flat means buffering; 0,1,2,… means streaming. */
  readonly stepsAtPut: number[];
  /** Pages this attempt should die on, by index. */
  readonly failOn: Set<number>;
  run(): Promise<unknown>;
  text(index: number): string;
}

let sequence = 0;

const harness = (
  options: { batch?: number; maxPartBytes?: number; format?: 'ndjson' | 'csv' } = {},
): Harness => {
  sequence += 1;
  const store = createMemoryStepStore();
  const stepsAtPut: number[] = [];
  const failOn = new Set<number>();
  let completed = 0;
  const sink = memoryExportSink({
    onPut: () => {
      stepsAtPut.push(completed);
    },
  });
  let page = 0;

  const handle = exportRows<Row, { readonly orgId: string }>({
    name: `orders-${sequence}`,
    input: t.object({ orgId: t.string }),
    tenant: 'none',
    prefix: ({ orgId }) => `exports/${orgId}`,
    source: () => tableFor(rows, memoryRepo(rows, SEED)).where({ orgId: ORG }),
    format: options.format ?? 'csv',
    columns: ['id', 'title'],
    row: (record) => {
      // Dies BETWEEN the work and its checkpoint, which is the shape at-least-once is about. A
      // real cancellation and not a bare `Error`: this is INPUT to the code under test — the
      // failure a worker that lost its lease mid-page actually raises — never this test's verdict.
      if (failOn.has(page)) throw new JobAbortedError({ job: `orders-${sequence}`, step: 'page' });
      return { id: record.id, title: record.title };
    },
    sink,
    ...(options.batch === undefined ? {} : { batch: options.batch }),
    ...(options.maxPartBytes === undefined ? {} : { maxPartBytes: options.maxPartBytes }),
  });

  return {
    store,
    sink,
    stepsAtPut,
    failOn,
    run: (): Promise<unknown> => {
      page = 0;
      completed = 0;
      const runner = createStepRunner({ runId: RUN_ID, jobName: `orders-${sequence}`, store });
      // `page` names which batch `row()` is running for, so `failOn` can pick one; `completed`
      // counts the checkpoints that have LANDED, which is what the interleaving assertion reads.
      const step = {
        ...runner.step,
        run: async (name: string, body: (signal: AbortSignal) => unknown) => {
          const index = Number.parseInt(name.replace('page:', ''), 10);
          if (Number.isFinite(index)) page = index;
          const out: unknown = await runner.step.run(name, body as never);
          if (name.startsWith('page:')) completed += 1;
          return out;
        },
      } as unknown as typeof runner.step;
      return handle.run({
        input: { orgId: ORG },
        step,
        ctx,
        attempt: 1,
        jobId: `job-${sequence}`,
        runId: RUN_ID,
      });
    },
    text: (index: number): string =>
      new TextDecoder().decode(
        sink.objects().get(exportPartKey(`exports/${ORG}`, index, options.format ?? 'csv')) ??
          new Uint8Array(0),
      ),
  };
};

beforeEach(() => {
  resetJobs();
  sequence = 0;
});

describe('a pass that completes', () => {
  test('writes one part per page plus a manifest, and every row exactly once', async () => {
    const one = harness({ batch: 4 });
    await one.run();

    const keys = [...one.sink.objects().keys()].sort();
    expect(keys).toEqual([
      `exports/${ORG}/manifest.json`,
      `exports/${ORG}/part-00000.csv`,
      `exports/${ORG}/part-00001.csv`,
      `exports/${ORG}/part-00002.csv`,
    ]);
    // The header rides in part 0 only, so `cat part-*` is one valid csv.
    expect(one.text(0)).toStartWith('id,title\n');
    expect(one.text(1)).not.toContain('id,title');

    const all = [0, 1, 2].map((index) => one.text(index)).join('');
    for (const row of SEED) expect(all).toContain(row.title);
    expect(all.split('\n').filter((line) => line !== '')).toHaveLength(SEED.length + 1);
  });

  test('the manifest counts the parts rather than listing them', async () => {
    const one = harness({ batch: 4 });
    const report = (await one.run()) as { parts: number; rows: number; manifestKey: string };

    const manifest: unknown = JSON.parse(
      new TextDecoder().decode(one.sink.objects().get(exportManifestKey(`exports/${ORG}`))),
    );
    const facts = manifest as { parts: number; rows: number; columns: string[]; format: string };
    expect(facts.parts).toBe(3);
    expect(facts.rows).toBe(10);
    expect(facts.columns).toEqual(['id', 'title']);
    expect(facts.format).toBe('csv');
    expect(report.parts).toBe(3);
    expect(report.rows).toBe(10);
    expect(report.manifestKey).toBe(exportManifestKey(`exports/${ORG}`));
  });

  test('a part is written before the next page is read', async () => {
    // THE memory assertion. `stepsAtPut[n]` is how many pages had been checkpointed when part `n`
    // was written: streaming gives 0,1,2,…, and anything that accumulates the dataset and writes
    // at the end gives a flat run of the final count. A `maxPartBytes` cannot catch that rewrite;
    // this can.
    const one = harness({ batch: 2 });
    await one.run();
    expect(one.stepsAtPut.slice(0, 5)).toEqual([0, 1, 2, 3, 4]);
  });

  test('a page larger than a part may hold is refused where the bound is declared', async () => {
    const one = harness({ batch: 10, maxPartBytes: 16 });
    let thrown: unknown;
    try {
      await one.run();
    } catch (error) {
      thrown = error;
    }
    expect(isUltimateError(thrown) ? thrown.code : undefined).toBe('X_EXPORT_PART_TOO_LARGE');
  });
});

describe('a pass that is killed', () => {
  test('resumes on the page it stopped at and never re-reads the ones behind it', async () => {
    const one = harness({ batch: 4 });
    one.failOn.add(1);

    let thrown: unknown;
    try {
      await one.run();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    // Page 0 landed and is checkpointed; page 1 died before its checkpoint.
    expect(one.sink.writes().map((write) => write.key)).toEqual([
      exportPartKey(`exports/${ORG}`, 0, 'csv'),
    ]);

    one.failOn.clear();
    one.stepsAtPut.length = 0;
    await one.run();

    // Page 0 was served from the step store: its body did not run, so nothing rewrote part 0.
    expect(one.sink.writes().map((write) => write.key)).toEqual([
      exportPartKey(`exports/${ORG}`, 0, 'csv'),
      exportPartKey(`exports/${ORG}`, 1, 'csv'),
      exportPartKey(`exports/${ORG}`, 2, 'csv'),
      exportManifestKey(`exports/${ORG}`),
    ]);
    const all = [0, 1, 2].map((index) => one.text(index)).join('');
    expect(all.split('\n').filter((line) => line !== '')).toHaveLength(SEED.length + 1);
  });

  test('a page that ran twice REWRITES its part, so the artifact cannot gain a row', async () => {
    // At-least-once means a page can run again after its work landed and before its checkpoint
    // did. For a backfill the answer is an idempotent statement; here it is the KEY: the part is
    // named by the page index, so a second run of page 1 overwrites part-00001 with the same
    // bytes. An append-based artifact would have duplicated four rows here.
    const one = harness({ batch: 4 });
    one.failOn.add(2);
    try {
      await one.run();
    } catch {
      // The third page dies; pages 0 and 1 have already written their parts.
    }
    const first = one.text(1);
    one.failOn.clear();
    // A FRESH run id would replay nothing, so drive the same one with page 1's checkpoint dropped:
    // exactly the window at-least-once opens.
    await one.store.del(RUN_ID, 'page:1');
    await one.run();

    expect(one.text(1)).toBe(first);
    const all = [0, 1, 2].map((index) => one.text(index)).join('');
    expect(all.split('\n').filter((line) => line !== '')).toHaveLength(SEED.length + 1);
  });
});
