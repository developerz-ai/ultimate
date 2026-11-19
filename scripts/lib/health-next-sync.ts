// The next-sync row's spec: whether the newest weekly `next-sync.yml` run — `main` merged into
// `next`, pushed and gated — ended green, and whether it still fires weekly. A `next` behind a fix
// ships the major without it, and its red is otherwise one issue nobody is asked to read.

import type { ScheduledRead } from './health-scheduled';
import { scheduledRow } from './health-scheduled';

/** The one issue the workflow files and keeps, found by its exact title (`next-sync.yml`). */
const ISSUE = `gh issue list --state open --search 'next-sync: main is not merged into next in:title'`;

const NEXT_SYNC = scheduledRow({
  row: 'next-sync',
  workflow: 'next-sync.yml',
  // A week and a day: the cron fires Mondays at 04:41 UTC, and GitHub stops a schedule on its own.
  staleMs: 8 * 24 * 60 * 60 * 1000,
  noun: 'next-sync run',
  green: 'this week main merged cleanly into next',
  stale: 'no next-sync run in eight days: the weekly schedule stopped',
  restart: 'gh workflow enable next-sync.yml && gh workflow run next-sync.yml --ref main',
  red: (run) => ({
    reason: `the newest next-sync run ended ${run.conclusion}: main is not merged into next (a conflict, or a workflow file the job token cannot push) — the open issue names the merge to run`,
    fix: ISSUE,
  }),
});

// Exported for the test that pins it against the argv the reader spawns: a re-run is the same query.
export const NEXT_SYNC_COMMAND = NEXT_SYNC.command;
export type NextSyncRead = ScheduledRead;
export const nextSyncReader = NEXT_SYNC.reader;
export const judgeNextSync = NEXT_SYNC.judge;
