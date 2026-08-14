// The `x_backfills` ledger as `x db backfill --list` reports it: the filter flags, the driver
// read and the fixed-width table. A driver plus plain strings in, plain data out — the
// `cmd-jobs.ts` / `jobs-report.ts` split repeated, so every projection here is testable with no
// `ParsedArgs`, no app boot and no queue. `cmd-db.ts` is the CLI wiring and nothing else.

import type { BackfillProgress, BackfillStatus, JobDriver } from '@ultimat3/jobs';
import { inspectBackfills } from '@ultimat3/jobs';
import { BadFlagError } from './errors';
import { parseLimitFlag } from './jobs-report';
import { msg } from './messages';
import { renderTable } from './table';

/** Mirrors `BackfillStatus` from `@ultimat3/jobs`, which exports the type but no runtime list. */
export const BACKFILL_STATUSES: readonly BackfillStatus[] = ['running', 'completed', 'failed'];

const isBackfillStatus = (value: string): value is BackfillStatus =>
  (BACKFILL_STATUSES as readonly string[]).includes(value);

export function parseBackfillStatusFlag(value: string | undefined): BackfillStatus | undefined {
  if (value === undefined) return undefined;
  if (isBackfillStatus(value)) return value;
  throw new BadFlagError({
    flag: 'status',
    command: 'db',
    reason: `unknown status "${value}" (known: ${BACKFILL_STATUSES.join(', ')})`,
    fix: 'x db backfill --list --json',
  });
}

export interface BackfillListFilter {
  readonly name?: string | undefined;
  readonly status?: string | undefined;
  readonly limit?: string | undefined;
}

/**
 * Every pass the ledger holds, newest first, filtered by the flags as typed. The empty list is an
 * ANSWER — a driver with no ledger and an app that has never swept anything are both "nothing has
 * run", and `inspectBackfills` already refuses to throw for either.
 */
export async function listBackfills(
  driver: JobDriver,
  filter: BackfillListFilter = {},
): Promise<readonly BackfillProgress[]> {
  const status = parseBackfillStatusFlag(filter.status);
  const limit = parseLimitFlag(filter.limit, 'db');
  return inspectBackfills(driver, {
    ...(filter.name === undefined ? {} : { name: filter.name }),
    ...(status === undefined ? {} : { status }),
    ...(limit === undefined ? {} : { limit }),
  });
}

const HEADER = ['name', 'status', 'rows', 'cursor', 'started-at', 'duration-ms', 'run-id'] as const;

/**
 * `started-at` is the ledger's own ISO string, printed verbatim and never re-formatted: the repo
 * forbids a date rendered without an explicit IANA `timeZone`, and not formatting at all is the
 * one rendering with no zone to get wrong — the same rule `jobs-table.ts` states for `run-at-ms`.
 * `--json` carries these exact values, so the two renders of one command stay comparable.
 */
export function renderBackfillTable(rows: readonly BackfillProgress[]): readonly string[] {
  const none = msg('cli.db.backfill.none');
  return renderTable(
    HEADER,
    rows.map((row) => [
      row.name,
      row.status,
      String(row.rows),
      row.cursor ?? none,
      row.startedAt,
      row.durationMs === null ? none : String(row.durationMs),
      row.runId,
    ]),
  );
}
