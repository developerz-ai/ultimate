// Declared minus completed. The first test is the incident: four sweeps merged, deployed, never
// enqueued — no ledger row, and before this diff no surface anywhere that could say so.

import { describe, expect, test } from 'bun:test';
import type { BackfillProgress } from './backfill-inspect';
import type { BackfillStatus } from './backfill-ledger';
import { pendingBackfills } from './backfill-pending';
import type { BackfillDeclaration } from './backfill-registry';

const declaration = (
  name: string,
  over: Partial<BackfillDeclaration> = {},
): BackfillDeclaration => ({
  kind: 'backfill',
  name,
  checksum: `sum-${name}`,
  requires: null,
  environments: null,
  counts: false,
  ...over,
});

const run = (
  name: string,
  status: BackfillStatus,
  over: Partial<BackfillProgress> = {},
): BackfillProgress => ({
  runId: `run-${name}-${status}`,
  name,
  checksum: `sum-${name}`,
  status,
  appVersion: '1.2.0',
  rows: 12,
  cursor: null,
  startedAt: new Date(1_000).toISOString(),
  completedAt: status === 'running' ? null : new Date(2_000).toISOString(),
  durationMs: status === 'running' ? null : 1_000,
  ...over,
});

describe('unit · declared minus completed', () => {
  test('four merged sweeps that were never enqueued are all pending', () => {
    const report = pendingBackfills({
      declarations: ['b-0003', 'b-0004', 'b-0005', 'b-0006'].map((name) => declaration(name)),
      runs: [],
      environment: 'production',
    });
    expect(report.pending.map((row) => row.name)).toEqual(['b-0003', 'b-0004', 'b-0005', 'b-0006']);
    expect(report.rows.every((row) => row.state === 'pending')).toBe(true);
    expect(report.orphaned).toEqual([]);
  });

  test('a completed pass is not pending, and its state survives a later failed rerun', () => {
    // Only `completed` blocks a re-run — `decideBackfill` reads the same fact, so the diff and the
    // pass must not disagree about a name whose forced rerun then failed.
    const report = pendingBackfills({
      declarations: [declaration('rewrite-titles')],
      runs: [run('rewrite-titles', 'failed'), run('rewrite-titles', 'completed')],
      environment: 'production',
    });
    expect(report.rows[0]?.state).toBe('completed');
    expect(report.pending).toEqual([]);
  });

  test('a pass in flight is progress, never the alarm', () => {
    const report = pendingBackfills({
      declarations: [declaration('rewrite-titles')],
      runs: [run('rewrite-titles', 'running')],
      environment: 'production',
    });
    expect(report.rows[0]?.state).toBe('running');
    // A check that went red for the whole duration of every sweep is a check nobody leaves wired.
    expect(report.pending).toEqual([]);
  });

  test('a failed pass IS the alarm — the queue may have dead-lettered it', () => {
    const report = pendingBackfills({
      declarations: [declaration('rewrite-titles')],
      runs: [run('rewrite-titles', 'failed')],
      environment: 'production',
    });
    expect(report.rows[0]?.state).toBe('failed');
    expect(report.pending.map((row) => row.name)).toEqual(['rewrite-titles']);
  });

  test('a sweep this environment may not run is EXCLUDED, not pending', () => {
    // Without this, a production-only cleanup read in staging is permanent drift and the alarm
    // gets muted within a week.
    const report = pendingBackfills({
      declarations: [declaration('drop-legacy', { environments: ['production'] })],
      runs: [],
      environment: 'staging',
    });
    expect(report.rows[0]?.state).toBe('excluded');
    expect(report.pending).toEqual([]);
  });

  test('a completed pass under a different definition is REPORTED, never refused', () => {
    const report = pendingBackfills({
      declarations: [declaration('rewrite-titles', { checksum: 'moved' })],
      runs: [run('rewrite-titles', 'completed')],
      environment: 'production',
    });
    expect(report.rows[0]?.changed).toBe(true);
    expect(report.rows[0]?.ledgerChecksum).toBe('sum-rewrite-titles');
    expect(report.pending).toEqual([]);
  });

  test('a ledger name no declaration carries is orphaned, deduped and sorted', () => {
    const report = pendingBackfills({
      declarations: [declaration('rewrite-titles')],
      runs: [
        run('zzz-deleted', 'completed'),
        run('aaa-deleted', 'completed'),
        run('zzz-deleted', 'failed'),
        run('rewrite-titles', 'completed'),
      ],
      environment: 'production',
    });
    expect(report.orphaned).toEqual(['aaa-deleted', 'zzz-deleted']);
  });

  test('the report carries the environment it judged in, so --json is self-describing', () => {
    const report = pendingBackfills({ declarations: [], runs: [], environment: 'test' });
    expect(report.environment).toBe('test');
    expect(report.rows).toEqual([]);
  });
});
