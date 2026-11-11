/**
 * Every time an org crossed its warning line on a meter — `createPost`'s 80% of the day's drafts —
 * one row, written by `quotaAlert` (`apps/web/app/quota/jobs/quota-alert.ts`). An org's history of
 * running into its plan: what an upgrade conversation and a support ticket both start from.
 *
 * Append-only and time-ordered, so it is PARTITIONED by month (`partitionBy`): a year is twelve
 * small tables, the oldest DROPPED by `maintainPartitions` (`apps/web/app/quota/jobs/partitions.ts`)
 * rather than deleted row by row as `retain` on `run_events` does.
 */

import { date, entity, integer, invariant, text, timestamp, uuid } from '@ultimat3/entity';
import { orgs } from './orgs';

export const QUOTA_METER_MAX = 60;

export const quotaAlerts = entity('quota_alerts', {
  columns: {
    orgId: uuid()
      .references(() => orgs.id, { onDelete: 'cascade' })
      .tenant(),
    /** The meter's own name (`posts`), as `MeterWarning.meter` carries it. */
    meter: text({ max: QUOTA_METER_MAX }),
    used: integer(),
    limit: integer(),
    /**
     * The metered UTC day the line was crossed in, and the partition key. A `date()`, not the
     * period's first instant: the meter's period IS a UTC day, and a calendar date is what a
     * month's partition bounds and an operator's "which day" both read.
     */
    day: date(),
    resetsAt: timestamp(),
  },
  // One warning per org, meter and period — the meter claims it once, and this makes a replayed
  // job the same row. Postgres' rule for a partitioned table: the key holds the partition column.
  primaryKey: ['orgId', 'meter', 'day'],
  invariants: (c) => [invariant('quota_alert_used_non_negative', c.used.atLeast(0))],
  // Thirteen months: this one and the twelve before it, a year-over-year view of any month.
  partitionBy: { column: 'day', interval: 'month', ahead: 3, retain: { after: '400d' } },
});

export type QuotaAlert = typeof quotaAlerts.$row;
