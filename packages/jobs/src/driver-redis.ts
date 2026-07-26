// Redis driver — interface-complete, not implemented. Honest stub: correct types so an app
// can be written against it and `x verify` typechecks, with one labelled throw per method so
// nobody discovers the gap from a silently-dropped job.
//
// Design it will implement when written: a per-queue Redis Stream with a consumer group
// (XADD / XREADGROUP / XACK), `XAUTOCLAIM` for the visibility timeout, a ZSET for delayed
// and suspended runs, and step records in a hash keyed by run id.

import type {
  ClaimedJob,
  ClaimOptions,
  EnqueueRequest,
  EnqueueResult,
  JobDriver,
  NackOptions,
  QueueStats,
} from './driver';
import { JobsNotImplementedError } from './errors';
import type { StepRecord, StepStore } from './steps';

const FIX = 'use driver: "pg" (default) or "memory" — see docs/jobs/drivers.md#redis';

const unavailable = (method: string): never => {
  throw new JobsNotImplementedError({ feature: `redis jobs driver (${method})`, fix: FIX });
};

const redisStepStore = (): StepStore => ({
  get(_runId: string, _name: string): Promise<StepRecord | undefined> {
    return unavailable('steps.get');
  },
  put(_record: StepRecord): Promise<void> {
    return unavailable('steps.put');
  },
  list(_runId: string): Promise<readonly StepRecord[]> {
    return unavailable('steps.list');
  },
  del(_runId: string, _name: string): Promise<void> {
    return unavailable('steps.del');
  },
  clear(_runId: string): Promise<void> {
    return unavailable('steps.clear');
  },
});

export interface RedisDriverOptions {
  readonly url?: string;
  readonly consumerGroup?: string;
}

export function createRedisDriver(_options: RedisDriverOptions = {}): JobDriver {
  return {
    name: 'redis',
    steps: redisStepStore(),
    enqueue(_request: EnqueueRequest): Promise<EnqueueResult> {
      return unavailable('enqueue');
    },
    claim(_options: ClaimOptions): Promise<readonly ClaimedJob[]> {
      return unavailable('claim');
    },
    ack(_jobId: string): Promise<void> {
      return unavailable('ack');
    },
    nack(_jobId: string, _options: NackOptions): Promise<void> {
      return unavailable('nack');
    },
    heartbeat(_jobId: string, _options: { readonly visibilityTimeoutMs: number }): Promise<void> {
      return unavailable('heartbeat');
    },
    stats(): Promise<readonly QueueStats[]> {
      return unavailable('stats');
    },
  };
}
