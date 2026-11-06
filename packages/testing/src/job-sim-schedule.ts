// The seeded picker: every driver call a simulated worker makes parks at a yield point, and one
// seeded RNG decides which parked call goes next and which fault, if any, lands on it. One thread,
// so the interleaving is the seed's alone; every pick and every fault is a line of the trace.

import { assert } from '@ultimat3/core';
import { advanceClock, seededRandom } from './determinism';
import type { SimDecision, SimOp } from './job-sim-driver';
import { SEND_AND_ANSWER } from './job-sim-driver';
import type { SimWorld } from './job-sim-world';
import { SIM_VISIBILITY_MS } from './job-sim-world';

export const JOB_FAULT_KINDS = [
  'kill',
  'answer-lost',
  'lease-lapse',
  'duplicate-claim',
  'clock-jump',
] as const;

export type JobFaultKind = (typeof JOB_FAULT_KINDS)[number];

/** Every fault kind: what `simulateJobs` plants unless told fewer. */
export const ALL_FAULTS: readonly JobFaultKind[] = JOB_FAULT_KINDS;

/** Event-loop turns with nothing parked before a run is a body waiting on something unowned. */
const MAX_IDLE_TURNS = 10_000;

/** Calls whose answer can be lost after they landed: the ones that change something. */
const WRITES: ReadonlySet<SimOp['call']> = new Set([
  'claim',
  'ack',
  'nack',
  'heartbeat',
  'enqueue',
  'enqueueMany',
  'put',
]);

interface Parked {
  readonly op: SimOp;
  readonly resolve: (decision: SimDecision) => void;
}

export interface SimSchedulerOptions {
  readonly seed: number;
  readonly faults: readonly JobFaultKind[];
  /** The chance a pick carries a fault, in [0, 1]. */
  readonly faultRate: number;
}

export interface SimScheduler {
  /** The world's `decide`: park until picked, then answer the fault the pick drew. */
  decide(op: SimOp): Promise<SimDecision>;
  /** Release parked calls one at a time until every task has settled. */
  run(world: SimWorld, tasks: readonly Promise<unknown>[]): Promise<void>;
  readonly trace: string[];
  /** The faults planted, in order — what a broken invariant is reported with. */
  readonly planted: string[];
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function simScheduler(options: SimSchedulerOptions): SimScheduler {
  // Its own stream, apart from the world's `Math.random`: a body's draws never shift a pick.
  const rng = seededRandom((options.seed ^ 0x9e3779b9) >>> 0);
  const pickOf = (length: number): number => Math.min(length - 1, Math.floor(rng() * length));
  const parked: Parked[] = [];
  const trace: string[] = [];
  const planted: string[] = [];

  const labelOf = (world: SimWorld, op: SimOp): string =>
    [
      op.worker,
      op.call,
      op.jobId === undefined ? undefined : world.name(op.jobId),
      op.runId === undefined ? undefined : world.name(op.runId),
      op.step,
      op.status,
      op.names?.join(','),
    ]
      .filter((part) => part !== undefined)
      .join(' ');

  const plant = (line: string): void => {
    planted.push(line);
    trace.push(`fault ${line}`);
  };

  /** Draw the pick's fault, landing the clock ones here; answer what the call itself suffers. */
  const fault = async (world: SimWorld, op: SimOp, label: string): Promise<SimDecision> => {
    if (options.faults.length === 0 || rng() >= options.faultRate) return SEND_AND_ANSWER;
    const kind = options.faults[pickOf(options.faults.length)] ?? 'kill';
    if (kind === 'kill') {
      const landed = rng() < 0.5;
      plant(`kill ${label} ${landed ? 'after it landed' : 'before it was sent'}`);
      return landed ? { before: 'send', after: 'kill' } : { before: 'kill', after: 'answer' };
    }
    if (kind === 'answer-lost') {
      if (!WRITES.has(op.call)) return SEND_AND_ANSWER;
      plant(`answer-lost ${label}`);
      return { before: 'send', after: 'lose' };
    }
    if (kind === 'lease-lapse') {
      plant(`lease-lapse at ${label}`);
      advanceClock(SIM_VISIBILITY_MS + 1);
      return SEND_AND_ANSWER;
    }
    if (kind === 'clock-jump') {
      const ms = 1 + Math.floor(rng() * (SIM_VISIBILITY_MS / 2));
      plant(`clock-jump ${ms}ms at ${label}`);
      advanceClock(ms);
      return SEND_AND_ANSWER;
    }
    const running = (await world.rows()).filter((row) => row.state === 'running');
    const victim = running[pickOf(running.length)];
    if (victim === undefined) return SEND_AND_ANSWER;
    plant(`duplicate-claim ${world.name(victim.id)} at ${label}`);
    // The row's lease, cut to now: the next claim by anyone re-delivers a job still running here.
    await world.sim.base.heartbeat(victim.id, { visibilityTimeoutMs: 0 });
    return SEND_AND_ANSWER;
  };

  return {
    trace,
    planted,
    decide: (op) => new Promise<SimDecision>((resolve) => parked.push({ op, resolve })),
    async run(world, tasks) {
      let settled = false;
      const all = Promise.allSettled(tasks).then(() => {
        settled = true;
      });
      for (let idle = 0; ; ) {
        await turn();
        const index = parked.length === 0 ? -1 : pickOf(parked.length);
        const next = index === -1 ? undefined : parked.splice(index, 1)[0];
        if (next === undefined) {
          if (settled) break;
          idle += 1;
          assert(
            idle < MAX_IDLE_TURNS,
            `simulateJobs waited ${MAX_IDLE_TURNS} event-loop turns with no driver call parked: a job body awaits a timer, a socket or a promise the simulation does not own`,
            'x test job --filter <the test file>   # replace the wait with step.sleep, and the I/O with a fixture the simulation installs',
          );
          continue;
        }
        idle = 0;
        const label = labelOf(world, next.op);
        trace.push(`pick ${label}`);
        next.resolve(await fault(world, next.op, label));
      }
      await all;
    },
  };
}
