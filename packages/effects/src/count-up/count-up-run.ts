// The island half of CountUp: tween the text from `from` to the final value on the host's frame
// loop. Takes the host so a test drives frames by hand; the browser's is `browserHost()`.

import type { EffectHost } from '../effect-host';
import { countFrame } from './count-up-view';

/** The longest one frame may advance the tween: a stopped-and-resumed loop does not jump. */
const MAX_STEP_MS = 100;

export interface CountRun {
  readonly from: number;
  readonly to: number;
  readonly ms: number;
  readonly format: (scalar: number) => string;
}

export interface CountNode {
  textContent: string | null;
}

/**
 * Returns the cleanup. Under reduced motion or `ms: 0` nothing runs and the server's final text
 * stays. The loop stops itself offscreen, hidden and paused (the port's job); the cleanup always
 * leaves the exact final text, so a stopped tween never strands a half-way figure.
 */
export function runCountUp(
  node: CountNode,
  el: Element,
  run: CountRun,
  host: EffectHost,
): () => void {
  if (run.ms === 0 || !host.motion.allowed()) return () => {};
  node.textContent = run.format(run.from);
  // The clock starts on the first tick, not at mount: a counter below the fold is not frameLoop's
  // to run until it scrolls in, and a clock started earlier would have spent the whole tween.
  let elapsed = 0;
  let last: number | undefined;
  let stop: (() => void) | undefined;
  const finish = (): void => {
    stop?.();
    node.textContent = run.format(run.to);
  };
  stop = host.motion.loop(() => {
    const now = host.now();
    // Accumulated, capped per frame: time spent paused or offscreen is not time spent counting.
    elapsed += last === undefined ? 0 : Math.min(now - last, MAX_STEP_MS);
    last = now;
    node.textContent = run.format(countFrame(run.from, run.to, elapsed, run.ms));
    if (elapsed >= run.ms) stop?.();
  }, el);
  // A pause (MotionToggle, reduced motion) stops the loop where it stands; the figure must not.
  const unsubscribe = host.motion.onChange(() => {
    if (!host.motion.allowed()) finish();
  });
  return () => {
    unsubscribe();
    finish();
  };
}
