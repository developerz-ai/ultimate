// Single responsibility: what a replicator's publish can meet — a bus that is away (waited out on
// `PUBLISH_RETRY_DELAYS_MS`) and a run that ended under it (refused, never published). Split out of
// `replicator.ts`, whose importers keep `PUBLISH_RETRY_DELAYS_MS` at its old path.

import { isUltimateError } from '@ultimat3/core';
import { ReplicationFailedError } from './errors';

/**
 * How long a publish refused because the bus is AWAY is waited out, in the handler, before the run
 * ends: three more attempts over two seconds. A NATS restart is a second or two, and ending the
 * run for it costs a stream stop, an unlock, a backoff and a re-read from `lastLsn` — with
 * `/readyz` false throughout. Longer than this is an outage, and the takeover loop's to handle.
 */
export const PUBLISH_RETRY_DELAYS_MS: readonly number[] = [100, 400, 1_500];

/** The bus is unreachable — as opposed to a change it will never take (a payload over the limit). */
export const busAway = (thrown: unknown): boolean =>
  isUltimateError(thrown) && thrown.code === 'X_TRANSPORT_UNAVAILABLE';

export const fencedOut = (reason: string): ReplicationFailedError =>
  new ReplicationFailedError({
    stage: 'stream',
    detail: `a change arrived for a run that is over (${reason}), and was not published`,
    fix: 'x doctor --json',
  });
