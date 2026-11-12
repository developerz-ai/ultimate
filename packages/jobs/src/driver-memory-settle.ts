// The memory driver's `onSettled` debt (J11): `x_jobs.settle_owed` and its partial index, as a map
// beside the rows. Same reading as `SQL_ACK`/`SQL_NACK` and `SQL_SETTLE_TAKE_LOST`: a debt is
// recorded only by a settle that ENDS the run, cleared only under the claim the row still
// carries, and taken by restarting its clock.

import type { Clock } from '@ultimat3/core';
import { nowMs } from './clock';
import type { JobRecord, JobState } from './driver';
import type { SettleBy, SettleDebt } from './driver-settle';

/** The states a settle ENDS a run in — the only ones that owe a hook. */
export const SETTLED_STATES: ReadonlySet<JobState> = new Set<JobState>(['done', 'dead', 'failed']);

export interface MemorySettleDebt extends SettleDebt {
  /** A settle under `by` just left `jobId` in `state`: record the debt when one is owed. */
  settled(jobId: string, by: SettleBy, state: JobState): void;
  /** `SQL_JOB_REQUEUE`'s `settle_owed = false`: a retried row owes nothing for its old run. */
  forget(jobId: string): void;
}

export function memorySettleDebt(
  jobs: ReadonlyMap<string, JobRecord>,
  clock: Clock,
): MemorySettleDebt {
  /** Row id → when its debt was recorded or last taken. Its claim is the row's own, as `claims`. */
  const owed = new Map<string, number>();
  return {
    settled(jobId, by, state) {
      // Every settle writes the flag, as `SQL_ACK`/`SQL_NACK` do: one that owes nothing clears it.
      if (by.owesSettle === true && SETTLED_STATES.has(state)) owed.set(jobId, nowMs(clock));
      else owed.delete(jobId);
    },
    forget(jobId) {
      owed.delete(jobId);
    },
    clear(jobId, claim) {
      if (!owed.has(jobId) || jobs.get(jobId)?.claim !== claim) return Promise.resolve(false);
      owed.delete(jobId);
      return Promise.resolve(true);
    },
    takeLost(lost, limit) {
      const at = nowMs(clock);
      const graceOf = new Map(lost.map((job) => [job.name, job.graceMs]));
      const due: { readonly record: JobRecord; readonly since: number }[] = [];
      for (const [id, since] of owed) {
        const record = jobs.get(id);
        if (record === undefined) {
          owed.delete(id);
          continue;
        }
        const grace = graceOf.get(record.name);
        // Requeued by an operator since: the row is live again and owes nothing until it ends.
        if (grace === undefined || !SETTLED_STATES.has(record.state)) continue;
        if (since <= at - grace) due.push({ record, since });
      }
      const taken = due.sort((a, b) => a.since - b.since).slice(0, Math.max(0, limit));
      for (const { record } of taken) owed.set(record.id, at);
      return Promise.resolve(taken.map(({ record }) => record));
    },
  };
}
