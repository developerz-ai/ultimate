// The compat row's spec: whether the newest weekly `compat.yml` run — the gate's `unit` and `live`
// on the Bun, Postgres and Solid versions the gate does not pin — ended green, and whether it still
// runs every week at all. Not a gate, so this row is where its red is read; the shared
// scheduled-row reader and judge (`health-scheduled.ts`) read it.

import type { ScheduledRead } from './health-scheduled';
import { scheduledRow } from './health-scheduled';

const ISSUES = 'gh issue list --label compat --state open';
const RESTART = 'gh workflow enable compat.yml && gh workflow run compat.yml';

const COMPAT = scheduledRow({
  row: 'compat',
  workflow: 'compat.yml',
  // A week and a day: GitHub stops a schedule on its own.
  staleMs: 8 * 24 * 60 * 60 * 1000,
  noun: 'compat run',
  green: 'every compat cell passed this week',
  stale: 'no compat run in eight days: the schedule stopped',
  restart: RESTART,
  red: (run) => ({
    reason: `the newest compat run ended ${run.conclusion}: ${ISSUES} names each red cell and its replay`,
    fix: ISSUES,
  }),
});

// Exported for the test that pins it against the argv the reader spawns: a re-run is the same query.
export const COMPAT_COMMAND = COMPAT.command;
export type CompatRead = ScheduledRead;
export const compatReader = COMPAT.reader;
export const judgeCompat = COMPAT.judge;
