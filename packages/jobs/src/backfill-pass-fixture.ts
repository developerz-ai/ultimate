// The fixture two files drive one `backfill()` pass through: a real `@ultimat3/entity` chain over
// a real `memoryRepo`, wrapped so every statement, iteration and close is counted. Shared rather
// than copied because `backfill-pass.test.ts` (the iteration and its checkpoints) and
// `backfill-pass-ledger.test.ts` (the `x_backfills` row it writes) must drive the SAME pass — two
// harnesses that drifted would be two passes agreeing only by construction.
import type { Ctx, Environment } from '@ultimat3/core';
import { assert, createContext } from '@ultimat3/core';
import type { BatchIterator, ReadBuilder, Repo } from '@ultimat3/entity';
import { entity, memoryRepo, tableFor, text, uuid } from '@ultimat3/entity';
import type { BackfillInput } from './backfill';
import { backfill } from './backfill';
import type { BackfillLedger } from './backfill-ledger';
import { setJobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import type { StepRecord, StepStore } from './steps';
import { createMemoryStepStore, createStepRunner } from './steps';

/**
 * What a failing `handle` raises. Deliberately NOT an `UltimateError`: a backfill handler is app
 * code, the pass propagates whatever it threw, and a fixture raising a framework code would
 * exercise a path no app takes. Named rather than anonymous so a suite can assert on the type.
 * A `-fixture.ts` file is excluded from the package tarball — this is test material.
 */
export class BackfillHandleFailure extends Error {
  constructor(readonly index: number) {
    super(`batch ${String(index)} failed`);
    this.name = 'BackfillHandleFailure';
  }
}

export const rows = entity('backfill_test_rows', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), title: text({ max: 40 }) },
});

export type Row = typeof rows.$row;

export const ORG = '00000000-0000-7000-8000-0000000000a1';
const OTHER = '00000000-0000-7000-8000-0000000000a2';

/** Sortable ids, ten apart, so the keyset cursor between two pages is a real position. */
const id = (index: number): string =>
  `00000000-0000-7000-8000-0000000001${String(index).padStart(2, '0')}`;

const row = (index: number, orgId: string = ORG): Row => ({
  id: id(index),
  orgId,
  title: `row-${index}`,
});

/** Ten rows for the org under test, two more no pass may ever touch. */
export const SEED: readonly Row[] = [
  ...Array.from({ length: 10 }, (_unused, index) => row(index * 10)),
  row(900, OTHER),
  row(910, OTHER),
];

/** What the wrappers below record: statements sent, iterations opened, iterations closed. */
interface Watch {
  reads: number;
  opens: number;
  closes: number;
}

const newWatch = (): Watch => ({ reads: 0, opens: 0, closes: 0 });

/** `cursor` is a getter on the real iterator, so it is forwarded rather than spread-copied. */
const watchedIterator = (iterator: BatchIterator<Row>, watch: Watch): BatchIterator<Row> => {
  const close = async (): Promise<void> => {
    watch.closes += 1;
    await iterator.close();
  };
  return {
    get cursor(): string | null {
      return iterator.cursor;
    },
    [Symbol.asyncIterator]: () => iterator[Symbol.asyncIterator](),
    close,
    [Symbol.asyncDispose]: close,
  };
};

/** `after()` returns a NEW chain, so the wrapper has to survive it — the factory calls both. */
const watchedChain = (chain: ReadBuilder<Row>, watch: Watch): ReadBuilder<Row> => ({
  ...chain,
  after: (cursor) => watchedChain(chain.after(cursor), watch),
  inBatches: (size) => {
    watch.opens += 1;
    return watchedIterator(chain.inBatches(size), watch);
  },
});

const countingRepo = (repo: Repo<Row>, watch: Watch): Repo<Row> => ({
  ...repo,
  findMany: async (args) => {
    watch.reads += 1;
    return repo.findMany(args);
  },
});

export interface Harness {
  readonly watch: Watch;
  readonly store: StepStore;
  /** Titles handed to the body, one entry per batch it actually ran. */
  readonly seen: readonly (readonly string[])[];
  /** Every batch index the body should reject on. */
  failOn: ReadonlySet<number>;
  /** A run id of its own is a NEW pass; the default is a retry of the same one. */
  run(options?: { runId?: string; input?: BackfillInput }): Promise<unknown>;
  steps(): Promise<readonly StepRecord[]>;
}

export const RUN_ID = 'run-backfill-1';

/** Above the millisecond a timer can resolve, so the pacer skips every wait and nothing sleeps. */
export const NO_WAIT_RATE = 100_000;

export const ctx: Ctx = createContext();

/**
 * One backfill over `SEED`, driven through a real step runner rather than a worker: this file is
 * about the pass and its checkpoints, and `execute.ts` already owns what a driver does with the
 * outcome. Every `run()` is a fresh attempt against the SAME store and run id, which is exactly
 * what a retry is.
 */
export const harness = (
  options: {
    batch?: number;
    name?: string;
    store?: StepStore;
    /** Declared as data; the pass refuses outright when this process is not one of them. */
    environments?: readonly Environment[];
    /** Rows the sweep's own predicate still matches. The stall detector's input. */
    count?: () => number;
  } = {},
): Harness => {
  const watch = newWatch();
  const store = options.store ?? createMemoryStepStore();
  const seen: string[][] = [];
  const table = tableFor(rows, countingRepo(memoryRepo(rows, SEED), watch));
  const state: Harness = {
    watch,
    store,
    seen,
    failOn: new Set<number>(),
    async run(runOptions = {}) {
      const runId = runOptions.runId ?? RUN_ID;
      const runner = createStepRunner({ runId, jobName: 'backfill', store });
      return handle.run({
        input: runOptions.input ?? {},
        step: runner.step,
        ctx,
        attempt: 1,
        jobId: 'job-1',
        runId,
      });
    },
    steps: () => store.list(RUN_ID),
  };
  const handle = backfill<Row>({
    tenant: 'none',
    name: options.name ?? 'rewrite-titles',
    // Every test on this harness is about the iteration and not the throttle, so it declares a
    // rate no timer can resolve and the pacer skips each wait. `the rate throttle` owns pacing.
    rate: NO_WAIT_RATE,
    ...(options.batch === undefined ? {} : { batch: options.batch }),
    ...(options.environments === undefined ? {} : { environments: options.environments }),
    ...(options.count === undefined ? {} : { count: options.count }),
    source: () => watchedChain(table.where({ orgId: ORG }), watch),
    handle: ({ rows: page, index }) => {
      if (state.failOn.has(index)) throw new BackfillHandleFailure(index);
      seen.push(page.map((entry) => entry.title));
    },
  });
  return state;
};

/**
 * The ledger hangs off the installed queue driver, so a test that wants one installs a driver.
 * Every test above this line runs with none — which is the documented degradation, and why the
 * pass and its checkpoints are pinned without one.
 */
export const installLedger = (): BackfillLedger => {
  const driver = createMemoryDriver();
  setJobDriver(driver);
  const ledger = driver.backfills;
  // Never a bare `Error`: `backfills` is optional on `JobDriver`, so this is a claim about the
  // memory driver, and the fix names the file that would have to change for it to stop holding.
  assert(
    ledger !== undefined,
    'createMemoryDriver() shipped no backfill ledger, and every test that installs one needs it',
    'restore driver-memory.ts: createMemoryBackfillLedger(clock) on JobDriver.backfills',
  );
  return ledger;
};
