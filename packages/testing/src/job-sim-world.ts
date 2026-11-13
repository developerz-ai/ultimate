// The world one simulated run happens in: one memory queue behind per-worker views, the effect
// log, a fresh event bus, renewals on the frozen clock, the clock and `Math.random` put back to the
// same instant and seed at the start — so one run is a function of its decisions and nothing else.
// Ids are minted by the queue and differ run to run; the effect log names them by ordinal instead.

import type { Ctx } from '@ultimat3/core';
import { ctxOf } from '@ultimat3/core';
import type { EnqueueResult, JobDriver, JobExecution, JobHandle, JobRecord } from '@ultimat3/jobs';
import {
  captureDeterminism,
  installDeterminism,
  restoreCapturedDeterminism,
  seededRandom,
} from './determinism';
import { frozenScheduler } from './frozen-scheduler';
import type { SimDecision, SimDriver, SimOp } from './job-sim-driver';
import { isSimFault, simDriver } from './job-sim-driver';
import type { EffectLog, SimEffect } from './job-sim-effects';
import { openEffectLog } from './job-sim-effects';
import { ordinalNamer } from './job-sim-names';

/** A lease short enough that a lapse is one clock jump, long enough that no renewal misses it. */
export const SIM_VISIBILITY_MS = 30_000;
/** Renewals every millisecond of test time: any move renews every running job once. */
const RENEW_MS = 1;
const CLAIM_LIMIT = 64;
const LIVE: ReadonlySet<string> = new Set(['ready', 'delayed', 'running', 'suspended']);
/** Where an `alone` world files the harness's row: no body enqueues here, so no worker claims theirs. */
const HARNESS_QUEUE = 'x-sim-harness';

export interface SimWorldOptions {
  /** Seeds `Math.random` for the run: a body's jitter and draws are the seed's. */
  readonly seed: number;
  /** What every worker runs its bodies under. Default: an anonymous worker. */
  readonly context?: () => Ctx;
  decide(op: SimOp): SimDecision | Promise<SimDecision>;
  /** Told every landed call, after the world has read it. */
  landed?(op: SimOp, answer: unknown): void;
  /**
   * Only the row the harness filed is ever claimed: what a body enqueues lands, dedupes and is an
   * `enqueue:` effect, and never runs — its effects are its own job's, not this run's.
   */
  readonly alone?: boolean;
}

export interface SimWorld extends AsyncDisposable {
  readonly sim: SimDriver;
  readonly log: EffectLog;
  /** Filed by the harness, not a worker: no yield, no effect. */
  enqueue<I>(handle: JobHandle<I>, input: I): Promise<EnqueueResult>;
  /** One claim pass by `worker`, a real `jobWorker().tick()`. A planted fault ends it quietly. */
  tick(worker: string): Promise<readonly JobExecution[]>;
  rows(): Promise<readonly JobRecord[]>;
  /** The instant the next live row is claimable — a lease lapsing or a `runAt` — if any. */
  nextDue(): Promise<number | undefined>;
  /** `job#1`, `run#1`: the ordinal a queue id is reported under. */
  name(id: string): string;
  /** The effect log, ids replaced by their ordinals. */
  effects(): readonly SimEffect[];
}

