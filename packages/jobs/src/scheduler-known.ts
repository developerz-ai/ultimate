// What a leading scheduler knows of each task between rounds: the watermark it last read or wrote,
// the first occurrence after it, and when a task found paused is looked at again. Apart from
// `scheduler.ts` because it is the round's memory — what makes an idle round touch no store and a
// cold round read every watermark in ONE statement rather than one a task.

import type { TaskHandle } from './task';

interface KnownTask {
  readonly handle: TaskHandle;
  readonly last: number;
  readonly nextDueAt: number;
  pausedUntil: number;
}

export interface TaskMemory {
  /** Nothing due and nothing to learn: the idle path, and it touches no store. */
  idle(handle: TaskHandle, at: number): boolean;
  /** The watermark this node last read or wrote for THIS handle; a swapped handle is unknown. */
  last(handle: TaskHandle): number | undefined;
  remember(handle: TaskHandle, last: number): void;
  /** A task found paused is left alone until `until`. */
  pause(taskName: string, until: number): void;
  /** Its watermark may have moved: read it again before trusting it. */
  forget(taskName: string): void;
  /** Leadership gained or lost: everything remembered is from before another node led. */
  clear(): void;
}

export function taskMemory(nextDueAfter: (handle: TaskHandle, last: number) => number): TaskMemory {
  const known = new Map<string, KnownTask>();
  const entry = (handle: TaskHandle): KnownTask | undefined => {
    const seen = known.get(handle.name);
    return seen !== undefined && seen.handle === handle ? seen : undefined;
  };
  return {
    idle(handle, at) {
      const seen = entry(handle);
      return seen !== undefined && (seen.nextDueAt > at || seen.pausedUntil > at);
    },
    last: (handle) => entry(handle)?.last,
    remember(handle, last) {
      known.set(handle.name, {
        handle,
        last,
        nextDueAt: nextDueAfter(handle, last),
        pausedUntil: Number.NEGATIVE_INFINITY,
      });
    },
    pause(taskName, until) {
      const seen = known.get(taskName);
      if (seen !== undefined) seen.pausedUntil = until;
    },
    forget(taskName) {
      known.delete(taskName);
    },
    clear() {
      known.clear();
    },
  };
}
