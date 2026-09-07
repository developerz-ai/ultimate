// The `worker` role's public contract: what `createWorker` takes, what it hands back, and what
// `stats()` reports. Apart from `worker.ts` because that file's job is the claim loop and the
// drain, and a contract three files import should not sit under 500 lines of loop.

import type { Clock, Ctx } from '@ultimat3/core';
import type { JobDriver, QueueStats } from './driver';
import type { JobExecution } from './execute';
import type { Limiter } from './limits';
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
  readonly pollIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly workerId?: string;
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
  readonly queueDepth: readonly QueueStats[];
}

export interface Worker {
  start(): void;
  /** One claim+run round. Returns jobs processed. Tests drive this instead of the timer. */
  tick(): Promise<readonly JobExecution[]>;
  /**
   * Stop claiming, wait for every job this worker holds, close the driver. Unbounded, and it
   * aborts nothing: a caller that asked wants its work finished. SIGTERM takes the other path —
   * the shutdown hooks `start()` registers abort every held run's `ctx.signal` and wait under
   * the lifecycle's deadline.
   */
  stop(reason?: string): Promise<void>;
  stats(): Promise<WorkerStats>;
}
