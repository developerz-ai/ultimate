// The queue contract. Every driver (pg, memory, redis, nats) implements exactly this, so
// switching backends is a config line and ZERO job-code change. Six methods and no more:
// claim/ack/nack with a visibility timeout is the smallest set that survives a worker crash.

import type { StepStore } from './steps';

export type JobState = 'ready' | 'delayed' | 'running' | 'suspended' | 'done' | 'failed' | 'dead';

export interface JobRecord {
  readonly id: string;
  readonly name: string;
  readonly queue: string;
  readonly input: unknown;
  /** Dedupe key from the job definition. At-least-once delivery leans on this. */
  readonly idempotencyKey: string;
  /** Stable across retries and suspensions — the key every step record hangs off. */
  readonly runId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly state: JobState;
  /** Epoch ms; the job is invisible until then. */
  readonly runAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Actor's orgId, for per-tenant limits. */
  readonly tenantId?: string;
  readonly lastError?: string;
  readonly claimedBy?: string;
  readonly visibleAt?: number;
}

export type ConflictPolicy = 'dedupe' | 'error';

export interface EnqueueRequest {
  readonly name: string;
  readonly queue: string;
  readonly input: unknown;
  readonly idempotencyKey: string;
  readonly maxAttempts: number;
  /** Epoch ms. Omit for "now". */
  readonly runAt?: number;
  readonly tenantId?: string;
  /** Reuse an existing run id when resuming, so step history is preserved. */
  readonly runId?: string;
  readonly onConflict?: ConflictPolicy;
}

export interface EnqueueResult {
  readonly id: string;
  readonly runId: string;
  /** True when an in-flight job already held this idempotency key. */
  readonly deduped: boolean;
}

export interface ClaimOptions {
  readonly queues: readonly string[];
  readonly limit: number;
  /** Lease length. A worker that dies without ack makes the job claimable again after this. */
  readonly visibilityTimeoutMs: number;
  readonly workerId: string;
}

export interface ClaimedJob extends JobRecord {
  readonly claimedAt: number;
  readonly visibleAt: number;
}

export interface NackOptions {
  /** Delay before the job becomes claimable again. */
  readonly delayMs: number;
  readonly error?: string;
  /**
   * False for a suspension (`step.sleep`): parking a run is not a failure and must not burn
   * a retry attempt, or a 3-day sleep would dead-letter the job.
   */
  readonly countsAsAttempt?: boolean;
  readonly deadLetter?: boolean;
}

export interface QueueStats {
  readonly queue: string;
  readonly ready: number;
  readonly delayed: number;
  readonly running: number;
  readonly suspended: number;
  readonly dead: number;
  /** Age in ms of the oldest claimable job — the number that decides autoscaling. */
  readonly oldestReadyMs: number;
}

export interface JobFilter {
  readonly queue?: string;
  readonly name?: string;
  readonly state?: JobState;
  readonly limit?: number;
}

/** Optional: powers `/_x` and the MCP tools. A minimal driver may omit it. */
export interface JobIntrospection {
  job(jobId: string): Promise<JobRecord | undefined>;
  list(filter?: JobFilter): Promise<readonly JobRecord[]>;
  deadLetters(limit?: number): Promise<readonly JobRecord[]>;
  /** Re-queue a dead/failed job. `fromStep` drops step records from that step onward. */
  requeue(jobId: string, options?: { readonly fromStep?: string }): Promise<JobRecord>;
}

export interface JobDriver {
  readonly name: string;
  /** Step persistence lives with the queue: one store, one transaction boundary. */
  readonly steps: StepStore;
  enqueue(request: EnqueueRequest): Promise<EnqueueResult>;
  claim(options: ClaimOptions): Promise<readonly ClaimedJob[]>;
  ack(jobId: string): Promise<void>;
  nack(jobId: string, options: NackOptions): Promise<void>;
  /** Extends the lease of a long-running job so it is not double-claimed. */
  heartbeat(jobId: string, options: { readonly visibilityTimeoutMs: number }): Promise<void>;
  stats(): Promise<readonly QueueStats[]>;
  readonly introspect?: JobIntrospection;
  close?(): Promise<void>;
}

export const DEFAULT_QUEUE = 'default';
export const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000;

let ambient: JobDriver | undefined;

/** Set once at boot from `app.config.ts`. Roles share one driver instance per process. */
export function setJobDriver(driver: JobDriver): void {
  ambient = driver;
}

export function jobDriver(): JobDriver | undefined {
  return ambient;
}
