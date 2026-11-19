// `x deploy verify`'s processes fact: the worker registry's live rows of this build, grouped by the
// container that wrote them. A container running `ULTIMATE_PROCESSES=N` registers N rows under one
// `host` (children share the container's hostname), each with its own share of the slots.

import type { WorkerRecord } from '@ultimat3/jobs';

export interface WorkerContainer {
  readonly host: string;
  /** Registry rows (processes) this container has serving this build. */
  readonly processes: number;
  /** Their slots summed: the container's `jobs.concurrency` total, however it was split. */
  readonly slots: number;
}

/** Serving rows of `build` per host, sorted by host. A draining or older row is the roll's, not this build's. */
export function workerContainers(
  workers: readonly WorkerRecord[],
  build: string,
): readonly WorkerContainer[] {
  const byHost = new Map<string, { processes: number; slots: number }>();
  for (const worker of workers) {
    if (worker.drainingAt !== undefined || worker.build !== build) continue;
    const seen = byHost.get(worker.host) ?? { processes: 0, slots: 0 };
    byHost.set(worker.host, {
      processes: seen.processes + 1,
      slots: seen.slots + worker.concurrency,
    });
  }
  return [...byHost.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([host, seen]) => ({ host, ...seen }));
}