export async function openSimWorld(options: SimWorldOptions): Promise<SimWorld> {
  const jobs = await import('@ultimat3/jobs');
  const adapter = await import('@ultimat3/jobs/adapter');
  const clock = captureDeterminism();
  if (!clock.installed) installDeterminism();
  Math.random = seededRandom(options.seed);
  const ordinals = new Map<string, string>();
  const counters = new Map<string, number>();
  const known = (id: string | undefined, kind: 'job' | 'run'): void => {
    if (id === undefined || ordinals.has(id)) return;
    const n = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, n);
    ordinals.set(id, `${kind}#${n}`);
  };
  const remember = (answer: unknown): void => {
    for (const one of Array.isArray(answer) ? answer : [answer]) {
      if (typeof one !== 'object' || one === null) continue;
      const row = one as { readonly id?: unknown; readonly runId?: unknown };
      if (typeof row.id === 'string') known(row.id, 'job');
      if (typeof row.runId === 'string') known(row.runId, 'run');
    }
  };

  let log: EffectLog | undefined;
  const base = jobs.memoryJobDriver();
  const sim = simDriver(base, {
    decide: (op) => options.decide(op),
    landed: (op, answer) => {
      remember(answer);
      // Completed only: a `failed` or `started` record is not a step the body has moved past.
      if (op.call === 'put' && op.step !== undefined && op.status === 'completed') {
        log?.stepWritten(op.worker, op.step);
      }
      if ((op.call === 'enqueue' || op.call === 'enqueueMany') && log !== undefined) {
        const results = (Array.isArray(answer) ? answer : [answer]) as readonly EnqueueResult[];
        results.forEach((result, i) => {
          if (!result.deduped) log?.record(`enqueue:${op.names?.[i] ?? '?'}`);
        });
      }
      options.landed?.(op, answer);
    },
  });
  log = await openEffectLog({ isDead: sim.isDead });
  const effectLog = log;

  // A body's own enqueue goes through the view of the worker running it: a dead one's is refused.
  const ambient = (): JobDriver => sim.viewFor(effectLog.scope.get() ?? 'harness');
  const ambientDriver: JobDriver = new Proxy(base, {
    get: (_target, key) => Reflect.get(ambient(), key),
  });
  const releaseDriver = adapter.installJobDriver(ambientDriver);
  const releaseBus = adapter.installEventBus(jobs.memoryEventBus());
  const renewals = frozenScheduler();
  const anonymous = ctxOf({ role: 'worker' });
  const context = options.context ?? (() => anonymous);

  const queues = (): readonly string[] =>
    options.alone === true
      ? [HARNESS_QUEUE]
      : [...new Set([jobs.DEFAULT_QUEUE, ...jobs.registeredJobs().map((handle) => handle.queue)])];
  const claimable = new Set(queues());

  const rows = async (): Promise<readonly JobRecord[]> => {
    const all: JobRecord[] = [];
    for (let after: string | undefined; ; ) {
      const page =
        (await base.introspect?.list({
          limit: jobs.MAX_JOB_PAGE,
          ...(after === undefined ? {} : { after }),
        })) ?? [];
      all.push(...page);
      const last = page[page.length - 1];
      if (last === undefined || page.length < jobs.MAX_JOB_PAGE) return all;
      after = jobs.jobCursor(last);
    }
  };

  return {
    sim,
    log: effectLog,
    enqueue: async (handle, input) => {
      const result = await base.enqueue({
        name: handle.name,
        queue: options.alone === true ? HARNESS_QUEUE : handle.queue,
        input,
        idempotencyKey: handle.idempotencyKeyFor(input),
        maxAttempts: jobs.enqueuedAttempts(handle.retry, handle.compensates),
      });
      remember(result);
      return result;
    },
    tick: (worker) =>
      effectLog.scope.run(worker, async () => {
        const one = jobs.jobWorker({
          driver: sim.viewFor(worker),
          workerId: worker,
          queues: queues(),
          concurrency: CLAIM_LIMIT,
          visibilityTimeoutMs: SIM_VISIBILITY_MS,
          heartbeatIntervalMs: RENEW_MS,
          schedule: renewals.schedule,
          pollIntervalMs: 0,
          drainOnShutdown: false,
          context,
        });
        try {
          return await one.tick();
        } catch (error) {
          // A claim refused by a planted fault is the pass's end; anything else is a real failure.
          if (isSimFault(error)) return [];
          throw error;
        }
      }),
    rows,
    nextDue: async () => {
      const due = (await rows())
        .filter(
          (row) => LIVE.has(row.state) && (options.alone !== true || claimable.has(row.queue)),
        )
        .map((row) => (row.state === 'running' ? (row.visibleAt ?? row.runAt) : row.runAt));
      return due.length === 0 ? undefined : Math.min(...due);
    },
    name: (id) => ordinals.get(id) ?? id,
    effects: () => {
      // One namer per read: the ids are read once, never once per effect (`job-sim-names.ts`).
      const name = ordinalNamer(ordinals);
      return effectLog.effects().map((effect) => ({ ...effect, key: name(effect.key) }));
    },
    [Symbol.asyncDispose]: async (): Promise<void> => {
      try {
        await effectLog[Symbol.asyncDispose]();
      } finally {
        renewals[Symbol.dispose]();
        releaseBus();
        releaseDriver();
        await base.close();
        restoreCapturedDeterminism(clock);
      }
    },
  };
}
