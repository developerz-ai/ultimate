// Background work: the job facts nothing classified (queue, retry) and the whole `tasks` section.
// Deleting every scheduled task reported `buildId: content changed` and passed the gate.

import { describe, expect, test } from 'bun:test';
import type { ManifestSources } from './build';
import { diffManifest } from './diff';
import { fixtureManifest } from './diff-fixture';

const job = (overrides: Partial<NonNullable<ManifestSources['jobs']>[number]>) => [
  {
    name: 'sendMail',
    input: { orgId: 'uuid' },
    queue: 'critical',
    retry: { attempts: 5, backoff: 'exponential' },
    steps: ['a'],
    ...overrides,
  },
];

const task = (overrides: Partial<NonNullable<ManifestSources['tasks']>[number]>) => [
  {
    name: 'nightlyDigest',
    cron: '0 3 * * *',
    tz: 'Europe/Berlin',
    enqueues: ['sendMail'],
    ...overrides,
  },
];

const paths = (before = fixtureManifest(), after = fixtureManifest()) =>
  diffManifest(before, after);

describe('jobs', () => {
  test('a cap declared, edited or removed is internal — and an unchanged one is no change', () => {
    const keyed = { limit: 1, keyed: true, whenBusy: 'fail' };
    const at = (concurrency?: typeof keyed) =>
      fixtureManifest({ jobs: job(concurrency === undefined ? {} : { concurrency }) });
    const changed = (before: ReturnType<typeof at>, after: ReturnType<typeof at>) =>
      paths(before, after).internal.map((c) => c.path);

    expect(changed(at(), at(keyed))).toContain('jobs.sendMail.concurrency');
    expect(changed(at(keyed), at({ ...keyed, limit: 2 }))).toContain('jobs.sendMail.concurrency');
    expect(changed(at(keyed), at())).toContain('jobs.sendMail.concurrency');
    expect(changed(at(keyed), at({ ...keyed }))).not.toContain('jobs.sendMail.concurrency');
    expect(paths(at(), at(keyed)).hasBreaking).toBe(false);
  });

  test('an onSettled hook declared or removed is internal', () => {
    const hooked = fixtureManifest({ jobs: job({ onSettled: true }) });
    expect(paths(fixtureManifest(), hooked).internal.map((c) => c.path)).toContain(
      'jobs.sendMail.onSettled',
    );
    expect(paths(hooked, fixtureManifest()).internal.map((c) => c.path)).toContain(
      'jobs.sendMail.onSettled',
    );
    expect(paths(hooked, hooked).internal.map((c) => c.path)).not.toContain(
      'jobs.sendMail.onSettled',
    );
  });

  test('a moved queue is breaking — workers bound to the old one stop draining it', () => {
    const diff = paths(fixtureManifest(), fixtureManifest({ jobs: job({ queue: 'default' }) }));
    expect(diff.hasBreaking).toBe(true);
    expect(diff.breaking.map((c) => c.path)).toContain('jobs.sendMail.queue');
    expect(diff.breaking.find((c) => c.path === 'jobs.sendMail.queue')?.detail).toContain(
      'critical -> default',
    );
  });

  test('fewer retry attempts is breaking; more is additive', () => {
    const fewer = paths(
      fixtureManifest(),
      fixtureManifest({ jobs: job({ retry: { attempts: 0, backoff: 'exponential' } }) }),
    );
    expect(fewer.breaking.map((c) => c.path)).toContain('jobs.sendMail.retry.attempts');

    const more = paths(
      fixtureManifest(),
      fixtureManifest({ jobs: job({ retry: { attempts: 9, backoff: 'exponential' } }) }),
    );
    expect(more.hasBreaking).toBe(false);
    expect(more.additive.map((c) => c.path)).toContain('jobs.sendMail.retry.attempts');
  });

  test('a changed backoff is internal — the work still runs, the spacing moved', () => {
    const diff = paths(
      fixtureManifest(),
      fixtureManifest({ jobs: job({ retry: { attempts: 5, backoff: 'fixed' } }) }),
    );
    expect(diff.internal.map((c) => c.path)).toContain('jobs.sendMail.retry.backoff');
    expect(diff.hasBreaking).toBe(false);
  });

  test('an unchanged job reports nothing of its own', () => {
    expect(paths().changes.filter((c) => c.path.startsWith('jobs.'))).toEqual([]);
  });
});

describe('tasks', () => {
  test('a removed task is breaking — the schedule silently stops', () => {
    const diff = paths(fixtureManifest(), fixtureManifest({ tasks: [] }));
    expect(diff.hasBreaking).toBe(true);
    expect(diff.breaking.map((c) => c.path)).toContain('tasks.nightlyDigest');
  });

  test('an added task is additive', () => {
    const diff = paths(
      fixtureManifest({ tasks: [] }),
      fixtureManifest({ tasks: task({ name: 'nightlyDigest' }) }),
    );
    expect(diff.hasBreaking).toBe(false);
    expect(diff.additive.map((c) => c.path)).toContain('tasks.nightlyDigest');
  });

  test('a changed cron or zone is internal, and names both sides', () => {
    const cron = paths(fixtureManifest(), fixtureManifest({ tasks: task({ cron: '0 4 * * *' }) }));
    expect(cron.internal.map((c) => c.path)).toContain('tasks.nightlyDigest.cron');
    expect(cron.internal.find((c) => c.path === 'tasks.nightlyDigest.cron')?.detail).toContain(
      '0 3 * * * -> 0 4 * * *',
    );

    const tz = paths(fixtureManifest(), fixtureManifest({ tasks: task({ tz: 'UTC' }) }));
    expect(tz.internal.map((c) => c.path)).toContain('tasks.nightlyDigest.tz');
  });

  test('a changed enqueues list is internal', () => {
    const diff = paths(fixtureManifest(), fixtureManifest({ tasks: task({ enqueues: [] }) }));
    expect(diff.internal.map((c) => c.path)).toContain('tasks.nightlyDigest.enqueues');
  });

  test('an unchanged task reports nothing of its own', () => {
    expect(paths().changes.filter((c) => c.path.startsWith('tasks.'))).toEqual([]);
  });
});
