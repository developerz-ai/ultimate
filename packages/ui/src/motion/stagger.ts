// Many elements, one animation, each starting a beat after the last — a list arriving in order.
// The beat is a rung of the duration scale, and the spread is capped so item 40 does not wait
// for 39 beats.

import type { DurationName } from '../tokens/tokens';
import { type AnimateOptions, animate, type MotionFrame, type MotionHandle } from './animate';
import { motionTiming } from './motion-timing';

export interface StaggerOptions extends Omit<AnimateOptions, 'delay'> {
  /** The beat between two starts: a rung of the duration scale. Default `fast`. */
  readonly each?: DurationName | undefined;
  /** Past this many beats every element starts together. Default 8. */
  readonly limit?: number | undefined;
}

const DEFAULT_LIMIT = 8;

/** Animate each element in order; one handle settles when all have, and cancels all. */
export function stagger(
  elements: readonly Element[],
  frames: readonly MotionFrame[],
  options: StaggerOptions = {},
): MotionHandle {
  const beat = motionTiming(options.each ?? 'fast').duration;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const handles = elements.map((el, index) =>
    animate(el, frames, { ...options, delay: Math.min(index, limit) * beat }),
  );
  return {
    finished: Promise.all(handles.map((handle) => handle.finished)).then(() => undefined),
    cancel: () => {
      for (const handle of handles) handle.cancel();
    },
    reverse: () => {
      for (const handle of handles) handle.reverse();
    },
  };
}
