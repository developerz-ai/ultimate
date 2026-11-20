// How many processes `runRole` runs, as the process the platform started decides it: the facts
// the count depends on, read here, and the count with the clamp that bound it, said in one boot
// line. Running the children is `supervise-run.ts`, loaded only when the count is more than one.

// why: one synchronous stat of a directory; `Bun.file().exists()` answers for files only.
import { existsSync } from 'node:fs';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import type { Role } from '@ultimat3/core';
import { logger, tryResolveEnvironment } from '@ultimat3/core';
import { PREBUILT_REGISTRY_DIR } from './serve-prebuilt-paths';
import type { ServeOptions } from './serve-types';
import { readCgroup } from './supervise-cgroup';
import type { ProcessCount } from './supervise-count';
import { ignoredRequest, readProcessesRequest, resolveProcessCount } from './supervise-count';
import { containerPool } from './supervise-pool';

export function processCountFor(options: ServeOptions, role: Role): Promise<ProcessCount> {
  return resolveProcessCount({
    env: options.env,
    role,
    platform: process.platform,
    environment: tryResolveEnvironment({ env: options.env }),
    cgroup: () => readCgroup(),
    parallelism: () => navigator.hardwareConcurrency,
    pool: () => containerPool(options, role),
    // Behind `await import()`: the app config and the cache and realtime packages it reads are
    // asked only when the CPU budget already allows more than one process.
    shared: async () => (await import('./supervise-facts')).sharedStateFacts(options, role),
    prebuilt: async () => existsSync(join(options.root, PREBUILT_REGISTRY_DIR)),
  });
}

/** `ultimate processes` — `count=`, `binding=` and each clamp: a fixed vocabulary a script may parse. */
export function logProcessCount(count: ProcessCount, role: Role): void {
  logger.info('ultimate processes', {
    role,
    count: count.count,
    requested: count.requested,
    binding: count.binding,
    ...count.clamps,
  });
  logNote(count.note);
}

/**
 * `x dev` runs every role in one process whatever `ULTIMATE_PROCESSES` says (it has its own
 * restarting supervisor); a count asked of it is said once, never refused. An invalid value is
 * refused as a container's boot refuses it: the `.env` that carries it would stop production too.
 */
export function logDevProcesses(env: ServeOptions['env']): void {
  logNote(ignoredRequest(readProcessesRequest(env), 'x dev').note);
}

function logNote(note: ProcessCount['note']): void {
  if (note === undefined) return;
  logger[note.level](note.msg, {
    cause: note.cause,
    ...(note.fix === undefined ? {} : { fix: note.fix }),
  });
}
