// What a primitive's call left on its queue, read off the call's own ambient queue: the jobs it
// enqueued (its effects) and, for a tenant proof's B leg, every queued job's input (its payloads).

import { LIVE_STATES, registeredJobs } from '@ultimat3/jobs';
import { ambientJobRows } from './exercise-job-run';
import type { EffectPayload, ExerciseEffect } from './exercise-report';
import type { Subject } from './exercise-subjects';

/** The ids of every row the call's queue holds now: what an attempt adds is the call's. */
export const queuedIds = async (): Promise<ReadonlySet<string>> =>
  new Set((await ambientJobRows()).map((record) => record.id));

/**
 * Jobs the primitive queued — rows an ATTEMPT added (`mine`), still live — its own job excepted.
 * Never run: a job's children are left queued as an action's are (`exercise-job-run.ts`). A row
 * the override's input added between calls is on the same queue, so the call can find it, and is
 * not in `mine`: the input's enqueue is never the primitive's.
 */
export async function enqueued(subject: Subject, mine: ReadonlySet<string>) {
  const counts = new Map<string, number>();
  for (const record of await ambientJobRows()) {
    if (!mine.has(record.id) || !LIVE_STATES.has(record.state)) continue;
    if (subject.kind === 'job' && record.name === subject.name) continue;
    counts.set(record.name, (counts.get(record.name) ?? 0) + 1);
  }
  const order = registeredJobs().map((handle) => handle.name);
  return [...counts]
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([job, count]): ExerciseEffect => ({ kind: 'enqueue', job, count }));
}

/**
 * Every job a B leg's queue holds or ran, with its input — the subject's own job excepted, whose
 * input is what B was handed. Read off the leg's own queue, page by page.
 */
export async function queuedPayloads(subject: Subject): Promise<readonly EffectPayload[]> {
  return (await ambientJobRows())
    .filter((record) => !(subject.kind === 'job' && record.name === subject.name))
    .map((record, i) => ({
      path: `effect.enqueue[${i}]`,
      value: { job: record.name, input: record.input },
    }));
}
