// The table is a rendering decision, so it is tested against literal records rather than a
// driver: what is asserted here is column order, padding and the run-at unit — nothing that a
// queue could change out from under it.

import { describe, expect, test } from 'bun:test';
import type { JobRecord } from '@ultimat3/jobs';
import { renderJobTable } from './jobs-table';

const record = (overrides: Partial<JobRecord> = {}): JobRecord => ({
  id: 'job_1',
  name: 'send-email',
  queue: 'default',
  input: { to: 'a@b.c' },
  idempotencyKey: 'key-1',
  runId: 'run_1',
  attempt: 0,
  maxAttempts: 3,
  state: 'ready',
  runAt: 1_700_000_000_000,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...overrides,
});

describe('unit · renderJobTable', () => {
  test('names its columns in a fixed order, run-at last and labelled with its unit', () => {
    const [header] = renderJobTable([]);
    expect(header?.split(/\s+/)).toEqual(['id', 'name', 'queue', 'state', 'attempt', 'run-at-ms']);
  });

  test('pads every line to the same fixed width', () => {
    const lines = renderJobTable([
      record({ id: 'short', name: 'a' }),
      record({ id: 'a-much-longer-job-id-than-the-others', name: 'billing.reconcile' }),
    ]);
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
  });

  test('renders runAt as the raw epoch, so the column carries no timezone at all', () => {
    const [, row] = renderJobTable([record({ runAt: 1_700_000_000_000 })]);
    expect(row).toContain('1700000000000');
    // The bug this guards: any zone-less date rendering, ISO included, reads as a local time.
    expect(row).not.toContain('2023-11-14T');
    expect(row).not.toContain('T22:13:20');
  });

  test('an empty row list still renders the header, so `0 jobs` is not a blank screen', () => {
    expect(renderJobTable([])).toHaveLength(1);
  });
});
