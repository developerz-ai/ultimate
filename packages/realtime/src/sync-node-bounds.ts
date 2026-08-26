// Every numeric option `listenSyncNode` accepts, read and REFUSED in one place — split out of
// `sync-node.ts`, which is at the 500-line ceiling `x verify`'s `filesize` step enforces.
//
// WHY A REFUSAL AND NOT A CLAMP: `@ultimat3/core`'s `finite-option.ts` carries the argument in full. The short version is
// that `??` guards nullish, `NaN` is not nullish, and every comparison against a non-finite bound
// reads false — so `maxConnections: NaN` is a node that accepts without limit and says nothing.

import { finiteOption } from '@ultimat3/core';

const SUBJECT = 'the sync node';

/**
 * How often an expired grant is re-decided. A third of the shortest TTL worth issuing: a grant is
 * re-checked on the pass after it expires, so the window a revoked actor keeps its socket is this
 * interval and not its token's lifetime.
 */
export const DEFAULT_REAUTH_INTERVAL_MS = 30_000;

/**
 * Concurrent sockets one node will hold. The accept budget bounds the accept RATE and nothing
 * bounded the COUNT: at the 500/s that budget permits, an attacker holding each socket open with
 * one keepalive frame a minute reaches 1.8M sockets an hour, each carrying a `GrantBook` entry.
 *
 * The number clears the 50,000 real clients this repo has measured on one node
 * (`scripts/bench/restart-bench.ts`) with room to spare, because a ceiling that refuses a proven
 * workload is an outage the framework caused.
 */
export const DEFAULT_MAX_CONNECTIONS = 250_000;

/**
 * Inbound bytes one frame may carry. Bun's own default is 16 MiB, which one authenticated socket
 * can push continuously; a `subscribe` frame carrying a full 512-id cursor is under 32 KiB.
 */
export const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;

export const DEFAULT_DRAIN_SPREAD_MS = 30_000;
export const DEFAULT_DRAIN_GRACE_MS = 5_000;

/** The subset of `SyncNodeOptions` this module reads. Structural, so the full type satisfies it. */
export interface SyncNodeNumericOptions {
  readonly maxConnections?: number | undefined;
  readonly reauthenticateIntervalMs?: number | undefined;
  readonly maxFrameBytes?: number | undefined;
  readonly drainSpreadMs?: number | undefined;
}

export interface SyncNodeBounds {
  readonly maxConnections: number;
  readonly reauthenticateIntervalMs: number;
  readonly maxFrameBytes: number;
  readonly drainSpreadMs: number;
}

export function syncNodeBounds(options: SyncNodeNumericOptions): SyncNodeBounds {
  return {
    maxConnections: finiteOption(
      SUBJECT,
      'maxConnections',
      options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    ),
    reauthenticateIntervalMs: finiteOption(
      SUBJECT,
      'reauthenticateIntervalMs',
      options.reauthenticateIntervalMs ?? DEFAULT_REAUTH_INTERVAL_MS,
    ),
    maxFrameBytes: finiteOption(
      SUBJECT,
      'maxFrameBytes',
      options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
    ),
    drainSpreadMs: finiteOption(
      SUBJECT,
      'drainSpreadMs',
      options.drainSpreadMs ?? DEFAULT_DRAIN_SPREAD_MS,
    ),
  };
}

/** Per CALL, not per node: `drain({ graceMs })` is an argument, so it is refused where it arrives. */
export const drainGraceMs = (graceMs: number | undefined): number =>
  finiteOption('the sync node drain', 'graceMs', graceMs ?? DEFAULT_DRAIN_GRACE_MS);
