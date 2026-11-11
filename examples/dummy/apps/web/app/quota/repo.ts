/** Every SQL statement the quota feature runs. No rules, no formatting, no HTTP. */

import { db, type QuotaAlert } from '@postly/db';
import type { OrgId } from '@postly/domain';

/**
 * One crossing, once: the key is `(orgId, meter, day)`, so a replayed `quotaAlert` lands on the row
 * it already wrote. `day` routes the row to its month's partition; a month with none is Postgres'
 * `23514`, which `maintainPartitions` (`./jobs/partitions.ts`) exists to make impossible.
 */
export const recordAlert = async (alert: QuotaAlert): Promise<void> => {
  await db.quotaAlerts.upsertAll([alert], {
    onConflict: ['orgId', 'meter', 'day'],
    onMatch: 'nothing',
  });
};

/** An org's crossings, newest first — the history `quota_alerts` keeps for thirteen months. */
export const alertsOf = (orgId: OrgId, limit: number): Promise<readonly QuotaAlert[]> =>
  db.quotaAlerts.where({ orgId }).orderBy('day', 'desc').limit(limit).all();
