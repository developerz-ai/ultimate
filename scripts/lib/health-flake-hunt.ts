// The `flake-hunt` row's spec: whether the newest weekly `flake-hunt.yml` run — `unit` and `live`
// four times each in a shuffled order — ended green, and whether it is still running every week
// at all. Not a gate, so nothing else announces its red; the shared scheduled-row reader and judge
// read it.

import type { ScheduledRead } from './health-scheduled';
import { scheduledRow } from './health-scheduled';

const ISSUES = 'gh issue list --label flake-hunt --state open';
const RESTART = 'gh workflow enable flake-hunt.yml && gh workflow run flake-hunt.yml';

const FLAKE_HUNT = scheduledRow({
  row: 'flake-hunt',
  workflow: 'flake-hunt.yml',
  // Eight days, a week plus the slack a late runner needs: GitHub stops a schedule on its own.
  staleMs: 8 * 24 * 60 * 60 * 1000,
  noun: 'flake hunt',
  green: 'the newest weekly hunt passed every shuffled round',
  stale: 'no flake hunt in eight days: the schedule stopped',
  restart: RESTART,
  red: (run) => ({
    reason: `the newest flake hunt ended ${run.conclusion}: ${ISSUES} names each test, its seed and its rerun`,
    fix: ISSUES,
  }),
});

// Exported for the test that pins it against the argv the reader spawns: a re-run is the same query.
export const FLAKE_HUNT_COMMAND = FLAKE_HUNT.command;
export type FlakeHuntRead = ScheduledRead;
export const flakeHuntReader = FLAKE_HUNT.reader;
export const judgeFlakeHunt = FLAKE_HUNT.judge;
