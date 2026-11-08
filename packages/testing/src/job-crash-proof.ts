// `crashProof(handle, input)`: one clean run, then one run killed at each boundary the clean run
// crossed — every step write landing, every settle — and one more where that write's answer is
// lost. Judged by the effect log: a killed run that makes an effect more often than the clean one
// is `X_JOB_CRASH_DIVERGED`; a lost answer rerunning a step is at-least-once, reported, never red.

import type { Ctx } from '@ultimat3/core';
import { finiteCount } from '@ultimat3/core';
import type { JobHandle } from '@ultimat3/jobs';
import { COMPENSATE_PREFIX, UNWINDING_STEP } from '@ultimat3/jobs';
import { advanceClock, frozenNow } from './determinism';
import type { SimDecision, SimOp } from './job-sim-driver';
import { SEND_AND_ANSWER } from './job-sim-driver';
import type { SimEffect } from './job-sim-effects';
import { effectCounts } from './job-sim-effects';
import { JobCrashDivergedError } from './job-sim-errors';
import type { SimWorld } from './job-sim-world';
import { openSimWorld } from './job-sim-world';

export interface CrashBoundary {
  /** `charge`, `charge (started)`, `sleep:1h (sleeping)`, `unwinding`, `compensate:charge`, `ack`. */
  readonly at: string;
  /** `forced-fail`: the run of a `compensates: true` job made to fail for good, then unwound. */
  readonly mode: 'clean' | 'forced-fail';
  /** The row's state once the killed run settled: `done`, `dead`, … */
  readonly state: string;
  /** The `X_*` code the row ended on, when it ended on one — `X_STEP_OUTCOME_UNKNOWN` after a kill inside `once`. */
  readonly code?: string;
}

export interface CrashDivergence {
  readonly boundary: string;
  readonly mode: CrashBoundary['mode'];
  readonly effect: string;
  readonly clean: number;
  readonly killed: number;
  /** The step whose body made the effect, when every occurrence was made inside that one step. */
  readonly inside?: string;
  readonly error: JobCrashDivergedError;
}

/** A lost answer that made something run again: expected, since no framework can prevent it. */
export interface CrashRerun {
  readonly boundary: string;
  readonly effect: string;
  readonly clean: number;
  readonly rerun: number;
}

export interface CrashReport {
  readonly boundaries: readonly CrashBoundary[];
  readonly divergences: readonly CrashDivergence[];
  readonly reruns: readonly CrashRerun[];
}

export interface CrashProofOptions {
  /** What the workers run bodies under. Default: an anonymous worker. */
  readonly context?: () => Ctx;
  /** Seeds `Math.random` for every run. Default 1. */
  readonly seed?: number;
}

/** A drain that has not settled in this many passes is a job that never settles (a long wait). */
const MAX_ROUNDS = 100;

/** What one run is told to do at the n-th boundary event of the job under proof. */
interface Plan {
  readonly at?: number;
  readonly fault?: 'kill' | 'lose';
  /** Every forward ack dies: the run fails for good on its final attempt and unwinds. */
  readonly forceFail: boolean;
}

interface Ran {
  readonly boundaries: readonly string[];
  readonly effects: readonly SimEffect[];
  readonly compensated: readonly string[];
  /** Forward steps that completed: what a compensator may undo. */
  readonly forward: ReadonlySet<string>;
  /** The row's state once the run settled. */
  readonly settled: string;
  readonly code?: string;
}

const labelOf = (op: SimOp): string =>
  op.call !== 'put'
    ? op.call
    : op.status === 'completed'
      ? (op.step ?? 'put')
      : `${op.step ?? 'put'} (${op.status ?? '?'})`;

async function drive(world: SimWorld): Promise<void> {
  let n = 1;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const worker = `w${n}`;
    const ran = await world.tick(worker);
    // A dead process is replaced; the lease it held lapses below, and the next worker claims it.
    if (world.sim.isDead(worker)) n += 1;
    if (ran.length > 0) continue;
    const due = await world.nextDue();
    if (due === undefined) return;
    advanceClock(Math.max(1, due - frozenNow().getTime()));
  }
}

async function runOnce<I>(
  handle: JobHandle<I>,
  input: I,
  plan: Plan,
  options: CrashProofOptions,
): Promise<Ran> {
  const ids = { job: '', run: '' };
  const boundaries: string[] = [];
  const compensated: string[] = [];
  const forward = new Set<string>();
  const isOwn = (op: SimOp): boolean =>
    op.call === 'put'
      ? op.runId === ids.run
      : (op.call === 'ack' || op.call === 'nack') && op.jobId === ids.job;
  const decide = (op: SimOp): SimDecision => {
    if (!isOwn(op)) return SEND_AND_ANSWER;
    if (plan.forceFail && op.call === 'ack') return { before: 'kill', after: 'answer' };
    boundaries.push(labelOf(op));
    if (boundaries.length !== plan.at || plan.fault === undefined) return SEND_AND_ANSWER;
    // A step write lands and then the worker dies; a settle dies before it is sent.
    if (plan.fault === 'lose') return { before: 'send', after: 'lose' };
    return op.call === 'put'
      ? { before: 'send', after: 'kill' }
      : { before: 'kill', after: 'answer' };
  };
  const landed = (op: SimOp): void => {
    if (!isOwn(op) || op.call !== 'put' || op.status !== 'completed' || op.step === undefined) {
      return;
    }
    if (op.step.startsWith(COMPENSATE_PREFIX)) compensated.push(op.step);
    else if (op.step !== UNWINDING_STEP) forward.add(op.step);
  };
  // Alone: a child the job queues is its enqueue effect, never run — the clean run that ran it
  // first wrote its rows, and every killed run after found them there (0× against 6×).
  await using world = await openSimWorld({
    alone: true,
    seed: finiteCount('crashProof', 'seed', options.seed ?? 1),
    decide,
    landed,
    ...(options.context === undefined ? {} : { context: options.context }),
  });
  const queued = await world.enqueue(handle, input);
  ids.job = queued.id;
  ids.run = queued.runId;
  await drive(world);
  const row = (await world.rows()).find((one) => one.id === queued.id);
  const code = /\b(X_[A-Z0-9_]+)\b/.exec(row?.lastError ?? '')?.[1];
  return {
    boundaries,
    effects: world.effects(),
    compensated,
    forward,
    settled: row?.state ?? 'gone',
    ...(code === undefined ? {} : { code }),
  };
}

