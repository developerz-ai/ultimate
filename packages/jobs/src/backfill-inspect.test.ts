// One ledger row, as every surface reports it. The projection is the contract between `x db
// backfill --list`, `/_x`'s panel and MCP — so what it does with a pass that has NOT finished is
// the load-bearing part: no clock is read here, and a running pass therefore has no duration.

import { describe, expect, test } from 'bun:test';
import { backfillForRun, inspectBackfills, toBackfillProgress } from './backfill-inspect';
import type { BackfillLedger, BackfillRun } from './backfill-ledger';
import type { JobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';

const run = (overrides: Partial<BackfillRun> = {}): BackfillRun => ({
  runId: 'run-1',
  name: 'backfillSlugs',
  checksum: 'aaaa',
  status: 'running',
  appVersion: '1.2.0',
  rows: 4200,
  cursor: 'id-42',
  startedAt: Date.parse('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('toBackfillProgress', () => {
  test('a finished pass reports ISO timestamps and its own elapsed span', () => {
    expect(
      toBackfillProgress(
        run({
          status: 'completed',
          cursor: null,
          completedAt: Date.parse('2026-01-01T00:01:30.000Z'),
        }),
      ),
    ).toEqual({
      runId: 'run-1',
      name: 'backfillSlugs',
      status: 'completed',
      checksum: 'aaaa',
      appVersion: '1.2.0',
      rows: 4200,
      cursor: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:30.000Z',
      durationMs: 90_000,
    });
  });

  test('a running pass has NO duration — an elapsed time would differ per reader', () => {
    // Nothing in this file reads a clock, deliberately: "how long has this been going" computed
    // against the reader's wall clock is a different number in every process that asks.
    const progress = toBackfillProgress(run());
    expect(progress.completedAt).toBeNull();
    expect(progress.durationMs).toBeNull();
    // The cursor survives, because "where it got to" is exactly what a running pass is asked.
    expect(progress.cursor).toBe('id-42');
  });
});

describe('inspectBackfills', () => {
  test('a driver that ships no ledger answers an EMPTY list, never a throw', async () => {
    // `x jobs ls` and the jobs panel report the queue; a queue that failed on "no backfills
    // recorded" would be a broken command for a fact nobody asked about.
    // The key is REMOVED, not set to `undefined`: `backfills?: BackfillLedger` under
    // `exactOptionalPropertyTypes` is "absent or a ledger", and a driver that ships no ledger is
    // one where the property does not exist — which is also the only shape a real driver has.
    const { backfills: _ledger, ...withoutLedger } = createMemoryDriver();
    const driver: JobDriver = withoutLedger;
    expect(Object.hasOwn(driver, 'backfills')).toBe(false);
    expect(await inspectBackfills(driver)).toEqual([]);
  });

  test('the filter reaches the ledger unchanged, so a field added to it is not dropped here', async () => {
    const { driver, filters } = driverWithRuns([]);
    await inspectBackfills(driver, { name: 'backfillSlugs', status: 'completed', limit: 5 });
    expect(filters).toEqual([{ name: 'backfillSlugs', status: 'completed', limit: 5 }]);
  });

  test('every row comes back projected, not raw', async () => {
    const { driver } = driverWithRuns([run({ completedAt: run().startedAt + 1_000 })]);
    const rows = await inspectBackfills(driver);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(rows[0]?.durationMs).toBe(1_000);
  });
});

describe('backfillForRun', () => {
  test('keys by RUN, with a limit of one — `force` writes a second row for the same name', async () => {
    const { driver, filters } = driverWithRuns([run({ runId: 'run-9' })]);
    const found = await backfillForRun(driver, 'run-9');
    expect(filters).toEqual([{ runId: 'run-9', limit: 1 }]);
    expect(found?.runId).toBe('run-9');
  });

  test('a run that swept nothing is undefined, not an empty projection', async () => {
    const { driver } = driverWithRuns([]);
    expect(await backfillForRun(driver, 'run-9')).toBeUndefined();
  });
});

function driverWithRuns(runs: readonly BackfillRun[]): {
  driver: JobDriver;
  filters: unknown[];
} {
  const filters: unknown[] = [];
  const ledger: BackfillLedger = {
    start: () => Promise.resolve(),
    progress: () => Promise.resolve(),
    finish: () => Promise.resolve(),
    list: (filter) => {
      filters.push(filter);
      return Promise.resolve(runs);
    },
  };
  return { driver: { ...createMemoryDriver(), backfills: ledger }, filters };
}
