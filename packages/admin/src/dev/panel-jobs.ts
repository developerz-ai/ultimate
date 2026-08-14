// Panel: Jobs.
// Kills: "is the queue moving, and which step failed?" — queue depth, per-run step traces,
// the retry-from-step target, and the dead letter.

import type { BackfillFact, JobDefFact, JobRunFact, QueueFact, TaskFact } from './facts';
import type { DevPanel } from './panel';

export interface RetryTarget {
  readonly runId: string;
  readonly job: string;
  /** The first failed step: retrying from here replays nothing that already succeeded. */
  readonly fromStep: string;
  readonly attempt: number;
  readonly error: string;
}

export interface JobsPanelData {
  readonly queues: readonly QueueFact[];
  readonly jobs: readonly JobDefFact[];
  readonly tasks: readonly TaskFact[];
  readonly runs: readonly JobRunFact[];
  readonly deadLetter: readonly JobRunFact[];
  readonly retryTargets: readonly RetryTarget[];
  readonly totalDepth: number;
  /** Every pass the `x_backfills` ledger holds, newest first — see `backfillsInFlight`. */
  readonly backfills: readonly BackfillFact[];
  /**
   * The sweeps still going, split out rather than left for the reader to filter: a `?queue=`
   * filter scopes the runs on this panel and a backfill is not a queue, so the one number that
   * would otherwise be missed is how many passes are moving right now.
   */
  readonly backfillsInFlight: number;
}

const firstFailedStep = (run: JobRunFact): RetryTarget | null => {
  const step = run.steps.find((candidate) => candidate.status === 'failed');
  if (step === undefined) return null;
  return {
    runId: run.id,
    job: run.job,
    fromStep: step.name,
    attempt: step.attempt,
    error: step.error ?? '',
  };
};

export const jobsPanel: DevPanel<JobsPanelData> = {
  key: 'jobs',
  titleKey: 'dev.panel.jobs.title',
  questionKey: 'dev.panel.jobs.question',
  async data(sources, params): Promise<JobsPanelData> {
    const [queues, jobs, tasks, runs, backfills] = await Promise.all([
      sources.queues(),
      sources.jobDefs(),
      sources.tasks(),
      sources.jobRuns(),
      sources.backfills(),
    ]);
    const queueFilter = params.get('queue');
    const scoped = queueFilter === null ? runs : runs.filter((run) => run.queue === queueFilter);

    return {
      queues,
      jobs,
      tasks,
      runs: scoped,
      deadLetter: scoped.filter((run) => run.status === 'dead'),
      retryTargets: scoped
        .filter((run) => run.status === 'failed' || run.status === 'dead')
        .map(firstFailedStep)
        .filter((target): target is RetryTarget => target !== null),
      totalDepth: queues.reduce((sum, queue) => sum + queue.depth, 0),
      backfills,
      backfillsInFlight: backfills.filter((pass) => pass.status === 'running').length,
    };
  },
};
