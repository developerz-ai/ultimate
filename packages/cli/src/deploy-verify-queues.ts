// The real sources behind `x deploy verify`'s queue grade: the set an app's workers must claim, and
// the rows that say who claims them. Apart from the command so the verdict on the build alone never
// imports the app's module graph or a database driver.

import { dbExecutor, postgresClient } from '@ultimat3/db';
import type { JobDriver } from '@ultimat3/jobs';
import { postgresJobDriver, registeredJobs } from '@ultimat3/jobs';
import { loadAppConfig } from './app-config-load';
import { loadApp } from './app-load';
import type { ExpectedQueues, QueueReader } from './cmd-deploy-verify';
import { workerQueuesFor } from './runtime-jobs';

/**
 * What an unset `WORKER_QUEUES` serves: `jobs.queues` plus every registered job's queue. A closed
 * set: a `WORKER_QUEUES` pattern is refused at boot (`X_WORKER_QUEUE_UNKNOWN`), and a queue only
 * `enqueue({ queue })` reaches has to be in `jobs.queues`.
 */
export async function expectedQueues(root: string): Promise<ExpectedQueues> {
  const { findings } = await loadApp(root);
  const config = await loadAppConfig(root);
  const registered = registeredJobs().map((handle) => handle.queue);
  return { queues: workerQueuesFor(config?.jobs.queues ?? [], registered) ?? [], findings };
}

/** One connection, against the url given and never the ambient client: this process owns no db. */
export function openQueue(
  url: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<QueueReader> {
  const client = postgresClient({
    url,
    profile: { max: 1 },
    env,
    applicationName: 'x deploy verify',
  });
  const driver = postgresJobDriver({ executor: dbExecutor(() => client) });
  return Promise.resolve(queueReaderOf(driver, () => client.close()));
}

/**
 * Any driver as the grade's reader. A driver with no registry lists no worker: the grade then reads
 * every queue unserved, never served by default.
 */
export function queueReaderOf(driver: JobDriver, close: () => Promise<void>): QueueReader {
  return {
    workers: async () => (await driver.introspect?.workers()) ?? [],
    demand: () => driver.demand(),
    close,
  };
}
