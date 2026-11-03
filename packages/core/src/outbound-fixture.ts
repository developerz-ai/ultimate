// TEST-ONLY. The seams an `outbound()` test drives instead of a network and a wall clock: a timer
// a case fires by its delay, a body whose chunks the case releases, and a recording fetch.

import type { DeadlineTimer } from './deadline-signal';
import type { OutboundFetch, OutboundInit } from './outbound-types';

export interface ManualTimer extends DeadlineTimer {
  /** Delays armed and not yet cleared or fired. */
  armed(): readonly number[];
  /** Fire every timer armed with this delay; answers how many fired. */
  fire(ms: number): number;
  /** Resolves once a timer with this delay is armed: a pending body read arms its idle timer. */
  armedWith(ms: number): Promise<void>;
}

export function manualTimer(): ManualTimer {
  const pending = new Map<number, { readonly ms: number; readonly fire: () => void }>();
  const waiting: { readonly ms: number; readonly done: () => void }[] = [];
  let next = 0;
  return {
    set(fire, ms) {
      next += 1;
      pending.set(next, { ms, fire });
      for (const wait of waiting.filter((entry) => entry.ms === ms)) {
        waiting.splice(waiting.indexOf(wait), 1);
        wait.done();
      }
      return next;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
    armed: () => [...pending.values()].map((entry) => entry.ms),
    fire(ms) {
      const due = [...pending].filter(([, entry]) => entry.ms === ms);
      for (const [handle, entry] of due) {
        pending.delete(handle);
        entry.fire();
      }
      return due.length;
    },
    armedWith(ms) {
      if ([...pending.values()].some((entry) => entry.ms === ms)) return Promise.resolve();
      return new Promise((done) => waiting.push({ ms, done }));
    },
  };
}

/** A body the case feeds by hand: `push` a chunk, `end`, or leave it stalled. Counts cancels. */
export function heldBody(): {
  readonly stream: ReadableStream<Uint8Array>;
  push(text: string): void;
  end(): void;
  cancelled(): boolean;
} {
  let control: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      control = controller;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    push: (text) => control?.enqueue(new TextEncoder().encode(text)),
    end: () => control?.close(),
    cancelled: () => cancelled,
  };
}

export interface SentCall {
  readonly url: string;
  readonly init: OutboundInit;
}

/** A fetch answering from `answer`, each call recorded with the url and init it was sent. */
export function recordingFetch(
  answer: (call: SentCall, n: number) => Promise<Response> | Response,
): {
  readonly fetch: OutboundFetch;
  readonly calls: SentCall[];
} {
  const calls: SentCall[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return await answer(call, calls.length);
    },
  };
}

/** A fetch that only ends when its signal aborts, rejecting with the signal's reason. */
export const hangingFetch: OutboundFetch = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init.signal;
    if (signal === null || signal === undefined) return;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

/** Sleeps recorded, never waited for. */
export function recordedSleep(): {
  readonly sleep: (ms: number) => Promise<void>;
  readonly slept: number[];
} {
  const slept: number[] = [];
  return {
    slept,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  };
}
