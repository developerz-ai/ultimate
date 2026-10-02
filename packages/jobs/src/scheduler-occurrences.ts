// Which occurrences of a task fall in a window, asked of a resolver that only answers "the first
// occurrence strictly after an instant". Split off `scheduler.ts` at the file-size ceiling: this
// is arithmetic over a cron, and that file is the dispatch round.

import { instant, nextCronOccurrence } from '@ultimat3/time';
import type { TaskHandle } from './task';

/** The first occurrence of `handle` strictly after `from`. */
export type NextRun = (handle: TaskHandle, from?: Date) => Date;

/** The scheduler's resolver unless one is injected (`SchedulerOptions.cron`). */
export const defaultCronResolver = (cron: string, options: { tz: string; from: Date }): Date =>
  // Instant is a branded Date, so it satisfies the resolver's Date return directly.
  nextCronOccurrence(cron, options.tz, instant(options.from));

/**
 * A task's next occurrence strictly after `from`, on the task's own zone — what a dashboard shows
 * as "next fire" without a running scheduler. The scheduler's default resolver, so the two never
 * disagree about when a task is due.
 */
export function nextTaskRun(handle: Pick<TaskHandle, 'cron' | 'tz'>, from: Date): Date {
  return defaultCronResolver(handle.cron, { tz: handle.tz, from });
}

/**
 * Occurrences in `(after, until]`, the first `maxCatchUp` of them. Walking forward from the
 * last fire is what makes catch-up possible at all — a scheduler that only knows "now" cannot
 * know what it missed. TRUNCATED, so its last element is the tenth occurrence after the
 * watermark and not the latest one missed; `latestOccurrenceBy` answers that question.
 */
export function occurrencesIn(
  nextRunFor: NextRun,
  handle: TaskHandle,
  after: number,
  until: number,
): readonly number[] {
  const out: number[] = [];
  let cursor = after;
  for (let i = 0; i < handle.maxCatchUp; i += 1) {
    const next = nextRunFor(handle, new Date(cursor)).getTime();
    if (!Number.isFinite(next) || next <= cursor || next > until) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/**
 * The latest occurrence at or before `until`, given one is known to lie in `(after, until]`.
 *
 * The resolver only answers "the first occurrence strictly after an instant", and walking it
 * forward from the watermark is bounded by `maxCatchUp` — which is how `skip` came to dispatch
 * the tenth minute after a three-hour outage and then the twentieth, one per tick, for a policy
 * whose whole promise is ONE dispatch (measured: twenty `catchUp=true` dispatches a second apart
 * for a minute cron down 14:23–17:34). So the latest is found by bisection over the instant the
 * resolver is asked from, not by walking: `next(x) <= until` is monotone in `x`, the invariant
 * is `next(lo) <= until < next(hi)`, and at `hi - lo === 1` the one occurrence in `(lo, until]`
 * is `next(lo)`. About 25 resolver calls for a three-hour gap and 35 for a year, whatever the
 * cron's period — never one per missed minute.
 */
export function latestOccurrence(
  nextRunFor: NextRun,
  handle: TaskHandle,
  after: number,
  until: number,
): number {
  const nextAfter = (from: number): number => nextRunFor(handle, new Date(from)).getTime();
  let lo = after;
  let hi = until;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (nextAfter(mid) <= until) lo = mid;
    else hi = mid;
  }
  return nextAfter(lo);
}
