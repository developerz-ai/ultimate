/**
 * One row per sync of a connection: who started it, which job runs it, and where it got to. The
 * operator's view lists, scopes and cancels THESE (`apps/admin`); the console follows the run's
 * events (`run_events`), which reference this row.
 *
 * `status` is a PROJECTION of the run's last phase event, never a second record: `queued` when
 * `startRun` inserts the row, then whatever `appendEvent` (`apps/web/app/runs/repo.ts`) derives
 * from each event it appends — the one writer of both. `code` is the `X_*` a failed run ended on.
 */

import { entity, enumerated, text, timestamp, uuid } from '@ultimat3/entity';
import { connections } from './connections';
import { orgs } from './orgs';

/** `queued` until a worker writes the first event; `done` and `failed` end a run. */
export const RUN_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** A run that has not ended — what a cancel still applies to, on every surface that offers one. */
export const LIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running'];

/** The queue's job id and an `X_*` code: identifiers, bounded like one. */
export const RUN_IDENT_MAX = 64;

export const runs = entity('runs', {
  columns: {
    /** The JOB's run id — the id `startRun` answered and every event of the run is keyed by. */
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id, { onDelete: 'cascade' })
      .tenant(),
    connectionId: uuid().references(() => connections.id, { onDelete: 'cascade' }),
    /** What the queue cancels by. */
    jobId: text({ max: RUN_IDENT_MAX }),
    status: enumerated(RUN_STATUSES),
    /** Nullable: only a `failed` run ended on a code. */
    code: text({ max: RUN_IDENT_MAX }).nullable(),
    startedAt: timestamp().defaultNow(),
  },
  indexes: [{ on: ['orgId', 'startedAt'] }, { on: ['orgId', 'status'] }],
});

export type Run = typeof runs.$row;
