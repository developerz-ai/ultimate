// Durable compensation: the stack a replay rebuilds, and the unwind that runs it. No closure is
// stored — the body replays from the top, so each `step.run` re-registers its own — and every
// compensator runs as an ordinary step `compensate:<name>`, so a replay skips what already ran.

import { renderThrowable } from '@ultimat3/core';
import { COMPENSATE_PREFIX, JobCompensationFailedError, UNWINDING_STEP } from './errors-saga';
import type { RunnerCore } from './steps-core';
import type { StepRecord } from './steps-store';

/** Runs one step body and records it — `steps.ts`'s, shared so a compensator is a step like any. */
export type StepExecutor = (
  name: string,
  existing: StepRecord | undefined,
  fn: (signal: AbortSignal) => unknown,
) => Promise<unknown>;

interface Compensation {
  readonly step: string;
  /** Absent for a `once` step whose outcome is unknown: there is no output to undo from. */
  readonly undo?: (signal: AbortSignal) => unknown;
}

export interface CompensationStack {
  /** A completed step with a compensator, in the order it completed. */
  done(step: string, undo: (signal: AbortSignal) => unknown): void;
  /** A `once` step with a compensator whose outcome nobody knows. */
  unknown(step: string): void;
  /**
   * Write `unwinding` (once, before the first compensator), then run every registered compensator
   * last-in first-out. Answers the failure the run is unwinding FROM: the one `unwinding` already
   * holds, or `failure` when this call wrote it. A compensator that throws, or an unknown `once`
   * step, is `X_JOB_COMPENSATION_FAILED`.
   */
  unwind(failure: string): Promise<string>;
}

/** The failure an `unwinding` record carries, when it carries one. */
export function unwoundFrom(record: StepRecord | undefined): string | undefined {
  const output = record?.output;
  if (typeof output !== 'object' || output === null) return undefined;
  const error = (output as Record<string, unknown>)['error'];
  return typeof error === 'string' ? error : undefined;
}

export function compensationStack(core: RunnerCore, execute: StepExecutor): CompensationStack {
  const entries: Compensation[] = [];
  return {
    done: (step, undo) => entries.push({ step, undo }),
    unknown: (step) => entries.push({ step }),
    async unwind(failure) {
      const mark = await core.load(UNWINDING_STEP);
      const original = unwoundFrom(mark) ?? failure;
      if (mark === undefined) {
        const at = core.now();
        await core.put({
          runId: core.runId,
          name: UNWINDING_STEP,
          status: 'completed',
          output: { error: original },
          startedAt: at,
          completedAt: at,
          attempts: 1,
        });
      }
      for (const entry of [...entries].reverse()) {
        if (entry.undo === undefined) {
          throw new JobCompensationFailedError({
            job: core.jobName,
            step: entry.step,
            outcome: 'unknown',
            reason: 'X_STEP_OUTCOME_UNKNOWN',
          });
        }
        const name = `${COMPENSATE_PREFIX}${entry.step}`;
        const existing = await core.load(name);
        if (existing?.status === 'completed') {
          core.replayed(name);
          continue;
        }
        try {
          await execute(name, existing, entry.undo);
        } catch (error) {
          throw new JobCompensationFailedError({
            job: core.jobName,
            step: entry.step,
            outcome: 'failed',
            reason: renderThrowable(error),
          });
        }
      }
      return original;
    },
  };
}
