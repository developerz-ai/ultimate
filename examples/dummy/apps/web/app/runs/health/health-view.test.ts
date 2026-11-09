// The run-health numbers against a fixed set of runs: success is a share of ENDED runs and unknown
// with none; the strip groups by connection, oldest first; the trend sits each run at its real
// start, and a tie still ascends.
import { expect, unitTest } from '@ultimat3/testing';
import type { RunHealthRow } from './health-view';
import { eventTrend, failureHalves, heatRows, successPercent } from './health-view';

const at = (minute: number): Date => new Date(Date.UTC(2026, 10, 6, 9, minute));
const run = (id: string, connectionId: string, status: RunHealthRow['status'], minute: number) => ({
  id,
  connectionId,
  status,
  startedAt: at(minute),
  eventCount: minute,
});

const RUNS: readonly RunHealthRow[] = [
  run('r4', 'b', 'running', 40),
  run('r3', 'a', 'failed', 30),
  run('r2', 'b', 'done', 2),
  run('r1', 'a', 'done', 1),
];

const words = {
  connection: (id: string) => `site ${id}`,
  cell: (time: string, status: string) => `${time}: ${status}`,
  time: (date: Date) => date.toISOString().slice(11, 16),
};

unitTest('success is a share of ended runs, and unknown when none has ended', () => {
  expect(successPercent(RUNS)).toBeCloseTo((2 / 3) * 100);
  expect(successPercent([run('q', 'a', 'queued', 1)])).toBeNull();
});

unitTest('failures: the newer half against the older', () => {
  expect(failureHalves(RUNS)).toEqual({ newer: 1, older: 0 });
});

unitTest('one strip row per connection, oldest first, each cell its whole reading', () => {
  const rows = heatRows(RUNS, words);
  expect(rows.map((row) => row.label)).toEqual(['site a', 'site b']);
  expect(rows[0]?.cells.map((cell) => [cell.key, cell.tone, cell.label])).toEqual([
    ['r1', 'success', '09:01: done'],
    ['r3', 'danger', '09:30: failed'],
  ]);
});

unitTest('the trend sits each run at its true start, strictly ascending even on a tie', () => {
  const trend = eventTrend(RUNS, words.time);
  expect(trend.keys).toEqual(['09:01', '09:02', '09:30', '09:40']);
  expect(trend.at[2]).toBe(at(30).getTime());
  const tied = eventTrend([run('x', 'a', 'done', 5), run('y', 'a', 'done', 5)], words.time);
  expect(tied.at[1]).toBe((tied.at[0] ?? 0) + 1);
});
