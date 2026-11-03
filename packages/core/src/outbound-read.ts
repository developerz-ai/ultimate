// Single responsibility: an outbound response body read under two bounds a header-only deadline
// never gave — an IDLE watchdog (a body that stops sending is abandoned, measured: a stalled body
// under a header deadline was `still-reading-after-300ms`) and a byte cap, counted as it arrives
// so nothing past it is held. A bytes read is capped by `read-capped.ts`, the one counting reader.

import type { DeadlineTimer } from './deadline-signal';

export interface WatchedBodyOptions {
  readonly idleMs: number;
  /**
   * The cap a STREAMED body is held to. Absent for a bytes read, which `read-capped.ts`'s
   * `readWithinLimit` caps itself: the one counting reader, and it never holds an over-cap body.
   */
  readonly maxBytes?: number | undefined;
  readonly timer: DeadlineTimer;
  /** Ends a pending read at once, as a `source` failure carrying the signal's reason. */
  readonly signal?: AbortSignal | undefined;
  /** The gap passed: abort the attempt, so the fetch lets its socket go. */
  readonly onIdle: () => void;
  /** The coded error a source failure, an idle gap or the cap becomes for whoever reads. */
  readonly failure: (cause: WatchedFailure) => unknown;
  /** Settled once, however the stream ends: read out, cancelled or failed. */
  readonly onSettled: () => void;
}

export type WatchedFailure =
  | { readonly kind: 'idle' }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'source'; readonly error: unknown };

/**
 * `body` behind the watchdog and the cap. Pull-driven, so the timer runs only while a reader is
 * WAITING on the vendor: a consumer slow to pull is its own business, never the vendor's idle gap.
 * The gap and `signal` end a pending read THEMSELVES, rather than trusting the source to reject
 * when its fetch is aborted: a body that ignores the abort must not hold the reader past its bound.
 */
export function watchedBody(
  body: ReadableStream<Uint8Array>,
  options: WatchedBodyOptions,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const { signal } = options;
  let total = 0;
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    options.onSettled();
  };
  const fail = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    cause: WatchedFailure,
  ): void => {
    controller.error(options.failure(cause));
    settle();
    reader.cancel().catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>({
    pull: (controller) =>
      new Promise<void>((done) => {
        let finished = false;
        const finish = (): boolean => {
          if (finished) return false;
          finished = true;
          options.timer.clear(handle);
          signal?.removeEventListener('abort', aborted);
          return true;
        };
        const stop = (cause: WatchedFailure): void => {
          if (!finish()) return;
          if (cause.kind === 'idle') options.onIdle();
          fail(controller, cause);
          done();
        };
        const aborted = (): void => stop({ kind: 'source', error: signal?.reason });
        const handle = options.timer.set(() => stop({ kind: 'idle' }), options.idleMs);
        if (signal?.aborted === true) return aborted();
        signal?.addEventListener('abort', aborted, { once: true });
        reader.read().then(
          (next) => {
            if (!finish()) return;
            if (next.done) {
              controller.close();
              settle();
              return done();
            }
            total += next.value.byteLength;
            if (options.maxBytes !== undefined && total > options.maxBytes) {
              fail(controller, { kind: 'too-large' });
            } else {
              controller.enqueue(next.value);
            }
            done();
          },
          (error: unknown) => stop({ kind: 'source', error }),
        );
      }),
    async cancel(reason): Promise<void> {
      settle();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}
