/**
 * What `/runs/health` draws, from the newest runs and nothing else: the share that succeeded, the
 * failures of the newer half against the older, one strip row per connection, and events per run
 * at each run's true start. Pure, so every number is tested without a renderer or a database.
 */

import type { HeatRow, Tone } from '@ultimat3/ui';
import type { RunHealthView } from '../entity';

export type RunHealthRow = Pick<
  RunHealthView,
  'id' | 'connectionId' | 'status' | 'startedAt' | 'eventCount'
>;

type RunStatus = RunHealthRow['status'];

/** A status as a cell's tone: the shape follows the tone (`HeatStrip`), so none is colour alone. */
export const STATUS_TONE: Readonly<Record<RunStatus, Tone>> = {
  done: 'success',
  failed: 'danger',
  running: 'info',
  queued: 'neutral',
};

const oldestFirst = (rows: readonly RunHealthRow[]): RunHealthRow[] =>
  [...rows].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || (a.id < b.id ? -1 : 1));

/** Succeeded of ended, as a percentage; `null` when nothing has ended — unknown, never 0%. */
export function successPercent(rows: readonly RunHealthRow[]): number | null {
  const ended = rows.filter((row) => row.status === 'done' || row.status === 'failed');
  if (ended.length === 0) return null;
  return (ended.filter((row) => row.status === 'done').length / ended.length) * 100;
}

/** Failures in the newer half of the window, and in the older half: the tile's figure and baseline. */
export function failureHalves(rows: readonly RunHealthRow[]): { newer: number; older: number } {
  const sorted = oldestFirst(rows);
  const cut = Math.floor(sorted.length / 2);
  const failed = (part: readonly RunHealthRow[]): number =>
    part.filter((row) => row.status === 'failed').length;
  return { newer: failed(sorted.slice(cut)), older: failed(sorted.slice(0, cut)) };
}

export interface HealthWords {
  readonly connection: (id: string) => string;
  readonly cell: (time: string, status: RunStatus) => string;
  readonly time: (at: Date) => string;
}

/** One row per connection, in the order each first ran; each run a cell named by its reading. */
export function heatRows(rows: readonly RunHealthRow[], words: HealthWords): readonly HeatRow[] {
  const byConnection = new Map<string, RunHealthRow[]>();
  for (const row of oldestFirst(rows)) {
    const runs = byConnection.get(row.connectionId) ?? [];
    runs.push(row);
    byConnection.set(row.connectionId, runs);
  }
  return [...byConnection].map(([connectionId, runs]) => ({
    label: words.connection(connectionId),
    cells: runs.map((run) => ({
      key: run.id,
      label: words.cell(words.time(run.startedAt), run.status),
      tone: STATUS_TONE[run.status],
    })),
  }));
}

export interface EventTrend {
  readonly keys: readonly string[];
  /** Each run's true start, ms: runs are not evenly spaced, and the chart must not say they are. */
  readonly at: readonly number[];
  readonly values: readonly number[];
}

/** Events per run, oldest first, at each run's real start. Two runs in one ms keep their order. */
export function eventTrend(rows: readonly RunHealthRow[], time: (at: Date) => string): EventTrend {
  const sorted = oldestFirst(rows);
  // `at` must be strictly ascending: a tie moves the later run on by a millisecond.
  const at: number[] = [];
  for (const row of sorted) {
    const ms = row.startedAt.getTime();
    at.push(at.length > 0 && ms <= (at.at(-1) as number) ? (at.at(-1) as number) + 1 : ms);
  }
  return {
    keys: sorted.map((row) => time(row.startedAt)),
    at,
    values: sorted.map((row) => row.eventCount),
  };
}
