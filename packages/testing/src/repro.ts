// `reproduce(bundle)` and `reproJob(runJobs, failure)` — what a test `x repro --write` generated
// calls. Request: seed the rows the failing call read, freeze the clock at its instant, invoke as
// its actor with its input (masked fields stood in for). Job: the stored input, the completed steps
// replayed from their output, one drain. Each ANSWERS the outcome; the test asserts on it.

import type { Actor, FailureBundle, FailureRead } from '@ultimat3/core';
import {
  agentActor,
  anonymousActor,
  ctxOf,
  frozenClock,
  isUltimateError,
  renderThrowable,
  serviceActor,
  userActor,
} from '@ultimat3/core';
import type { Driver, EntityCore, RowWrite } from '@ultimat3/entity';
import type { JobHandle } from '@ultimat3/jobs';
import type { RunJobs } from './fixture-jobs';

/** What a replay ended in. `failure` is `CODE: cause` (or the thrown value rendered), else `null`. */
export interface ReproOutcome {
  readonly code: string | null;
  readonly failure: string | null;
  /** A job's: the step whose record ended `failed`, `null` for a request or a body-level throw. */
  readonly step: string | null;
}

/** A dead job, as `x repro <jobId>` read it: everything a replay needs and nothing it does not. */
export interface JobFailure {
  readonly jobId: string;
  readonly name: string;
  readonly input: unknown;
  readonly masked: readonly string[];
  /** Completed steps, in order, with the output each returned: replayed, never re-executed. */
  readonly steps: readonly { readonly name: string; readonly output: unknown }[];
  readonly code: string | null;
  readonly step: string | null;
}

export interface ReproduceOptions {
  /** The app's own driver (`@<app>/db`'s `driver`): captured rows go where the code reads. */
  readonly driver?: Driver | undefined;
}

const outcomeOf = (error: unknown): ReproOutcome => ({
  code: isUltimateError(error) ? error.code : 'X_INTERNAL',
  failure: isUltimateError(error) ? `${error.code}: ${error.cause}` : renderThrowable(error),
  step: null,
});

const PASSED: ReproOutcome = { code: null, failure: null, step: null };

function actorFrom(captured: FailureBundle['actor']): Actor {
  if (captured === null || captured.kind === 'anonymous') return anonymousActor();
  const init = {
    id: captured.id,
    orgId: captured.orgId ?? undefined,
    roles: captured.roles,
    scopes: captured.scopes,
    permissions: captured.permissions,
  };
  if (captured.kind === 'service') return serviceActor(init);
  if (captured.kind === 'agent') return agentActor(init);
  return userActor(init);
}

/** Each captured row written through its entity's repository, replay-safe (`onMatch: 'nothing'`). */
async function seedReads(
  reads: readonly FailureRead[],
  driver: Driver,
): Promise<readonly string[]> {
  const { getEntity } = await import('@ultimat3/entity');
  const { rowStandIn } = await import('./repro-stand-in');
  const unknown: string[] = [];
  for (const read of reads) {
    const entity = getEntity(read.entity)?.core as EntityCore<unknown> | undefined;
    if (entity === undefined) {
      unknown.push(read.entity);
      continue;
    }
    // `$parse` answers the entity's own row; the registry erased its type, the write restores it.
    const row = entity.$parse(rowStandIn(entity, read.row, read.masked)) as RowWrite<unknown>;
    await driver.repo(entity).upsertAll([row], {
      onConflict: [...entity.$primaryKey] as never,
      onMatch: 'nothing',
    });
  }
  return unknown;
}

/**
 * Replay one captured request. A bundle naming an action or query this process has not registered
 * answers that as its failure rather than throwing: the written test is red with the reason.
 */
export async function reproduce(
  bundle: FailureBundle,
  options: ReproduceOptions = {},
): Promise<ReproOutcome> {
  if (options.driver !== undefined) {
    options.driver.reset?.();
    await seedReads(bundle.reads, options.driver);
  }
  const ctx = ctxOf({ actor: actorFrom(bundle.actor), clock: frozenClock(bundle.at) });
  const { inputStandIn } = await import('./repro-stand-in');
  try {
    if (bundle.primitive === 'action') {
      const { invoke, listActions } = await import('@ultimat3/action');
      const target = listActions().find((candidate) => candidate.name === bundle.name);
      if (target === undefined) return unregistered('action', bundle.name);
      await invoke(target, inputStandIn(target.input, bundle.input, bundle.masked), { ctx });
    } else {
      const { listQueries, runQuery } = await import('@ultimat3/query');
      const target = listQueries().find((candidate) => candidate.name === bundle.name);
      if (target === undefined) return unregistered('query', bundle.name);
      await runQuery(target, inputStandIn(target.input, bundle.input, bundle.masked), { ctx });
    }
    return PASSED;
  } catch (error) {
    return outcomeOf(error);
  }
}

const unregistered = (kind: string, name: string): ReproOutcome => ({
  code: null,
  step: null,
  failure: `no ${kind} named "${name}" is registered in this test process — import the module that declares it from the written test`,
});

/** Replay one dead job through the `runJobs` fixture: its input, its completed steps, one drain. */
export async function reproJob(runJobs: RunJobs, failure: JobFailure): Promise<ReproOutcome> {
  const jobs = await import('@ultimat3/jobs');
  const handle = jobs.registeredJobs().find((candidate) => candidate.name === failure.name);
  if (handle === undefined) return unregistered('job', failure.name);
  const { inputStandIn } = await import('./repro-stand-in');
  const input = inputStandIn(handle.input, failure.input, failure.masked);
  const { runId } = await runJobs.enqueue(handle as JobHandle<unknown>, input);
  const store = jobs.jobDriver()?.steps;
  for (const step of failure.steps) {
    await store?.put({
      runId,
      name: step.name,
      status: 'completed',
      output: step.output,
      startedAt: 0,
      completedAt: 0,
      attempts: 1,
    });
  }
  const trace = await runJobs.drain();
  const run = trace.executions.find((execution) => execution.error !== undefined);
  if (run?.error === undefined) return PASSED;
  return {
    code: /X_[A-Z0-9_]+/.exec(run.error)?.[0] ?? 'X_INTERNAL',
    failure: run.error,
    step: run.steps.find((step) => step.status === 'failed')?.name ?? null,
  };
}
