// How many dropped frames close a socket: more than `maxDroppedFrames` inside one window, never a
// lifetime count. Split from `socket.ts`, which counts the drops; this decides what they mean.

/**
 * The window `maxDroppedFrames` is counted over. Ten seconds: long enough that a burst of
 * backpressure drops closes a socket that cannot keep up, short enough that a connection open for
 * hours is never closed for a lifetime's worth of isolated drops.
 */
export const DROP_WINDOW_MS = 10_000;

/**
 * The instants of the drops inside the current window. A burst of backpressure drops closes a
 * socket that cannot keep up; the same number spread over a connection open for hours is a flaky
 * link the cursor repairs, and closing for it was a healthy socket lost after 33 lifetime drops.
 */
export class DropWindow {
  readonly #max: number;
  readonly #recent: number[] = [];

  constructor(max: number) {
    this.#max = max;
  }

  /** Records one drop at `now` (monotonic ms) and answers whether the window is over its ceiling. */
  overflowed(now: number): boolean {
    this.#recent.push(now);
    while ((this.#recent[0] ?? now) <= now - DROP_WINDOW_MS) this.#recent.shift();
    return this.#recent.length > this.#max;
  }
}
