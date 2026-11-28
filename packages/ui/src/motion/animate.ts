// One element, one animation: the browser's own WAAPI with the token scale in front of it. Typed
// transform parts compose into one `transform`; timing is `motionTiming`'s, so a stilled page
// still finishes. No layout property is animatable here — that is `layout()`'s FLIP.

import type { DurationName, EasingName, SpringName } from '../tokens/tokens';
import { motionTiming, STILL_MS } from './motion-timing';

/** A length: a number is pixels, a string is any CSS length (`'0.5rem'`, `'10%'`). */
export type MotionLength = number | string;

/** One keyframe: compositor-friendly properties only. */
export interface MotionFrame {
  readonly x?: MotionLength | undefined;
  readonly y?: MotionLength | undefined;
  readonly scale?: number | undefined;
  /** Per-axis scale, after `scale` — `layout()`'s size inversion. */
  readonly scaleX?: number | undefined;
  readonly scaleY?: number | undefined;
  /** `transform-origin` for this frame: `'0 0'` scales from the top-left corner. */
  readonly origin?: string | undefined;
  /** A number is degrees. */
  readonly rotate?: number | string | undefined;
  readonly opacity?: number | undefined;
  readonly filter?: string | undefined;
  readonly clipPath?: string | undefined;
  /** A keyframe's position, 0..1, when frames are not evenly spaced. */
  readonly offset?: number | undefined;
}

export interface AnimateOptions {
  /** A rung of the duration scale. Default `base`. */
  readonly duration?: DurationName | undefined;
  /** A rung of the easing scale or a spring. Default `out`. */
  readonly easing?: EasingName | SpringName | undefined;
  /** Milliseconds before it starts — `stagger()` computes it. Dropped when motion is stilled. */
  readonly delay?: number | undefined;
  /**
   * `backwards` (default): the first frame holds through the delay and nothing holds after, so the
   * last frame must be the element's resting style. `both` holds the last frame too — an exit
   * whose node is about to be removed.
   */
  readonly fill?: 'backwards' | 'both' | undefined;
}

export interface MotionHandle {
  /** Settles when the animation ends or is cancelled. Never rejects. */
  readonly finished: Promise<void>;
  cancel(): void;
  /** Play back toward the start from wherever it is now — an interrupted enter or exit. */
  reverse(): void;
}

const length = (value: MotionLength): string => (typeof value === 'number' ? `${value}px` : value);

/** A frame as WAAPI takes it: the transform parts composed translate → scale → rotate. */
export function toKeyframe(frame: MotionFrame): Keyframe {
  const parts: string[] = [];
  if (frame.x !== undefined || frame.y !== undefined) {
    parts.push(`translate(${length(frame.x ?? 0)}, ${length(frame.y ?? 0)})`);
  }
  if (frame.scale !== undefined) parts.push(`scale(${frame.scale})`);
  if (frame.scaleX !== undefined || frame.scaleY !== undefined) {
    parts.push(`scale(${frame.scaleX ?? 1}, ${frame.scaleY ?? 1})`);
  }
  if (frame.rotate !== undefined) {
    parts.push(`rotate(${typeof frame.rotate === 'number' ? `${frame.rotate}deg` : frame.rotate})`);
  }
  return {
    ...(parts.length > 0 ? { transform: parts.join(' ') } : {}),
    ...(frame.origin === undefined ? {} : { transformOrigin: frame.origin }),
    ...(frame.opacity === undefined ? {} : { opacity: frame.opacity }),
    ...(frame.filter === undefined ? {} : { filter: frame.filter }),
    ...(frame.clipPath === undefined ? {} : { clipPath: frame.clipPath }),
    ...(frame.offset === undefined ? {} : { offset: frame.offset }),
  };
}

const SETTLED: MotionHandle = Object.freeze({
  finished: Promise.resolve(),
  cancel: () => {},
  reverse: () => {},
});

/** Run `frames` on `el`. Returns `{ finished, cancel, reverse }`. */
export function animate(
  el: Element,
  frames: readonly MotionFrame[],
  options: AnimateOptions = {},
): MotionHandle {
  if (typeof el.animate !== 'function') return SETTLED;
  const timing = motionTiming(options.duration ?? 'base', options.easing ?? 'out');
  const keyframes = frames.map(toKeyframe);
  const settings: KeyframeAnimationOptions = {
    duration: timing.duration,
    easing: timing.easing,
    delay: timing.duration === STILL_MS ? 0 : (options.delay ?? 0),
    fill: options.fill ?? 'backwards',
  };
  let animation: Animation;
  try {
    animation = el.animate(keyframes, settings);
  } catch (error) {
    // An engine without `linear()` refuses a spring's curve with a TypeError; the stylesheet's
    // own fallback is the cubic-bezier spring, and `ease-out` is its nearest built-in.
    if (!(error instanceof TypeError)) throw error;
    animation = el.animate(keyframes, { ...settings, easing: 'ease-out' });
  }
  return {
    finished: animation.finished.then(
      () => undefined,
      () => undefined,
    ),
    cancel: () => animation.cancel(),
    reverse: () => animation.reverse(),
  };
}
