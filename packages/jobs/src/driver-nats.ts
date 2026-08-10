// NATS driver — interface-complete, not implemented. The intended mapping, so the eventual
// implementation has no design decisions left: a JetStream work-queue stream per job queue,
// a durable pull consumer per worker pool (`fetch` == claim, `ack`/`nak` map 1:1),
// `ack_wait` as the visibility timeout, and a KV bucket for step records.

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

// Names the config edit that actually removes the stub, plus the runnable command for whatever
// is already queued. The nats driver lands in v2; there is no flag that turns this one on.
const FIX =
  "set jobs: { driver: 'postgres' } in app.config.ts, then: x jobs drain --to memory --json";

const unavailable = (method: string): never => {
  throw new JobsNotImplementedError({ feature: `nats jobs driver (${method})`, fix: FIX });
};

const natsStepStore = (): StepStore => ({
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

export interface NatsDriverOptions {
  readonly servers?: readonly string[];
  readonly streamPrefix?: string;
}

export function createNatsDriver(_options: NatsDriverOptions = {}): JobDriver {
  return {
    name: 'nats',
    steps: natsStepStore(),
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
