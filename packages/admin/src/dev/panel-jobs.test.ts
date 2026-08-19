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

describe('the retry target is the FIRST failed step, so a retry replays nothing that succeeded', () => {
  const step = (
    over: Partial<JobRunFact['steps'][number]> & { name: string },
  ): JobRunFact['steps'][number] => ({
    status: 'ok',
    attempt: 1,
    durationMs: 10,
    ...over,
  });

  test('a failed run points at its first failed step, with that step’s error', async () => {
    const data = await jobsPanel.data(
      staticDevSources({
        jobRuns: () =>
          Promise.resolve([
            run({
              id: 'r1',
              status: 'failed',
              steps: [
                step({ name: 'load' }),
                step({ name: 'write', status: 'failed', attempt: 3, error: 'deadlock' }),
                step({ name: 'notify', status: 'failed', attempt: 1, error: 'later' }),
              ],
            }),
          ]),
      }),
      new URLSearchParams(),
    );

    expect(data.retryTargets).toEqual([
      {
        runId: 'r1',
        job: 'recount-likes',
        // `notify` also failed; retrying from it would skip the write that never landed.
        fromStep: 'write',
        attempt: 3,
        error: 'deadlock',
      },
    ]);
  });

  test('a dead run is a retry target too, and is the one listed as dead-lettered', async () => {
    const data = await jobsPanel.data(
      staticDevSources({
        jobRuns: () =>
          Promise.resolve([
            run({ id: 'ok', status: 'ok', steps: [step({ name: 'load' })] }),
            run({
              id: 'failed',
              status: 'failed',
              steps: [step({ name: 'write', status: 'failed', attempt: 2 })],
            }),
            run({
              id: 'dead',
              status: 'dead',
              steps: [step({ name: 'write', status: 'failed', attempt: 5 })],
            }),
          ]),
      }),
      new URLSearchParams(),
    );

    // Only `dead`: a `failed` run is still in the queue's own retry loop, and listing it as
    // dead-lettered puts `x jobs retry` in front of a reader for work that is already retrying.
    expect(data.deadLetter.map((entry) => entry.id)).toEqual(['dead']);
    expect(data.retryTargets.map((target) => target.runId)).toEqual(['failed', 'dead']);
    // A step with no error text still produces a target — `''`, never `undefined`, so the panel
    // renders a row rather than a hole.
    expect(data.retryTargets[1]?.error).toBe('');
  });

  test('a failed run with no failed step is dropped rather than pointing at nothing', async () => {
    const data = await jobsPanel.data(
      staticDevSources({
        jobRuns: () =>
          Promise.resolve([run({ id: 'r1', status: 'failed', steps: [step({ name: 'load' })] })]),
      }),
      new URLSearchParams(),
    );
    expect(data.retryTargets).toEqual([]);
  });

  test('a healthy run is neither a retry target nor dead-lettered', async () => {
    const data = await jobsPanel.data(
      staticDevSources({
        jobRuns: () =>
          Promise.resolve([
            run({ id: 'r1', status: 'ok', steps: [step({ name: 'write', status: 'failed' })] }),
          ]),
      }),
      new URLSearchParams(),
    );
    // The step list is not the verdict: the RUN's status is what decides a retry is offered.
    expect(data.retryTargets).toEqual([]);
    expect(data.deadLetter).toEqual([]);
  });
});

describe('totalDepth is the whole backlog, across every queue', () => {
  test('it sums the queues rather than reporting the first or the largest', async () => {
    const data = await jobsPanel.data(
      staticDevSources({
        queues: () =>
          Promise.resolve([
            { name: 'default', depth: 4, running: 1, failed: 0, deadLetter: 0 },
            { name: 'mail', depth: 7, running: 0, failed: 2, deadLetter: 1 },
          ]),
      }),
      new URLSearchParams(),
    );
    expect(data.totalDepth).toBe(11);
  });
});
