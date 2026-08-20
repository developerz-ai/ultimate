// NATS driver — interface-complete, not implemented. The intended mapping, so the eventual
// implementation has no design decisions left: a JetStream work-queue stream per job queue,
// a durable pull consumer per worker pool (`fetch` == claim, `ack`/`nak` map 1:1),
// `ack_wait` as the visibility timeout, and a KV bucket for step records.

import type {
  ClaimedJob,
  ClaimOptions,
  EnqueueRequest,
  EnqueueResult,
  HeartbeatOptions,
  JobDriver,
  NackOptions,
  QueueStats,
} from './driver';
import { JobsNotImplementedError } from './errors';
import type { StepRecord, StepStore } from './steps';

// Names the seam that actually replaces the stub, plus the runnable command for whatever is
// already queued. NOT `jobs: { driver }` in app.config.ts, which this line said until 2026-08-20:
// `JobsConfig.driver` has no reader anywhere (see `driver.ts`'s header), so that edit repairs
// nothing and the reader is sent back to the same throw. #223 removes the field.
// The nats driver lands in v2; there is no flag that turns this one on.
const FIX =
  'call setJobDriver(createPgDriver()) at boot instead of this driver, then move what is already queued: x jobs drain --to memory --json';

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
    heartbeat(_jobId: string, _options: HeartbeatOptions): Promise<boolean> {
      return unavailable('heartbeat');
    },
    stats(): Promise<readonly QueueStats[]> {
      return unavailable('stats');
    },
  };
}
