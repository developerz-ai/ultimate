// The island half of CountUp: tween the text from `from` to the final value on the host's frame
// loop. Takes the host so a test drives frames by hand; the browser's is `browserHost()`.

import type { EffectHost } from '../effect-host';
import { countFrame } from './count-up-view';

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
  const start = host.now();
  node.textContent = run.format(run.from);
  let stop: (() => void) | undefined;
  stop = host.motion.loop(() => {
    const elapsed = host.now() - start;
    node.textContent = run.format(countFrame(run.from, run.to, elapsed, run.ms));
    if (elapsed >= run.ms) stop?.();
  }, el);
  return () => {
    stop?.();
    node.textContent = run.format(run.to);
  };
}
