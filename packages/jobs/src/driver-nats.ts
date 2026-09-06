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

// Names the seam that actually replaces the stub, and NOTHING ELSE — the two other repairs this
// line has carried were both unrunnable.
//
// NOT `jobs: { driver }` in app.config.ts, which it said until 2026-08-20: the field had no
// reader anywhere, so that edit repaired nothing and sent the reader back to the same throw. It
// is deleted now.
//
// NOT `x jobs drain --to memory` either, which it said until 2026-09, and that one was a route
// into data loss: the target is a Map inside the command's own process, so the drain acked every
// durable row and lost the copy at exit. `x jobs` refuses that value by name now. There is no
// drain to run in its place, and the reason is in this file — `enqueue` below refuses too, so
// nothing was ever queued onto this driver and the queue is untouched.
//
// The nats driver lands in v2; there is no flag that turns this one on.
const FIX =
  'call setJobDriver(createPgDriver()) at boot instead of this driver; nothing needs moving first, because enqueue here refuses too, so no job was ever written to it';

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
