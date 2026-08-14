// The jobs panel carries the WHOLE backfill ledger beside the queue rows, and a panel that
// quietly narrowed it — to `running`, or to the `?queue=` a run row is filtered by — would answer
// "has this ever swept here" with silence. That narrowing is what this file exists to refuse.

import { describe, expect, test } from 'bun:test';
import { staticDevSources } from './data';
import type { BackfillFact, JobRunFact } from './facts';
import { jobsPanel } from './panel-jobs';

const pass = (fact: Partial<BackfillFact> & { runId: string }): BackfillFact => ({
  name: 'recount-likes',
  status: 'running',
  rows: 0,
  cursor: null,
  startedAt: '2026-08-14T09:00:00.000Z',
  completedAt: null,
  durationMs: null,
  appVersion: '1.2.0',
  ...fact,
});

const run = (fact: Partial<JobRunFact> & { id: string }): JobRunFact => ({
  job: 'recount-likes',
  queue: 'default',
  status: 'running',
  attempt: 1,
  steps: [],
  ...fact,
});

describe('the jobs panel reports the backfill ledger', () => {
  test('every pass is carried, and only the live ones are counted in flight', async () => {
    const data = await jobsPanel.data(
      staticDevSources({
        backfills: () =>
          Promise.resolve([
            pass({ runId: 'r3', rows: 12_500, cursor: 'post_12500' }),
            pass({ runId: 'r2', status: 'failed', rows: 400, cursor: 'post_400' }),
            pass({
              runId: 'r1',
              status: 'completed',
              rows: 84_000,
              completedAt: '2026-08-14T09:04:00.000Z',
              durationMs: 240_000,
            }),
          ]),
      }),
      new URLSearchParams(),
    );

    // The whole ledger, because "has this ever run here, and what did it sweep" is the panel's
    // question — a filter to `running` would answer it with silence on a finished sweep.
    expect(data.backfills.map((entry) => entry.runId)).toEqual(['r3', 'r2', 'r1']);
    // A failed pass is an attempt the queue will retry, not a sweep in flight.
    expect(data.backfillsInFlight).toBe(1);
    expect(data.backfills[0]?.rows).toBe(12_500);
    expect(data.backfills[0]?.cursor).toBe('post_12500');
  });

  test('a ?queue= filter scopes the runs and never the ledger', async () => {
    const sources = staticDevSources({
      jobRuns: () =>
        Promise.resolve([run({ id: 'r3' }), run({ id: 'other', queue: 'mail', job: 'send' })]),
      backfills: () => Promise.resolve([pass({ runId: 'r3' })]),
    });

    const data = await jobsPanel.data(sources, new URLSearchParams('queue=mail'));

    // A backfill belongs to a table, not to a queue: scoping the ledger by the queue filter would
    // hide the one pass whose job row the same filter just dropped.
    expect(data.runs.map((entry) => entry.id)).toEqual(['other']);
    expect(data.backfills.map((entry) => entry.runId)).toEqual(['r3']);
    expect(data.backfillsInFlight).toBe(1);
  });

  test('an app that has never swept anything reports an empty ledger, not a failure', async () => {
    const data = await jobsPanel.data(staticDevSources(), new URLSearchParams());
    expect(data.backfills).toEqual([]);
    expect(data.backfillsInFlight).toBe(0);
  });
});
