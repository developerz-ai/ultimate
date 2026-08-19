// Background work: `jobs` (enqueued) and `tasks` (scheduled). Both fail the same silent way —
// nothing throws, the work simply stops happening — which is why a removal on either side is
// breaking rather than a note in the diff.

import { canonical } from './build';
import type { ManifestChange } from './diff-change';
import { diffScalar, index } from './diff-change';
import type { JobFact, TaskFact } from './schema';

export function diffJobs(
  before: readonly JobFact[],
  after: readonly JobFact[],
): readonly ManifestChange[] {
  const changes: ManifestChange[] = [];
  const afterByName = index(after, (j) => j.name);
  const beforeByName = index(before, (j) => j.name);

  for (const job of before) {
    const next = afterByName.get(job.name);
    const path = `jobs.${job.name}`;
    if (next === undefined) {
      // Enqueued-but-undeliverable work is silent data loss, so a removal is breaking.
      changes.push({ kind: 'breaking', path, detail: 'job removed' });
      continue;
    }
    if (canonical(job.input) !== canonical(next.input)) {
      changes.push({
        kind: 'breaking',
        path: `${path}.input`,
        detail: 'input schema changed; in-flight payloads will not parse',
      });
    }
    // The same failure as a removal, from the worker's side: a fleet subscribed to the old queue
    // keeps running and stops receiving this job, and the rows pile up where nobody drains them.
    changes.push(
      ...diffScalar(
        'breaking',
        `${path}.queue`,
        job.queue,
        next.queue,
        (from, to) => `queue ${from} -> ${to}; workers bound to ${from} stop receiving it`,
      ),
    );
    changes.push(...diffRetry(path, job, next));
    if (canonical(job.steps) !== canonical(next.steps)) {
      changes.push({
        kind: 'internal',
        path: `${path}.steps`,
        detail: 'steps changed; resumed runs may replay differently',
      });
    }
  }
  for (const job of after) {
    if (!beforeByName.has(job.name)) {
      changes.push({ kind: 'additive', path: `jobs.${job.name}`, detail: 'job added' });
    }
  }
  return changes;
}

/**
 * Attempts are a durability promise: work that survived a provider blip at 5 attempts
 * dead-letters at 1, and nothing else in the manifest moves when that number does. Backoff only
 * changes the spacing between the same attempts, so it is internal.
 */
function diffRetry(path: string, before: JobFact, after: JobFact): readonly ManifestChange[] {
  const declared: unknown = before.retry;
  const next: unknown = after.retry;
  if (typeof declared !== 'object' || declared === null) return [];
  if (typeof next !== 'object' || next === null) return [];
  const from = (declared as Record<string, unknown>)['attempts'];
  const to = (next as Record<string, unknown>)['attempts'];
  const changes: ManifestChange[] = [];

  if (typeof from === 'number' && typeof to === 'number' && from !== to) {
    changes.push({
      kind: to < from ? 'breaking' : 'additive',
      path: `${path}.retry.attempts`,
      detail:
        to < from
          ? `attempts ${from} -> ${to}; a transient failure this survived now dead-letters`
          : `attempts ${from} -> ${to}`,
    });
  }
  changes.push(
    ...diffScalar(
      'internal',
      `${path}.retry.backoff`,
      (declared as Record<string, unknown>)['backoff'],
      (next as Record<string, unknown>)['backoff'],
      (a, b) => `backoff ${a} -> ${b}`,
    ),
  );
  return changes;
}

export function diffTasks(
  before: readonly TaskFact[],
  after: readonly TaskFact[],
): readonly ManifestChange[] {
  const changes: ManifestChange[] = [];
  const afterByName = index(after, (t) => t.name);
  const beforeByName = index(before, (t) => t.name);

  for (const task of before) {
    const next = afterByName.get(task.name);
    const path = `tasks.${task.name}`;
    if (next === undefined) {
      // Nothing throws when a schedule disappears — the work simply never runs again.
      changes.push({ kind: 'breaking', path, detail: 'task removed' });
      continue;
    }
    // WHEN it runs is not a caller's contract, but it is the fact an operator reads this file
    // for, and a zone change moves every fire time without touching the expression beside it.
    changes.push(
      ...diffScalar('internal', `${path}.cron`, task.cron, next.cron, (a, b) => `${a} -> ${b}`),
    );
    changes.push(
      ...diffScalar('internal', `${path}.tz`, task.tz, next.tz, (a, b) => `${a} -> ${b}`),
    );
    if (canonical(task.enqueues) !== canonical(next.enqueues)) {
      changes.push({ kind: 'internal', path: `${path}.enqueues`, detail: 'enqueued jobs changed' });
    }
  }
  for (const task of after) {
    if (!beforeByName.has(task.name)) {
      changes.push({ kind: 'additive', path: `tasks.${task.name}`, detail: 'task added' });
    }
  }
  return changes;
}
