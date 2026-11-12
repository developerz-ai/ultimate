// The Postgres driver's `onSettled` debt (J11): `x_jobs.settle_owed`, which `SQL_ACK` and an ending
// `SQL_NACK` set, paid by `SQL_SETTLE_CLEAR` and re-driven off `SQL_SETTLE_TAKE_LOST`.

import type { PgExecutor } from '@ultimat3/core';
import type { JobRow } from './driver-pg-rows';
import { toJobRecord } from './driver-pg-rows';
import { SQL_SETTLE_CLEAR, SQL_SETTLE_TAKE_LOST } from './driver-pg-settle-sql';
import type { SettleDebt } from './driver-settle';

export function postgresSettleDebt(exec: () => PgExecutor): SettleDebt {
  return {
    async clear(jobId, claim) {
      return (await exec().query(SQL_SETTLE_CLEAR, [jobId, claim])).length > 0;
    },
    async takeLost(jobs, limit) {
      // No hooked job, no statement: an app without `onSettled` never pays for the re-drive.
      if (jobs.length === 0 || limit <= 0) return [];
      const owed = jobs.map((job) => ({ name: job.name, graceMs: Math.round(job.graceMs) }));
      const rows = await exec().query<JobRow>(SQL_SETTLE_TAKE_LOST, [JSON.stringify(owed), limit]);
      return rows.map(toJobRecord);
    },
  };
}
