// The worker role's cross-process wake, and the one series that says whether it is PROVEN. The
// mechanism is `@ultimat3/jobs`' (`startQueueWake`); this decides who holds the LISTEN session —
// the worker, and only over a client that can listen — and publishes `queue_wake_live`, because a
// transaction-pooling proxy disables the wake in silence and the poll hides that it did.

import { gauge } from '@ultimat3/core';
import type { DbClient } from '@ultimat3/db';
import { canListen } from '@ultimat3/db';
import type { QueueWake } from '@ultimat3/jobs';
import { startQueueWake } from '@ultimat3/jobs';
import { pgExecutorFor } from './runtime-queue';

// The wake the gauge reads. One observer for the life of the process: a gauge redeclared with a
// different `observe` is refused, and `x dev` starts the roles again on every restart-in-place.
let current: QueueWake | undefined;
let declared = false;

const wakeLive = (): number => (current?.live() === true ? 1 : 0);

/**
 * Starts the wake for a worker, or answers `null` when the client cannot hold a session (a
 * hand-built runtime): the claim loop and the relay then keep the poll they always had.
 */
export function startWorkerWake(db: DbClient): QueueWake | null {
  if (!canListen(db)) return null;
  if (!declared) {
    declared = true;
    gauge('queue_wake_live', {
      unit: '1',
      description:
        '1 while a notification has crossed the worker LISTEN session, 0 while jobs start on the poll alone',
      observe: wakeLive,
    });
  }
  const wake = startQueueWake({ listener: db, executor: pgExecutorFor(db) });
  current = wake;
  return {
    live: () => wake.live(),
    async stop(): Promise<void> {
      // Only the wake still published: a stop of one that was already replaced silences nothing.
      if (current === wake) current = undefined;
      await wake.stop();
    },
  };
}
