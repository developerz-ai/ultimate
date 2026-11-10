// The bound on live print browsers: a counting semaphore, first come first served. A queued render
// waits on the CLOCK (never a timer of its own — `clock-discipline.test.ts`) for a bounded time and
// then refuses with a code; an aborted request leaves the queue at once and takes no slot.

import type { SleepClock } from '@ultimat3/core';
import { pdfBusy } from './error-throws-pdf';

export interface PdfSlotsOptions {
  readonly maxConcurrent: number;
  readonly queueTimeoutMs: number;
  /** Read per wait, so an `installClock` made after the renderer still governs it. */
  readonly clock: () => SleepClock;
}

export interface PdfSlots {
  /** Answers the release — idempotent — once a slot is this caller's. */
  acquire(signal?: AbortSignal): Promise<() => void>;
}

interface Waiter {
  readonly grant: () => void;
}

export function pdfSlots(options: PdfSlotsOptions): PdfSlots {
  let busy = 0;
  const queue: Waiter[] = [];
  const releaser = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = queue.shift();
      // The slot passes straight to the next waiter: `busy` never dips, so no newcomer jumps it.
      if (next === undefined) busy -= 1;
      else next.grant();
    };
  };
  return {
    async acquire(signal) {
      signal?.throwIfAborted();
      if (busy < options.maxConcurrent) {
        busy += 1;
        return releaser();
      }
      const granted = new AbortController();
      const waiter: Waiter = { grant: () => granted.abort() };
      queue.push(waiter);
      const leave = (): void => {
        const at = queue.indexOf(waiter);
        if (at !== -1) queue.splice(at, 1);
      };
      try {
        const wake =
          signal === undefined ? granted.signal : AbortSignal.any([granted.signal, signal]);
        await options.clock().sleep(options.queueTimeoutMs, wake);
      } catch (error) {
        // Woken: either the slot is ours, or the caller gave up — the request's reason, verbatim.
        if (granted.signal.aborted) return releaser();
        leave();
        throw signal?.aborted === true ? signal.reason : error;
      }
      // Slept the whole deadline. A grant racing the wake-up still owns the slot: hand it back.
      if (granted.signal.aborted) return releaser();
      leave();
      throw pdfBusy(options);
    },
  };
}
