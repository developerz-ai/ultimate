// Progress tied to scroll — a header that shrinks, a figure that fades in as it crosses the
// viewport — on the browser's own scroll timelines (the engine behind CSS `animation-timeline`),
// never a scroll listener. Where they are missing, or motion is stilled, the element rests.

import { type MotionFrame, toKeyframe } from './animate';
import { motionAllowed, onMotionChange } from './motion-gate';

export interface ScrollLinkedOptions {
  /**
   * `view` (default): progress is the element crossing its scroller's viewport. `scroll`: progress
   * is the page's scroll position.
   */
  readonly source?: 'view' | 'scroll' | undefined;
  readonly axis?: 'block' | 'inline' | undefined;
  /** `[rangeStart, rangeEnd]` in the timeline-range grammar: `['entry 0%', 'cover 50%']`. */
  readonly range?: readonly [string, string] | undefined;
}

type TimelineClass = new (init: Record<string, unknown>) => AnimationTimeline;

/** Animate `frames` along scroll. Returns the stop. */
export function scrollLinked(
  el: Element,
  frames: readonly MotionFrame[],
  options: ScrollLinkedOptions = {},
): () => void {
  const source = options.source ?? 'view';
  const Timeline: TimelineClass | undefined = Reflect.get(
    globalThis,
    source === 'view' ? 'ViewTimeline' : 'ScrollTimeline',
  );
  if (Timeline === undefined || typeof el.animate !== 'function') return () => {};
  const axis = options.axis ?? 'block';
  let running: Animation | undefined;

  const start = (): void => {
    if (running !== undefined || !motionAllowed()) return;
    const timeline = new Timeline(
      source === 'view' ? { subject: el, axis } : { source: document.scrollingElement, axis },
    );
    const settings: Record<string, unknown> = { timeline, fill: 'both', easing: 'linear' };
    if (options.range !== undefined) {
      settings['rangeStart'] = options.range[0];
      settings['rangeEnd'] = options.range[1];
    }
    running = el.animate(frames.map(toKeyframe), settings as KeyframeAnimationOptions);
  };
  const halt = (): void => {
    running?.cancel();
    running = undefined;
  };

  start();
  const off = onMotionChange((allowed) => (allowed ? start() : halt()));
  return () => {
    off();
    halt();
  };
}
