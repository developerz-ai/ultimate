// The `worker` role's public contract: what `createWorker` takes, what it hands back, and what
// `stats()` reports. Apart from `worker.ts` because that file's job is the claim loop and the
// drain, and a contract three files import should not sit under 500 lines of loop.

import type { Clock, Ctx } from '@ultimat3/core';
import type { JobDriver, QueueStats } from './driver';
import type { JobExecution } from './execute';
import type { Limiter } from './limits';
import type { IntervalScheduler } from './renewal-timer';
import type { EventLookup } from './steps';

export interface WorkerOptions {
  readonly driver: JobDriver;
  /** Queues this process serves. Default `['default']`. */
  readonly queues?: readonly string[];
  /** Slots per queue. A number applies to every queue. */
  readonly concurrency?: number | Readonly<Record<string, number>>;
  readonly limiter?: Limiter;
  readonly clock?: Clock;
  readonly events?: EventLookup;
  /** Supplies the ambient Ctx for a job run; the app wires ALS + tenant here. */
  readonly context: () => Ctx;
  readonly visibilityTimeoutMs?: number;
  /** The gap between claim passes while there is work. Default 250 ms. */
  readonly pollIntervalMs?: number;
  /**
   * The longest gap once passes come back empty: the worker doubles its wait from
   * `pollIntervalMs` up to this. Default `IDLE_POLL_CEILING_MS` (2 s). It is the most a job
   * enqueued by ANOTHER process — or a delayed one coming due — waits for an idle worker; a job
   * enqueued by this process wakes the worker at once.
   */
  readonly idlePollMaxMs?: number;
  readonly heartbeatIntervalMs?: number;
  /**
   * What the lease, fleet-slot and registry renewals run on. Default: a real, unrefed interval.
   * The `runJobs` fixture hands one driven by the frozen clock, so a test renews when
   * `clock.advance()` says time passed, never on the wall clock.
   */
  readonly schedule?: IntervalScheduler;
  readonly workerId?: string;
  /** Where this worker runs, for the registry. Default `HOSTNAME`, which a pod sets to its name. */
  readonly host?: string;
  /** Default true. Registers a SIGTERM drain via `onShutdown`. */
  readonly drainOnShutdown?: boolean;
}

export interface WorkerStats {
  readonly workerId: string;
  readonly queues: readonly string[];
  readonly state: 'idle' | 'running' | 'draining' | 'stopped';
  readonly inFlight: number;
  readonly processed: number;
  readonly failed: number;
  readonly suspended: number;
  readonly deadLettered: number;
  /** Attempts this worker's drain cut short and handed back uncounted — see `JobDrainedError`. */
  readonly interrupted: number;
  /** Runs settled `failed` with `X_JOB_KEY_BUSY`, their bodies never started — `whenBusy: 'fail'`. */
  readonly refused: number;
  /** Runs that failed for good on a `retry.deadLetter: false` job and were settled `failed`. */
  readonly dropped: number;
  /** The gap before the next claim pass: `pollIntervalMs`, or wherever idling has taken it. */
  readonly pollDelayMs: number;
  readonly queueDepth: readonly QueueStats[];
}

export interface Worker {
  start(): void;
  /** One claim+run round. Returns jobs processed. Tests drive this instead of the timer. */
  tick(): Promise<readonly JobExecution[]>;
  /**
   * Stop claiming, wait for every job this worker holds, close the driver. Unbounded, and it
   * aborts nothing: a caller that asked wants its work finished. SIGTERM takes the other path —
   * it stops claiming and lets held runs finish under the lifecycle's deadline; only at the cut-off
   * (`deadlineAt − margin`) is a still-running `ctx.signal` aborted, and its claim handed back.
   */
  stop(reason?: string): Promise<void>;
  stats(): Promise<WorkerStats>;
}
