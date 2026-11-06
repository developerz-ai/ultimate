// One real `memoryJobDriver`, seen by each simulated worker through its own wrapper: every queue
// and step-store call waits at a yield point first, and a fault decided there lands. After a kill
// every call from that worker rejects and lands nothing; an answer lost has landed and still
// rejects. The rejection is the one a real driver raises for a dead connection (`X_DB_UNAVAILABLE`).

import { dbUnavailable } from '@ultimat3/db';
import type {
  ClaimedJob,
  EnqueueRequest,
  EnqueueResult,
  JobDriver,
  MemoryJobDriver,
  StepRecord,
  StepStore,
} from '@ultimat3/jobs';

/** Every call a worker makes through its view. `put` is the step store's write. */
export type SimCall =
  | 'claim'
  | 'ack'
  | 'nack'
  | 'heartbeat'
  | 'enqueue'
  | 'enqueueMany'
  | 'put'
  | 'get'
  | 'list'
  | 'del'
  | 'clear';

export interface SimOp {
  readonly worker: string;
  readonly call: SimCall;
  /** The row the call names: absent on `claim` and on an enqueue. */
  readonly jobId?: string;
  readonly runId?: string;
  /** A step-store call's step, and on a `put` the status it writes. */
  readonly step?: string;
  readonly status?: StepRecord['status'];
  /** An enqueue's job names, one per request. */
  readonly names?: readonly string[];
}

/** What happens to one call: `before` decides if it is sent, `after` what its caller hears. */
export interface SimDecision {
  readonly before: 'send' | 'kill';
  readonly after: 'answer' | 'kill' | 'lose';
}

export const SEND_AND_ANSWER: SimDecision = { before: 'send', after: 'answer' };

export interface SimHooks {
  /** Awaited before every call: the scheduler's yield point and the fault schedule's. */
  decide(op: SimOp): SimDecision | Promise<SimDecision>;
  /** A landed call, before its caller hears — what the effect log and the trace read. */
  landed?(op: SimOp, answer: unknown): void;
}

export interface SimDriver {
  readonly base: MemoryJobDriver;
  /** The driver one worker holds. Same object for the same id. */
  viewFor(worker: string): JobDriver;
  kill(worker: string): void;
  isDead(worker: string): boolean;
}

/** Every rejection this file made, so a caller can tell a planted fault from a real failure. */
const planted = new WeakSet<object>();

const fault = (detail: string) => {
  const error = dbUnavailable(detail);
  planted.add(error);
  return error;
};

/** The value was raised by a simulated fault, never by the code under test. */
export const isSimFault = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && planted.has(value);

const dead = (worker: string) =>
  fault(`the simulated worker "${worker}" died: its connection to the queue is gone`);

const lost = (op: SimOp) =>
  fault(`the answer to ${op.call} from simulated worker "${op.worker}" was lost after it landed`);

export function simDriver(base: MemoryJobDriver, hooks: SimHooks): SimDriver {
  const killed = new Set<string>();
  const views = new Map<string, JobDriver>();

  /** One call, through the yield point, the death check and the decided fault. */
  const call = async <T>(op: SimOp, send: () => Promise<T>): Promise<T> => {
    if (killed.has(op.worker)) throw dead(op.worker);
    const decision = await hooks.decide(op);
    // Killed while parked at the yield: a dead process sends nothing it had not yet sent.
    if (killed.has(op.worker) || decision.before === 'kill') {
      killed.add(op.worker);
      throw dead(op.worker);
    }
    const answer = await send();
    hooks.landed?.(op, answer);
    if (decision.after === 'kill') {
      killed.add(op.worker);
      throw dead(op.worker);
    }
    if (decision.after === 'lose') throw lost(op);
    return answer;
  };

  const stepsFor = (worker: string): StepStore => ({
    get: (runId, name) =>
      call({ worker, call: 'get', runId, step: name }, () => base.steps.get(runId, name)),
    put: (record, by) =>
      call(
        {
          worker,
          call: 'put',
          runId: record.runId,
          step: record.name,
          status: record.status,
          ...(by === undefined ? {} : { jobId: by.jobId }),
        },
        () => base.steps.put(record, by),
      ),
    list: (runId) => call({ worker, call: 'list', runId }, () => base.steps.list(runId)),
    del: (runId, name) =>
      call({ worker, call: 'del', runId, step: name }, () => base.steps.del(runId, name)),
    clear: (runId) => call({ worker, call: 'clear', runId }, () => base.steps.clear(runId)),
  });

  const viewOf = (worker: string): JobDriver => ({
    ...base,
    name: `sim:${worker}`,
    steps: stepsFor(worker),
    enqueue: (request: EnqueueRequest): Promise<EnqueueResult> =>
      call({ worker, call: 'enqueue', names: [request.name] }, () => base.enqueue(request)),
    enqueueMany: (requests) =>
      call({ worker, call: 'enqueueMany', names: requests.map((one) => one.name) }, () =>
        base.enqueueMany(requests),
      ),
    claim: (options): Promise<readonly ClaimedJob[]> =>
      call({ worker, call: 'claim' }, () => base.claim({ ...options, workerId: worker })),
    ack: (jobId, by) => call({ worker, call: 'ack', jobId }, () => base.ack(jobId, by)),
    nack: (jobId, options) =>
      call({ worker, call: 'nack', jobId }, () => base.nack(jobId, options)),
    heartbeat: (jobId, options) =>
      call({ worker, call: 'heartbeat', jobId }, () => base.heartbeat(jobId, options)),
    // Every worker's teardown would close the ONE shared driver; the world closes it once.
    close: () => Promise.resolve(),
  });

  return {
    base,
    viewFor(worker) {
      let view = views.get(worker);
      if (view === undefined) {
        view = viewOf(worker);
        views.set(worker, view);
      }
      return view;
    },
    kill: (worker) => killed.add(worker),
    isDead: (worker) => killed.has(worker),
  };
}
