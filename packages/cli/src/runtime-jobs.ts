// `jobs.queues`, `jobs.concurrency` and `jobs.visibilityTimeoutMs`, read out of the app's own
// `app.config.ts` for the `worker` role — the sibling of `runtime-realtime.ts`, and structural
// for its reason. Until 22.0.0 `createWorker` was called with none of them: every worker served
// `default` at its own concurrency whatever the config said, so a `mail` queue ran nothing.

// why: Bun ships no path-joining API — `Object.keys(Bun)` has `file`, `write`, `Glob`,
// `pathToFileURL` and `fileURLToPath`, and nothing that joins a path.
import { join } from 'node:path';
import { registeredJobs, type WorkerOptions } from '@ultimat3/jobs';
import { APP_CONFIG_EXPORT } from './app-auth';
import { APP_CONFIG_FILE } from './app-root';

/** What the worker takes from the config. An absent number keeps the worker's own default. */
export interface WorkerConfig {
  readonly queues: readonly string[];
  readonly concurrency: number | undefined;
  readonly visibilityTimeoutMs: number | undefined;
}

const NO_WORKER_CONFIG: WorkerConfig = Object.freeze({
  queues: [],
  concurrency: undefined,
  visibilityTimeoutMs: undefined,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * A number is handed on AS WRITTEN, never screened here: `createWorker`'s `resolveWorkerTimings`
 * is the one refusal for a non-finite knob, and core's `defineConfig` screens both counts first.
 */
const numberOf = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : undefined;

export async function loadWorkerConfig(root: string): Promise<WorkerConfig> {
  const path = join(root, APP_CONFIG_FILE);
  if (!(await Bun.file(path).exists())) return NO_WORKER_CONFIG;
  const module = (await import(path)) as Record<string, unknown>;
  const config = module[APP_CONFIG_EXPORT];
  const jobs = isRecord(config) ? config['jobs'] : undefined;
  if (!isRecord(jobs)) return NO_WORKER_CONFIG;
  const queues = Array.isArray(jobs['queues'])
    ? jobs['queues'].filter((queue): queue is string => typeof queue === 'string' && queue !== '')
    : [];
  return {
    queues,
    concurrency: numberOf(jobs['concurrency']),
    visibilityTimeoutMs: numberOf(jobs['visibilityTimeoutMs']),
  };
}

/**
 * The queues a worker serves: the configured ones, then every queue a registered job is enqueued
 * on. The union and not the list, decided 2026-09-23: `x new` and the deployed demo configure
 * `['<app>-default']` while a `job()` naming no queue lands on `default`, so obeying the list alone
 * would leave every such job queued for ever — the silent direction. `undefined` when both are
 * empty, which is `createWorker`'s own `['default']`.
 */
export function workerQueuesFor(
  configured: readonly string[],
  registered: readonly string[],
): readonly string[] | undefined {
  const served = [...new Set([...configured, ...registered])];
  return served.length === 0 ? undefined : served;
}

type WorkerConfigOptions = Pick<WorkerOptions, 'queues' | 'concurrency' | 'visibilityTimeoutMs'>;

/**
 * The `createWorker` options the config supplies, read at START so every job the app registered
 * on import is counted. A key the config leaves unset is omitted, never passed as `undefined`, so
 * the worker's own default applies (`exactOptionalPropertyTypes`).
 */
export function workerOptionsFor(config: WorkerConfig | undefined): WorkerConfigOptions {
  const queues = workerQueuesFor(
    config?.queues ?? [],
    registeredJobs().map((handle) => handle.queue),
  );
  return {
    ...(queues === undefined ? {} : { queues }),
    ...(config?.concurrency === undefined ? {} : { concurrency: config.concurrency }),
    ...(config?.visibilityTimeoutMs === undefined
      ? {}
      : { visibilityTimeoutMs: config.visibilityTimeoutMs }),
  };
}
