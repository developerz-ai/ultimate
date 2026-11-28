// The ONE per-frame loop: a canvas, a counter, a shader. It stops for four independent reasons —
// reduced motion, the reader's pause, a hidden tab, its element off screen — the twin of core's
// `visibleInterval()` for frames. A bare `requestAnimationFrame` loop never stops for any of them.

import { inView } from './in-view';
import { browserMotionHost, type MotionHost, motionAllowed } from './motion-gate';

export interface FrameLoopOptions {
  /** The element drawn into: the loop runs only while it is on screen. */
  readonly el?: Element | undefined;
}

/** The page, injected: a frame clock, visibility, the motion gate and an on-screen observer. */
export interface FrameHost {
  request(fn: () => void): unknown;
  cancel(id: unknown): void;
  now(): number;
  hidden(): boolean;
  onVisibility(fn: () => void): () => void;
  readonly motion: MotionHost;
  observe(el: Element, fn: (visible: boolean) => void): () => void;
}

type Hold = 'motion' | 'hidden' | 'offscreen';

/**
 * Call `tick(dt, now)` once per frame while nothing holds the loop. `dt` is the milliseconds since
 * the last tick, and 0 on the first tick after any stop — a loop that slept a minute must not
 * advance a minute. Returns an idempotent stop.
 */
export function frameLoop(
  tick: (dt: number, now: number) => void,
  options: FrameLoopOptions = {},
): () => void {
  return frameLoopOn(browserFrameHost(), tick, options);
}

/** `frameLoop` over an injected page; `null` (a server render) is a loop that never starts. */
export function frameLoopOn(
  host: FrameHost | null,
  tick: (dt: number, now: number) => void,
  options: FrameLoopOptions = {},
): () => void {
  if (host === null) return () => {};
  const holds = new Set<Hold>();
  let frame: unknown;
  let last: number | undefined;
  let stopped = false;

  const run = (): void => {
    frame = undefined;
    const now = host.now();
    const dt = last === undefined ? 0 : now - last;
    last = now;
    tick(dt, now);
    if (!stopped && holds.size === 0) frame = host.request(run);
  };
  const settle = (): void => {
    if (stopped) return;
    if (holds.size === 0 && frame === undefined) frame = host.request(run);
    if (holds.size > 0 && frame !== undefined) {
      host.cancel(frame);
      frame = undefined;
      last = undefined;
    }
  };
  const set = (hold: Hold, on: boolean): void => {
    if (on) holds.add(hold);
    else holds.delete(hold);
    settle();
  };

  const readMotion = (): void => set('motion', !motionAllowed(host.motion));
  const readHidden = (): void => set('hidden', host.hidden());
  if (!motionAllowed(host.motion)) holds.add('motion');
  if (host.hidden()) holds.add('hidden');
  // On screen is unknown until the observer's first report, so the loop waits for it.
  if (options.el !== undefined) holds.add('offscreen');
  const offs = [
    host.motion.watch(readMotion),
    host.onVisibility(readHidden),
    options.el === undefined
      ? () => {}
      : host.observe(options.el, (visible) => set('offscreen', !visible)),
  ];
  settle();

  return () => {
    if (stopped) return;
    stopped = true;
    if (frame !== undefined) host.cancel(frame);
    frame = undefined;
    for (const off of offs) off();
  };
}

function browserFrameHost(): FrameHost | null {
  const motion = browserMotionHost();
  if (motion === null || typeof requestAnimationFrame !== 'function') return null;
  return {
    // why: this IS the frame loop every other loop is told to use instead.
    request: (fn) => requestAnimationFrame(fn),
    cancel: (id) => cancelAnimationFrame(id as number),
    now: () => performance.now(),
    hidden: () => document.visibilityState === 'hidden',
    onVisibility(fn) {
      document.addEventListener('visibilitychange', fn);
      return () => document.removeEventListener('visibilitychange', fn);
    },
    motion,
    observe: (el, fn) =>
      inView(
        el,
        () => {
          fn(true);
          return () => fn(false);
        },
        { once: false },
      ),
  };
}
