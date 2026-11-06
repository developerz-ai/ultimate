// `simulateJobs`: the jobs a test names, run by N workers over one queue, every driver call
// interleaved by a seeded picker and faulted by it — kill, lost answer, lapsed lease, duplicate
// claim, clock jump. Each seed runs twice and must trace the same bytes; then the app's own
// invariant judges what happened. Off the automatic pass: only the author knows the invariant.

import type { Ctx } from '@ultimat3/core';
import { assert, finiteCount, finiteOption, renderThrowable } from '@ultimat3/core';
import type { AnyJobHandle } from '@ultimat3/jobs';
import { advanceClock, frozenNow } from './determinism';
import type { SimEffect } from './job-sim-effects';
import { JobSimInvariantError, JobSimNondeterministicError } from './job-sim-errors';
import type { JobFaultKind } from './job-sim-schedule';
import { ALL_FAULTS, simScheduler } from './job-sim-schedule';
import { openSimWorld } from './job-sim-world';

/** `x test job --seed <n>` hands its seed to the test process under this name: one seed, replayed. */
export const JOB_SIM_SEED_ENV = 'ULTIMATE_JOB_SIM_SEED';

export interface SimulatedJob {
  readonly handle: AnyJobHandle;
  readonly input: unknown;
}

/** One row as the simulation left it. */
export interface SimulatedRun {
  readonly job: string;
  /** `job#1`: the order it was queued in, the same on every run of a seed. */
  readonly id: string;
  readonly state: string;
  readonly attempt: number;
  readonly lastError?: string;
}

export interface SimulationState {
  readonly seed: number;
  readonly effects: readonly SimEffect[];
  readonly runs: readonly SimulatedRun[];
  readonly faults: readonly string[];
}

export interface SimulateJobsOptions {
  /** The first seed. Default 1; `ULTIMATE_JOB_SIM_SEED` in the environment runs that one alone. */
  readonly seed?: number;
  readonly seeds?: number;
  readonly jobs: readonly SimulatedJob[];
  readonly workers?: number;
  readonly faults?: readonly JobFaultKind[];
  /** The chance any one driver call carries a fault. Default 0.05. */
  readonly faultRate?: number;
  readonly context?: () => Ctx;
  /** `false` or a throw is a violation; an `expect` inside reads as one. */
  invariant(state: SimulationState): unknown;
}

export interface SimulationReport {
  readonly seeds: readonly number[];
}

const MAX_ROUNDS = 100;
/** Passes one worker takes per round while another is still busy: how a reclaim races a run. */
const PASSES_PER_ROUND = 4;

/** The seed `x test job --seed <n>` asked to replay, or none. */
function replaySeed(): number | undefined {
  const raw = Bun.env[JOB_SIM_SEED_ENV];
  if (raw === undefined || raw === '') return undefined;
  const seed = Number(raw);
  return finiteCount('simulateJobs', JOB_SIM_SEED_ENV, seed);
}

async function runSeed(seed: number, options: SimulateJobsOptions) {
  const scheduler = simScheduler({
    seed,
    faults: options.faults ?? ALL_FAULTS,
    faultRate: options.faultRate ?? 0.05,
  });
  await using world = await openSimWorld({
    seed,
    decide: scheduler.decide,
    ...(options.context === undefined ? {} : { context: options.context }),
  });
  for (const one of options.jobs) await world.enqueue(one.handle, one.input);
  let spawned = 0;
  const spawn = (): string => {
    spawned += 1;
    return `w${spawned}`;
  };
  let alive = Array.from({ length: options.workers ?? 2 }, spawn);
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const busy = new Set<string>();
    let ran = 0;
    const loop = async (worker: string): Promise<void> => {
      busy.add(worker);
      for (let pass = 0; pass < PASSES_PER_ROUND && !world.sim.isDead(worker); pass += 1) {
        const executions = await world.tick(worker);
        ran += executions.length;
        for (const run of executions) {
          scheduler.trace.push(`ran ${worker} ${world.name(run.jobId)} ${run.outcome}`);
        }
        if (executions.length === 0 && [...busy].every((one) => one === worker)) break;
      }
      busy.delete(worker);
    };
    await scheduler.run(world, alive.map(loop));
    // A killed process is replaced, as an orchestrator restarts it: the fleet keeps its size.
    alive = alive.map((worker) => (world.sim.isDead(worker) ? spawn() : worker));
    if (ran > 0) continue;
    const due = await world.nextDue();
    if (due === undefined) break;
    advanceClock(Math.max(1, due - frozenNow().getTime()));
  }
  const runs = (await world.rows()).map(
    (row): SimulatedRun => ({
      job: row.name,
      id: world.name(row.id),
      state: row.state,
      attempt: row.attempt,
      ...(row.lastError === undefined ? {} : { lastError: row.lastError }),
    }),
  );
  const effects = world.effects();
  const trace = [
    ...scheduler.trace,
    ...effects.map((effect) => `effect ${effect.worker ?? '-'} ${effect.key}`),
    ...runs.map((run) => `row ${run.id} ${run.job} ${run.state} ${run.attempt}`),
  ];
  return { trace, state: { seed, effects, runs, faults: [...scheduler.planted] } };
}

function firstDifference(a: readonly string[], b: readonly string[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) if (a[i] !== b[i]) return i;
  return -1;
}

export async function simulateJobs(options: SimulateJobsOptions): Promise<SimulationReport> {
  const seeds = finiteCount('simulateJobs', 'seeds', options.seeds ?? 20, 1);
  finiteCount('simulateJobs', 'workers', options.workers ?? 2, 1);
  const rate = finiteOption('simulateJobs', 'faultRate', options.faultRate ?? 0.05);
  assert(
    rate >= 0 && rate <= 1,
    `simulateJobs faultRate is ${rate}, and a chance is between 0 and 1`,
    'simulateJobs({ …, faultRate: 0.05 })',
  );
  const first = finiteCount('simulateJobs', 'seed', options.seed ?? 1);
  const replay = replaySeed();
  const list = replay === undefined ? Array.from({ length: seeds }, (_, i) => first + i) : [replay];
  for (const seed of list) {
    const once = await runSeed(seed, options);
    const twice = await runSeed(seed, options);
    const at = firstDifference(once.trace, twice.trace);
    if (at !== -1) {
      throw new JobSimNondeterministicError({
        seed,
        at,
        first: once.trace[at] ?? '<end of trace>',
        second: twice.trace[at] ?? '<end of trace>',
      });
    }
    let verdict: unknown;
    try {
      verdict = options.invariant(once.state);
    } catch (error) {
      throw new JobSimInvariantError({
        seed,
        faults: once.state.faults,
        reason: renderThrowable(error),
      });
    }
    if (verdict === false) {
      throw new JobSimInvariantError({
        seed,
        faults: once.state.faults,
        reason: 'the invariant answered false',
      });
    }
  }
  return { seeds: list };
}