/**
 * The one step whose body made every occurrence of `key` in both runs, or `undefined` when any
 * occurrence was made between steps (or in two different steps).
 */
function insideOf(key: string, runs: readonly Ran[]): string | undefined {
  const steps = new Set(
    runs.flatMap((run) => run.effects.filter((one) => one.key === key).map((one) => one.inside)),
  );
  const [only] = steps;
  return steps.size === 1 ? only : undefined;
}

/**
 * Effects the killed run made more often than the reference — or less often, when both ended alike,
 * neither unwound and the effect is made between steps. Inside a step body that did not complete,
 * fewer is a kill that spent one of the step's attempts (the queue's lease accounting), not a call
 * the crash skipped. An unwound run is also held to the reference's compensators: each once, last
 * in first out, for exactly the forward steps that completed in it.
 */
function compare(reference: Ran, killed: Ran): readonly [string, number, number][] {
  const before = effectCounts(reference.effects);
  const after = effectCounts(killed.effects);
  const unwound = reference.compensated.length > 0 || killed.compensated.length > 0;
  const alike = killed.settled === reference.settled && !unwound;
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  const out: [string, number, number][] = [];
  for (const key of keys) {
    const c = before.get(key) ?? 0;
    const k = after.get(key) ?? 0;
    if (k > c || (k < c && alike && insideOf(key, [reference, killed]) === undefined)) {
      out.push([key, c, k]);
    }
  }
  if (unwound) {
    const expected = reference.compensated.filter((name) =>
      killed.forward.has(name.slice(COMPENSATE_PREFIX.length)),
    );
    const order = (list: readonly string[]): string => list.join(' → ') || 'none';
    if (order(killed.compensated) !== order(expected)) {
      out.push([`compensators ${order(killed.compensated)}, not ${order(expected)}`, 0, 1]);
    }
  }
  return out;
}

export async function crashProof<I>(
  handle: JobHandle<I>,
  input: I,
  options: CrashProofOptions = {},
): Promise<CrashReport> {
  const boundaries: CrashBoundary[] = [];
  const divergences: CrashDivergence[] = [];
  const reruns: CrashRerun[] = [];
  const modes: readonly CrashBoundary['mode'][] = handle.compensates
    ? ['clean', 'forced-fail']
    : ['clean'];
  // A kill on the final attempt of a compensating job unwinds it: that run is held to the run
  // forced to fail for good, never to the clean one it no longer resembles.
  const failed = handle.compensates
    ? await runOnce(handle, input, { forceFail: true }, options)
    : undefined;
  for (const mode of modes) {
    const forceFail = mode === 'forced-fail';
    const clean =
      forceFail && failed !== undefined
        ? failed
        : await runOnce(handle, input, { forceFail }, options);
    const afterOf = (key: string): string | undefined =>
      clean.effects.find((effect) => effect.key === key)?.after;
    for (let at = 1; at <= clean.boundaries.length; at += 1) {
      const label = clean.boundaries[at - 1] ?? '?';
      const killed = await runOnce(handle, input, { at, fault: 'kill', forceFail }, options);
      boundaries.push({
        at: label,
        mode,
        state: killed.settled,
        ...(killed.code === undefined ? {} : { code: killed.code }),
      });
      const reference =
        failed !== undefined && killed.compensated.length > 0 && clean.compensated.length === 0
          ? failed
          : clean;
      for (const [effect, c, k] of compare(reference, killed)) {
        const after = afterOf(effect);
        const inside = insideOf(effect, [reference, killed]);
        const where = {
          ...(after === undefined ? {} : { after }),
          ...(inside === undefined ? {} : { inside }),
        };
        divergences.push({
          boundary: label,
          mode,
          effect,
          clean: c,
          killed: k,
          ...(inside === undefined ? {} : { inside }),
          error: new JobCrashDivergedError({
            job: handle.name,
            boundary: label,
            effect,
            clean: c,
            killed: k,
            ...where,
          }),
        });
      }
      if (forceFail) continue;
      const lost = await runOnce(handle, input, { at, fault: 'lose', forceFail }, options);
      for (const [effect, c, k] of compare(clean, lost)) {
        if (k > c) reruns.push({ boundary: label, effect, clean: c, rerun: k });
      }
    }
  }
  return { boundaries, divergences, reruns };
}
