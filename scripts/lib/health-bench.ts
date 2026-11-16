// The bench row's spec: whether the newest weekly `bench.yml` run — the published figures re-measured
// on a scaffold of the released `create-ultimate` — ended green, and whether it still fires weekly.
// Never a gate, so nothing else announces its red; the shared scheduled-row reader and judge read it.

import { renderFixShellArg } from '../../packages/core/src/error-render';
import type { ScheduledRead } from './health-scheduled';
import { scheduledRow } from './health-scheduled';

const BENCH = scheduledRow({
  row: 'bench',
  workflow: 'bench.yml',
  // A week plus a day of slack: the cron fires Mondays at 04:41 UTC.
  staleMs: 8 * 24 * 60 * 60 * 1000,
  noun: 'bench run',
  green: 'this week the published figures were re-measured green',
  stale: 'no bench run in eight days: the weekly schedule stopped',
  restart: 'gh workflow enable bench.yml && gh workflow run bench.yml --ref main',
  red: (run) => ({
    reason: `the newest bench run ended ${run.conclusion}: a figure could not be measured (X_BENCH_RUN_FAILED names the step)`,
    fix: `gh run view ${renderFixShellArg(run.id === undefined ? undefined : String(run.id), '<databaseId>')} --log-failed`,
  }),
});

// Exported for the test that pins it against the argv the reader spawns: a re-run is the same query.
export const BENCH_COMMAND = BENCH.command;
export type BenchRead = ScheduledRead;
export const benchReader = BENCH.reader;
export const judgeBench = BENCH.judge;
