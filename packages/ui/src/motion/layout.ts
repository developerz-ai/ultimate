// A layout change, animated: FLIP over WAAPI. Measure every element (First), let the change land
// (Last), Invert each with a transform, Play to its resting place. Every read precedes every
// write, so a reordered list of fifty forces two layouts, not fifty. Layout properties never
// animate — only `transform`, on the compositor.

import { type AnimateOptions, animate, type MotionFrame, type MotionHandle } from './animate';

export interface LayoutOptions extends Omit<AnimateOptions, 'fill' | 'delay'> {
  /** Also invert a SIZE change. Off by default: scaling distorts text mid-flight. */
  readonly scale?: boolean | undefined;
}

/** The part of a `DOMRect` FLIP reads. */
export interface LayoutBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The frame that puts `last` back where `first` was, or `null` when nothing moved. */
export function invertBox(first: LayoutBox, last: LayoutBox, scale: boolean): MotionFrame | null {
  const x = first.left - last.left;
  const y = first.top - last.top;
  if (!scale) return x === 0 && y === 0 ? null : { x, y };
  if (last.width === 0 || last.height === 0) return null;
  const scaleX = first.width / last.width;
  const scaleY = first.height / last.height;
  if (x === 0 && y === 0 && scaleX === 1 && scaleY === 1) return null;
  return { x, y, scaleX, scaleY, origin: '0 0' };
}

const rest = (frame: MotionFrame): MotionFrame =>
  frame.scaleX === undefined ? { x: 0, y: 0 } : { x: 0, y: 0, scaleX: 1, scaleY: 1, origin: '0 0' };

/**
 * Run `change` — a signal write, a node move; synchronous — and animate every element in
 * `elements` from where it was to where it landed. An element the change added has no First and
 * simply appears. Returns one handle over every animation.
 */
export function layout(
  elements: readonly Element[],
  change: () => void,
  options: LayoutOptions = {},
): MotionHandle {
  const first = elements.map((el) => el.getBoundingClientRect());
  change();
  const last = elements.map((el) => el.getBoundingClientRect());
  const handles: MotionHandle[] = [];
  elements.forEach((el, index) => {
    const from = invertBox(
      first[index] as LayoutBox,
      last[index] as LayoutBox,
      options.scale === true,
    );
    if (from !== null) handles.push(animate(el, [from, rest(from)], options));
  });
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
