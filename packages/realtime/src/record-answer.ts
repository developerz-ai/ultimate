// What a read hook hands back when nothing it shows moved: the SAME answer object. Solid compares a
// memo's value with `===`, so a fresh array of the same rows re-ran every derivation below it — a
// panel had to diff rows by hand (`stableRuns`, `sameData`) to keep a board still. And how often a
// hook may tell its readers at all: `throttleMs`, the first change at once, a burst as one.

import type { AsyncState } from '@ultimat3/core/page';
import { finiteCount } from '@ultimat3/core/page';
import { type Scheduler, timeoutScheduler } from './thundering-herd';

/** Same length, same row OBJECTS in the same order. The store keeps an unmoved row's object. */
export function sameRows<R>(a: readonly R[], b: readonly R[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

/**
 * The rows to answer with: the previous answer's own array when it holds exactly these rows, so a
 * re-read that found nothing new (a poll, a refetch, a change to a row the list does not show)
 * hands every reader the value it already holds.
 */
export function keptRows<R>(previous: AsyncState<readonly R[]> | null, rows: readonly R[]) {
  const held = previous !== null && 'data' in previous ? previous.data : undefined;
  return held !== undefined && sameRows(held, rows) ? held : rows;
}

/** `{ status, data }`, reusing `previous` when both match — the identity a renderer stops on. */
export function keptAnswer<R>(
  previous: AsyncState<readonly R[]> | null,
  status: 'ready' | 'refreshing',
  rows: readonly R[],
): AsyncState<readonly R[]> {
  const data = keptRows(previous, rows);
  if (
    previous !== null &&
    previous.status === status &&
    'data' in previous &&
    previous.data === data
  )
    return previous;
  return { status, data };
}

export interface Notifier {
  /** A change readers should hear: now, or at the end of the open period. */
  readonly call: () => void;
  /** The hook let go: an owed notification is dropped with it. */
  readonly cancel: () => void;
}

/**
 * `notify` at most once per `ms`: a change with no period open is told AT ONCE (a lone update is
 * never delayed) and opens one; changes inside it are told ONCE at its end, which opens the next.
 * The last change always lands. No clock: the scheduler's timer is the period. `0` or absent: every
 * change, synchronously — what a hook did before the option existed.
 */
export function throttledNotify(
  notify: () => void,
  ms: number | undefined,
  schedule: Scheduler = timeoutScheduler,
): Notifier {
  if (ms === undefined || finiteCount('useRecords', 'throttleMs', ms) === 0) {
    return { call: notify, cancel: () => undefined };
  }
  let cancelTimer: (() => void) | null = null;
  let owed = false;
  const open = (): void => {
    cancelTimer = schedule(() => {
      cancelTimer = null;
      if (!owed) return;
      owed = false;
      notify();
      open();
    }, ms);
  };
  return {
    call: () => {
      if (cancelTimer !== null) {
        owed = true;
        return;
      }
      notify();
      open();
    },
    cancel: () => {
      cancelTimer?.();
      cancelTimer = null;
      owed = false;
    },
  };
}
